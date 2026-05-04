/**
 * MEV Arbitrage Transaction Crawler — BNB Chain (BSC)
 *
 * 数据源: eth_getBlockReceipts 链上扫描 — 从区块收据中识别多跳套利交易
 * 输出: OSS bsc/data.json
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";

// ---------- 配置 ----------

const RPC_URL =
  process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com";

const OUTPUT_FILE = path.join("public", "bsc-data.json");
const SCAN_BLOCKS = 5;

// PancakeSwap / Uniswap fork Swap event topic0 (same as Uniswap)
const V2_SWAP =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const ERC20_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFI_LLAMA_PRICE_API = "https://coins.llama.fi/prices/current";
const PRICE_PREFIX = "bsc";

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

const STABLECOIN_FALLBACK = {
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { price: 1, decimals: 18, symbol: "USDC" },
  "0x55d398326f99059ff775485246999027b3197955": { price: 1, decimals: 18, symbol: "USDT" },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { price: 1, decimals: 18, symbol: "BUSD" },
};

const log = (msg) => console.log(msg);

// ---------- Aliyun OSS ----------

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const OSS_KEY = "bsc/data.json";

async function uploadToOSS(filePath) {
  try {
    const result = await ossClient.put(OSS_KEY, filePath, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=10",
      },
    });
    log(`  ✓ 已上传到 OSS: ${result.url}`);
  } catch (e) {
    log(`  [!] OSS 上传失败: ${e.message}`);
  }
}

// ---------- RPC ----------

function makeProvider() {
  const req = new ethers.FetchRequest(RPC_URL);
  req.timeout = 20_000;
  return new ethers.JsonRpcProvider(req, 56, {
    staticNetwork: ethers.Network.from(56),
  });
}

// ---------- 链上扫描 ----------

function topicToAddr(topic) {
  return "0x" + topic.slice(-40).toLowerCase();
}

function analyzeReceipts(receipts, blockNumber) {
  const txMap = new Map();

  for (const receipt of receipts) {
    const txHash = receipt.transactionHash;

    for (const logEntry of receipt.logs ?? []) {
      const topic0 = logEntry.topics?.[0];

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
          dex: topic0 === V2_SWAP ? "PancakeSwap V2" : "PancakeSwap V3",
          pool: logEntry.address,
        });
      }

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
          const direction = toIsBot ? 1n : -1n;

          txMap.get(txHash).transfers.push({
            token: tokenAddr,
            amount: rawAmount * direction,
          });
        }
      }
    }
  }

  const arbTxs = [];
  for (const [txHash, info] of txMap) {
    if (info.swaps.length < 2) continue;
    if (info.status === "0x0") continue;

    const gasPrice = info.effectiveGasPrice;
    const gasCostWei = BigInt(info.gasUsed) * gasPrice;

    const tokenFlows = new Map();
    for (const t of info.transfers) {
      const prev = tokenFlows.get(t.token) ?? 0n;
      tokenFlows.set(t.token, prev + t.amount);
    }

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
      etherscan_url: `https://bscscan.com/tx/${txHash}`,
      eigenphi_url: `https://eigenphi.io/mev/eigentx/${txHash}?chain=bsc`,
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
    const ids = batch.map((a) => `${PRICE_PREFIX}:${a}`).join(",");
    try {
      const resp = await fetch(`${DEFI_LLAMA_PRICE_API}/${ids}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      for (const [key, info] of Object.entries(data.coins ?? {})) {
        const addr = key.replace(`${PRICE_PREFIX}:`, "").toLowerCase();
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

  for (const [addr, info] of Object.entries(STABLECOIN_FALLBACK)) {
    if (!prices[addr]) prices[addr] = info;
  }

  return prices;
}

function computePnl(arbTxs, prices) {
  const nativePrice = prices[WBNB]?.price ?? 0;

  for (const tx of arbTxs) {
    const flows = tx.net_token_flows ?? {};
    const entries = Object.entries(flows);

    if (entries.length === 0) {
      tx.revenue_usd = null;
      tx.gas_cost_usd = nativePrice > 0 ? Math.round(tx.gas_cost_eth * nativePrice * 100) / 100 : null;
      tx.pnl_usd = null;
      tx.profit_token = null;
      tx.profit_token_amount = null;
      tx.native_price_usd = nativePrice;
      continue;
    }

    const hasAnyInflow = entries.some(([, rawStr]) => BigInt(rawStr) > 0n);

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

    const gasCostUsd = tx.gas_cost_eth * nativePrice;

    if (!hasAnyInflow) {
      tx.revenue_usd = null;
      tx.gas_cost_usd = nativePrice > 0 ? Math.round(gasCostUsd * 100) / 100 : null;
      tx.pnl_usd = null;
      tx.profit_token = null;
      tx.profit_token_amount = null;
      tx.native_price_usd = nativePrice;
      continue;
    }

    const pnlUsd = revenueUsd - gasCostUsd;

    tx.revenue_usd = hasPriceData ? Math.round(revenueUsd * 100) / 100 : null;
    tx.gas_cost_usd = nativePrice > 0 ? Math.round(gasCostUsd * 100) / 100 : null;
    tx.pnl_usd = hasPriceData && nativePrice > 0 ? Math.round(pnlUsd * 100) / 100 : null;
    tx.profit_token = profitToken;
    tx.profit_token_amount =
      profitTokenAmount !== 0 ? Math.round(profitTokenAmount * 1e8) / 1e8 : null;
    tx.native_price_usd = nativePrice;
  }
}

// ---------- main ----------

const WATCH_INTERVAL = 5_000;

async function saveOutput(output) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  await uploadToOSS(OUTPUT_FILE);
}

async function main() {
  const isWatch = process.argv.includes("--watch");

  log("=".repeat(55));
  log(`  MEV Arbitrage Crawler — BSC${isWatch ? " (watch mode)" : ""}`);
  log("=".repeat(55));

  const provider = makeProvider();
  const bn = await provider.getBlockNumber();
  log(`  RPC 已连接, 当前区块: ${bn}`);

  if (!isWatch) {
    log("\n[1/2] 链上扫描最近区块...");
    let arbTxs = await scanBlocks(provider, SCAN_BLOCKS);
    log(`  ✓ ${arbTxs.length} 笔套利交易`);
    arbTxs.sort((a, b) => b.swap_count - a.swap_count);

    log("\n[2/2] 查询价格 & 计算 PnL...");
    const allTokens = new Set([WBNB]);
    for (const tx of arbTxs) {
      for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
    }
    const prices = await fetchTokenPrices([...allTokens]);
    computePnl(arbTxs, prices);

    const pnlTxs = arbTxs.filter((t) => t.pnl_usd !== null);
    const totalPnl = pnlTxs.reduce((s, t) => s + t.pnl_usd, 0);
    log(`  ✓ ${pnlTxs.length} 笔有 PnL, 总计 $${totalPnl.toFixed(2)}`);

    await saveOutput({
      updated_at: new Date().toISOString(),
      chain: "bsc",
      scan_blocks: SCAN_BLOCKS,
      total_arbitrage_txs: arbTxs.length,
      relay_blocks: [],
      transactions: arbTxs,
    });

    log(`\n  已保存 → ${OUTPUT_FILE} & OSS`);
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

      if (newArbs.length > 0) {
        const allTokens = new Set([WBNB]);
        for (const tx of newArbs) {
          for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
        }
        const prices = await fetchTokenPrices([...allTokens]);
        computePnl(newArbs, prices);
      }

      const seen = new Set();
      const merged = [];
      for (const tx of [...newArbs, ...allTxs]) {
        if (seen.has(tx.tx_hash)) continue;
        seen.add(tx.tx_hash);
        merged.push(tx);
        if (merged.length >= MAX_TXS) break;
      }
      allTxs = merged;

      await saveOutput({
        updated_at: new Date().toISOString(),
        chain: "bsc",
        scan_blocks: blocksToScan,
        total_arbitrage_txs: allTxs.length,
        relay_blocks: [],
        transactions: allTxs,
      });

      const newCount = newArbs.length;
      log(`  ✓ +${newCount} 新交易, 累计 ${allTxs.length} 笔`);
      lastBlock = currentBlock;
    } catch (e) {
      log(`  [!] tick 错误: ${e.message?.slice(0, 80)}`);
    }
  }

  await tick();

  log(`\n  进入 watch 模式, 每 ${WATCH_INTERVAL / 1000}s 检查新区块...`);
  log("  按 Ctrl+C 退出\n");
  setInterval(tick, WATCH_INTERVAL);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
