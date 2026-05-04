/**
 * MEV Arbitrage Transaction Crawler
 *
 * 数据源:
 *   1. Flashbots MEV-Boost Relay API — 高 MEV 价值区块信息
 *   2. eth_getBlockReceipts 链上扫描 — 从区块收据中识别多跳套利交易
 *
 * 输出: public/data.json
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";

// ---------- 配置 ----------

const RELAY_API =
  "https://boost-relay.flashbots.net/relay/v1/data/bidtraces/proposer_payload_delivered";

const RPC_URL =
  process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";

const OUTPUT_FILE = path.join("public", "data.json");
const SCAN_BLOCKS = 5;

// Uniswap Swap event topic0
const V2_SWAP =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

// ERC-20 Transfer(address,address,uint256)
const ERC20_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFI_LLAMA_PRICE_API = "https://coins.llama.fi/prices/current";

// Stablecoin fallback prices (if API fails)
const STABLECOIN_FALLBACK = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { price: 1, decimals: 6, symbol: "USDC" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { price: 1, decimals: 6, symbol: "USDT" },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { price: 1, decimals: 18, symbol: "DAI" },
};

const log = (msg) => console.log(msg);

// ---------- RPC ----------

function makeProvider() {
  const req = new ethers.FetchRequest(RPC_URL);
  req.timeout = 20_000;
  return new ethers.JsonRpcProvider(req, 1, {
    staticNetwork: ethers.Network.from("mainnet"),
  });
}

// ---------- 数据源 1: Relay API ----------

async function fetchRelayBlocks(limit = 30) {
  try {
    const resp = await fetch(`${RELAY_API}?limit=${limit}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const items = await resp.json();
    return items.map((item) => ({
      slot: Number(item.slot),
      block_number: Number(item.block_number),
      block_hash: item.block_hash,
      value_eth: parseFloat(ethers.formatEther(item.value)),
      proposer_fee_recipient: item.proposer_fee_recipient,
    }));
  } catch (e) {
    log(`  [!] Relay API 失败: ${e.message}`);
    return [];
  }
}

// ---------- 数据源 2: 链上扫描 ----------

function topicToAddr(topic) {
  return "0x" + topic.slice(-40).toLowerCase();
}

function analyzeReceipts(receipts, blockNumber) {
  const txMap = new Map();

  for (const receipt of receipts) {
    const txHash = receipt.transactionHash;

    for (const logEntry of receipt.logs ?? []) {
      const topic0 = logEntry.topics?.[0];

      // Collect Swap events
      if (topic0 === V2_SWAP || topic0 === V3_SWAP) {
        if (!txMap.has(txHash)) {
          txMap.set(txHash, {
            swaps: [],
            transfers: [],
            from: receipt.from,
            to: receipt.to,
            gasUsed: parseInt(receipt.gasUsed, 16),
            effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0"),
            status: receipt.status,
          });
        }
        txMap.get(txHash).swaps.push({
          dex: topic0 === V2_SWAP ? "Uniswap V2" : "Uniswap V3",
          pool: logEntry.address,
        });
      }

      // Collect ERC-20 Transfer events
      if (
        topic0 === ERC20_TRANSFER &&
        logEntry.topics?.length === 3 &&
        logEntry.data
      ) {
        const from = topicToAddr(logEntry.topics[1]);
        const to = topicToAddr(logEntry.topics[2]);
        const botAddrs = new Set(
          [receipt.from, receipt.to]
            .filter(Boolean)
            .map((a) => a.toLowerCase())
        );

        // Only track flows between the bot system and external addresses
        const fromIsBot = botAddrs.has(from);
        const toIsBot = botAddrs.has(to);
        if (fromIsBot !== toIsBot) {
          if (!txMap.has(txHash)) {
            txMap.set(txHash, {
              swaps: [],
              transfers: [],
              from: receipt.from,
              to: receipt.to,
              gasUsed: parseInt(receipt.gasUsed, 16),
              effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0"),
              status: receipt.status,
            });
          }
          const rawAmount = BigInt(logEntry.data);
          const tokenAddr = logEntry.address.toLowerCase();
          // Inflow to bot system = positive, outflow = negative
          const direction = toIsBot ? 1n : -1n;

          txMap.get(txHash).transfers.push({
            token: tokenAddr,
            amount: rawAmount * direction,
          });
        }
      }
    }
  }

  // ≥2 Swap = 套利
  const arbTxs = [];
  for (const [txHash, info] of txMap) {
    if (info.swaps.length < 2) continue;
    if (info.status === "0x0") continue;

    const gasPrice = info.effectiveGasPrice;
    const gasCostWei = BigInt(info.gasUsed) * gasPrice;

    // Net token flows for the bot address
    const tokenFlows = new Map();
    for (const t of info.transfers) {
      const prev = tokenFlows.get(t.token) ?? 0n;
      tokenFlows.set(t.token, prev + t.amount);
    }

    // Convert to serialisable format: { tokenAddr: netAmountRaw (string) }
    const netTokenFlows = {};
    for (const [token, amount] of tokenFlows) {
      if (amount !== 0n) {
        netTokenFlows[token] = amount.toString();
      }
    }

    arbTxs.push({
      tx_hash: txHash,
      block_number: blockNumber,
      source: "onchain_scan",
      type: "arbitrage",
      swap_count: info.swaps.length,
      dex_list: [...new Set(info.swaps.map((s) => s.dex))].sort(),
      pools: info.swaps.map((s) => s.pool),
      gas_used: info.gasUsed,
      gas_price_gwei:
        Math.round(Number(gasPrice / BigInt(1e5)) / 1e4 * 1e4) / 1e4,
      gas_cost_eth: parseFloat(ethers.formatEther(gasCostWei)),
      from_address: info.from ?? "",
      to_address: info.to ?? "",
      net_token_flows: netTokenFlows,
      etherscan_url: `https://etherscan.io/tx/${txHash}`,
      eigenphi_url: `https://eigenphi.io/mev/eigentx/${txHash}`,
    });
  }

  return arbTxs;
}

async function scanBlocks(provider, numBlocks = SCAN_BLOCKS) {
  const latest = await provider.getBlockNumber();
  const allArb = [];

  for (let i = 0; i < numBlocks; i++) {
    const bn = latest - i;
    const hex = "0x" + bn.toString(16);
    log(`  扫描区块 ${bn}...`);

    try {
      const receipts = await provider.send("eth_getBlockReceipts", [hex]);
      if (!receipts) {
        log(`    跳过 (无数据)`);
        continue;
      }
      const arbs = analyzeReceipts(receipts, bn);
      log(`    ${receipts.length} 笔交易, ${arbs.length} 笔套利`);
      allArb.push(...arbs);
    } catch (e) {
      log(`    [!] 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  return allArb;
}

// ---------- 价格查询 & PnL 计算 ----------

async function fetchTokenPrices(tokenAddrs) {
  if (tokenAddrs.length === 0) return {};

  const BATCH = 30;
  const prices = {};

  for (let i = 0; i < tokenAddrs.length; i += BATCH) {
    const batch = tokenAddrs.slice(i, i + BATCH);
    const ids = batch.map((a) => `ethereum:${a}`).join(",");
    try {
      const resp = await fetch(`${DEFI_LLAMA_PRICE_API}/${ids}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      for (const [key, info] of Object.entries(data.coins ?? {})) {
        const addr = key.replace("ethereum:", "").toLowerCase();
        prices[addr] = {
          price: info.price,
          decimals: info.decimals,
          symbol: info.symbol,
        };
      }
    } catch (e) {
      log(`  [!] DeFi Llama 批次请求失败: ${e.message}`);
    }
  }

  // Stablecoin fallback
  for (const [addr, info] of Object.entries(STABLECOIN_FALLBACK)) {
    if (!prices[addr]) prices[addr] = info;
  }

  return prices;
}

function computePnl(arbTxs, prices) {
  const ethAddr = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const ethPrice = prices[ethAddr]?.price ?? 0;

  for (const tx of arbTxs) {
    const flows = tx.net_token_flows ?? {};
    const entries = Object.entries(flows);

    if (entries.length === 0) {
      tx.revenue_usd = null;
      tx.gas_cost_usd = ethPrice > 0 ? Math.round(tx.gas_cost_eth * ethPrice * 100) / 100 : null;
      tx.pnl_usd = null;
      tx.profit_token = null;
      tx.profit_token_amount = null;
      tx.eth_price_usd = ethPrice;
      continue;
    }

    // Check if all flows are outflows (negative) — means profit is native ETH
    const hasAnyInflow = entries.some(([token, rawStr]) => {
      const raw = BigInt(rawStr);
      return raw > 0n;
    });

    let revenueUsd = 0;
    let profitToken = null;
    let profitTokenAmount = 0;
    let maxUsdFlow = 0;
    let hasPriceData = false;

    for (const [token, rawStr] of entries) {
      const raw = BigInt(rawStr);
      const info = prices[token];
      if (!info) continue;

      hasPriceData = true;
      const amount = Number(raw) / 10 ** info.decimals;
      const usdValue = amount * info.price;
      revenueUsd += usdValue;

      if (usdValue > maxUsdFlow) {
        maxUsdFlow = usdValue;
        profitToken = info.symbol;
        profitTokenAmount = amount;
      }
    }

    const gasCostUsd = tx.gas_cost_eth * ethPrice;

    // If all flows are outflows, profit is likely native ETH — can't compute
    if (!hasAnyInflow) {
      tx.revenue_usd = null;
      tx.gas_cost_usd = ethPrice > 0 ? Math.round(gasCostUsd * 100) / 100 : null;
      tx.pnl_usd = null;
      tx.profit_token = null;
      tx.profit_token_amount = null;
      tx.eth_price_usd = ethPrice;
      continue;
    }

    const pnlUsd = revenueUsd - gasCostUsd;

    tx.revenue_usd = hasPriceData ? Math.round(revenueUsd * 100) / 100 : null;
    tx.gas_cost_usd = ethPrice > 0 ? Math.round(gasCostUsd * 100) / 100 : null;
    tx.pnl_usd = hasPriceData && ethPrice > 0 ? Math.round(pnlUsd * 100) / 100 : null;
    tx.profit_token = profitToken;
    tx.profit_token_amount =
      profitTokenAmount !== 0
        ? Math.round(profitTokenAmount * 1e8) / 1e8
        : null;
    tx.eth_price_usd = ethPrice;
  }
}

// ---------- main ----------

const WEB_OUTPUT = path.join("web", "public", "data.json");
const WATCH_INTERVAL = 12_000;

function saveOutput(output) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  // Also write to web/public for the Next.js frontend
  fs.mkdirSync(path.join("web", "public"), { recursive: true });
  fs.writeFileSync(WEB_OUTPUT, JSON.stringify(output, null, 2), "utf-8");
}

async function runOnce(provider) {
  const relayBlocks = await fetchRelayBlocks(30);
  const arbTxs = await scanBlocks(provider, SCAN_BLOCKS);
  arbTxs.sort((a, b) => b.swap_count - a.swap_count);

  const allTokens = new Set();
  allTokens.add("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  for (const tx of arbTxs) {
    for (const token of Object.keys(tx.net_token_flows ?? {})) {
      allTokens.add(token);
    }
  }
  const prices = await fetchTokenPrices([...allTokens]);
  computePnl(arbTxs, prices);

  return { relayBlocks, arbTxs };
}

async function main() {
  const isWatch = process.argv.includes("--watch");

  log("=".repeat(55));
  log(`  MEV Arbitrage Crawler${isWatch ? " (watch mode)" : ""}`);
  log("=".repeat(55));

  const provider = makeProvider();
  const bn = await provider.getBlockNumber();
  log(`  RPC 已连接, 当前区块: ${bn}`);

  if (!isWatch) {
    // ---- 单次运行 ----
    log("\n[1/3] 从 Flashbots Relay 获取高价值 MEV 区块...");
    const relayBlocks = await fetchRelayBlocks(30);
    log(`  ✓ ${relayBlocks.length} 个区块`);

    log("\n[2/3] 链上扫描最近区块...");
    let arbTxs = await scanBlocks(provider, SCAN_BLOCKS);
    log(`  ✓ ${arbTxs.length} 笔套利交易`);
    arbTxs.sort((a, b) => b.swap_count - a.swap_count);

    log("\n[3/3] 查询价格 & 计算 PnL...");
    const allTokens = new Set(["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]);
    for (const tx of arbTxs) {
      for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
    }
    const prices = await fetchTokenPrices([...allTokens]);
    computePnl(arbTxs, prices);

    const pnlTxs = arbTxs.filter((t) => t.pnl_usd !== null);
    const totalPnl = pnlTxs.reduce((s, t) => s + t.pnl_usd, 0);
    log(`  ✓ ${pnlTxs.length} 笔有 PnL, 总计 $${totalPnl.toFixed(2)}`);

    saveOutput({
      updated_at: new Date().toISOString(),
      scan_blocks: SCAN_BLOCKS,
      total_arbitrage_txs: arbTxs.length,
      relay_blocks: relayBlocks.slice(0, 15),
      transactions: arbTxs,
    });

    log(`\n  已保存 → ${OUTPUT_FILE} & ${WEB_OUTPUT}`);
    return;
  }

  // ---- Watch 模式 ----
  let lastBlock = 0;
  let allTxs = [];
  const MAX_TXS = 200;

  async function tick() {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) return;

      const blocksToScan = lastBlock === 0
        ? SCAN_BLOCKS
        : Math.min(currentBlock - lastBlock, 10);

      const ts = new Date().toLocaleTimeString();
      log(`\n[${ts}] 新区块 ${currentBlock} (扫描 ${blocksToScan} 个)...`);

      const relayBlocks = await fetchRelayBlocks(15);

      // Scan only the new blocks
      const newArbs = [];
      for (let i = 0; i < blocksToScan; i++) {
        const blockNum = currentBlock - i;
        const hex = "0x" + blockNum.toString(16);
        try {
          const receipts = await provider.send("eth_getBlockReceipts", [hex]);
          if (!receipts) continue;
          const arbs = analyzeReceipts(receipts, blockNum);
          if (arbs.length > 0) {
            log(`  区块 ${blockNum}: ${arbs.length} 笔套利`);
          }
          newArbs.push(...arbs);
        } catch (e) {
          log(`  [!] 区块 ${blockNum}: ${e.message?.slice(0, 60)}`);
        }
      }

      // Price & PnL
      if (newArbs.length > 0) {
        const allTokens = new Set(["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]);
        for (const tx of newArbs) {
          for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
        }
        const prices = await fetchTokenPrices([...allTokens]);
        computePnl(newArbs, prices);
      }

      // Merge: prepend new, deduplicate, cap at MAX_TXS
      const seen = new Set();
      const merged = [];
      for (const tx of [...newArbs, ...allTxs]) {
        if (seen.has(tx.tx_hash)) continue;
        seen.add(tx.tx_hash);
        merged.push(tx);
        if (merged.length >= MAX_TXS) break;
      }
      allTxs = merged;

      saveOutput({
        updated_at: new Date().toISOString(),
        scan_blocks: blocksToScan,
        total_arbitrage_txs: allTxs.length,
        relay_blocks: relayBlocks.slice(0, 15),
        transactions: allTxs,
      });

      const newCount = newArbs.length;
      log(`  ✓ +${newCount} 新交易, 累计 ${allTxs.length} 笔`);
      lastBlock = currentBlock;
    } catch (e) {
      log(`  [!] tick 错误: ${e.message?.slice(0, 80)}`);
    }
  }

  // Initial run
  await tick();

  // Loop
  log(`\n  进入 watch 模式, 每 ${WATCH_INTERVAL / 1000}s 检查新区块...`);
  log("  按 Ctrl+C 退出\n");
  setInterval(tick, WATCH_INTERVAL);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
