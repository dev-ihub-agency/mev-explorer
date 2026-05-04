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
import OSS from "ali-oss";

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

// ---------- Aliyun OSS ----------

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const OSS_KEY = process.env.OSS_DATA_KEY || "eth/data.json";
const OSS_HISTORY_KEY = OSS_KEY.replace("data.json", "sandwich-history.json");
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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

async function appendSandwichHistory(newSandwiches) {
  if (!newSandwiches || newSandwiches.length === 0) return;
  try {
    let existing = [];
    try {
      const res = await ossClient.get(OSS_HISTORY_KEY);
      existing = JSON.parse(res.content.toString());
    } catch { }
    const seenTx = new Set(existing.map(s => s.entry_tx?.tx_hash));
    const toAdd = newSandwiches.filter(s => s.block_timestamp && !seenTx.has(s.entry_tx?.tx_hash));
    if (toAdd.length === 0) return;
    const merged = [...existing, ...toAdd];
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    const trimmed = merged.filter(s => new Date(s.block_timestamp).getTime() > cutoff);
    const buf = Buffer.from(JSON.stringify(trimmed), "utf-8");
    await ossClient.put(OSS_HISTORY_KEY, buf, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
    });
    log(`  ✓ 历史记录: +${toAdd.length}, 总计 ${trimmed.length} 条`);
  } catch (e) {
    log(`  [!] 历史记录更新失败: ${e.message}`);
  }
}

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

function detectSandwiches(receipts, blockNumber) {
  const swapRecords = [];

  for (const receipt of receipts) {
    const txHash = receipt.transactionHash;
    const txIndex = parseInt(receipt.transactionIndex, 16);
    const from = (receipt.from ?? "").toLowerCase();
    const logs = receipt.logs ?? [];

    const swapLogs = logs.filter(
      (l) => l.topics?.[0] === V2_SWAP || l.topics?.[0] === V3_SWAP
    );
    if (swapLogs.length === 0) continue;

    const transferLogs = logs.filter(
      (l) =>
        l.topics?.[0] === ERC20_TRANSFER &&
        l.topics?.length === 3 &&
        l.data
    );

    for (const swapLog of swapLogs) {
      const pool = swapLog.address.toLowerCase();
      const dex = swapLog.topics[0] === V2_SWAP ? "Uniswap V2" : "Uniswap V3";

      let tokenIn = null, amountIn = null, tokenOut = null, amountOut = null;

      for (const tLog of transferLogs) {
        const tFrom = topicToAddr(tLog.topics[1]);
        const tTo = topicToAddr(tLog.topics[2]);
        const amount = BigInt(tLog.data).toString();
        const token = tLog.address.toLowerCase();

        if (tTo === pool) {
          tokenIn = token;
          amountIn = amount;
        } else if (tFrom === pool) {
          tokenOut = token;
          amountOut = amount;
        }
      }

      if (!tokenIn || !tokenOut) continue;

      const direction = pool + tokenIn;
      swapRecords.push({ txIndex, txHash, from, pool, dex, tokenIn, amountIn, tokenOut, amountOut, direction });
    }
  }

  const poolGroups = new Map();
  for (const rec of swapRecords) {
    if (!poolGroups.has(rec.pool)) poolGroups.set(rec.pool, []);
    poolGroups.get(rec.pool).push(rec);
  }

  const sandwiches = [];

  for (const [poolAddr, swaps] of poolGroups) {
    swaps.sort((a, b) => a.txIndex - b.txIndex);

    const used = new Set();
    for (let i = 0; i < swaps.length; i++) {
      if (used.has(i)) continue;
      const entry = swaps[i];

      for (let j = i + 1; j < swaps.length; j++) {
        if (used.has(j)) continue;
        const exit = swaps[j];
        if (exit.from !== entry.from) continue;

        const oppositeDir = poolAddr + entry.tokenOut;
        if (exit.direction !== oppositeDir) continue;

        const victims = [];
        for (let k = i + 1; k < j; k++) {
          if (swaps[k].from !== entry.from && swaps[k].direction === entry.direction) {
            victims.push(swaps[k]);
          }
        }

        if (victims.length === 0) continue;

        const dexName = entry.dex;
        sandwiches.push({
          type: "sandwich",
          block_number: blockNumber,
          bot_address: entry.from,
          pool: poolAddr,
          dex: dexName,
          entry_tx: {
            tx_hash: entry.txHash,
            token_in: entry.tokenIn,
            amount_in: entry.amountIn,
            token_out: entry.tokenOut,
            amount_out: entry.amountOut,
          },
          exit_tx: {
            tx_hash: exit.txHash,
            token_in: exit.tokenIn,
            amount_in: exit.amountIn,
            token_out: exit.tokenOut,
            amount_out: exit.amountOut,
          },
          victims: victims.map((v) => ({
            tx_hash: v.txHash,
            from_address: v.from,
            token_in: v.tokenIn,
            amount_in: v.amountIn,
            token_out: v.tokenOut,
            amount_out: v.amountOut,
          })),
          bot_profit_usd: null,
          explorer_base: "https://etherscan.io",
        });

        used.add(i);
        used.add(j);
        break;
      }
    }
  }

  return sandwiches;
}

function enrichSandwiches(sandwiches, prices) {
  for (const sw of sandwiches) {
    const entryIn = sw.entry_tx.token_in;
    const entryOut = sw.entry_tx.token_out;
    const exitIn = sw.exit_tx.token_in;
    const exitOut = sw.exit_tx.token_out;

    if (prices[entryIn]) {
      sw.entry_tx.token_in_symbol = prices[entryIn].symbol;
      sw.entry_tx.amount_in_formatted = (Number(BigInt(sw.entry_tx.amount_in)) / 10 ** prices[entryIn].decimals).toFixed(6);
    }
    if (prices[entryOut]) {
      sw.entry_tx.token_out_symbol = prices[entryOut].symbol;
      sw.entry_tx.amount_out_formatted = (Number(BigInt(sw.entry_tx.amount_out)) / 10 ** prices[entryOut].decimals).toFixed(6);
    }
    if (prices[exitIn]) {
      sw.exit_tx.token_in_symbol = prices[exitIn].symbol;
      sw.exit_tx.amount_in_formatted = (Number(BigInt(sw.exit_tx.amount_in)) / 10 ** prices[exitIn].decimals).toFixed(6);
    }
    if (prices[exitOut]) {
      sw.exit_tx.token_out_symbol = prices[exitOut].symbol;
      sw.exit_tx.amount_out_formatted = (Number(BigInt(sw.exit_tx.amount_out)) / 10 ** prices[exitOut].decimals).toFixed(6);
    }

    for (const v of sw.victims) {
      if (prices[v.token_in]) {
        v.token_in_symbol = prices[v.token_in].symbol;
        v.amount_in_formatted = (Number(BigInt(v.amount_in)) / 10 ** prices[v.token_in].decimals).toFixed(6);
      }
      if (prices[v.token_out]) {
        v.token_out_symbol = prices[v.token_out].symbol;
        v.amount_out_formatted = (Number(BigInt(v.amount_out)) / 10 ** prices[v.token_out].decimals).toFixed(6);
      }
    }

    const profitToken = entryIn;
    const profitInfo = prices[profitToken];
    if (!profitInfo) continue;

    const netRaw = BigInt(sw.exit_tx.amount_out) - BigInt(sw.entry_tx.amount_in);
    const netAmount = Number(netRaw) / 10 ** profitInfo.decimals;
    sw.bot_profit_amount = Math.abs(netAmount).toFixed(6);
    sw.bot_profit_token = profitInfo.symbol;
    sw.bot_profit_usd = Math.round(netAmount * profitInfo.price * 100) / 100;
  }
}

// ---------- ENS 反查 ----------

const ensCache = new Map();

async function resolveEns(provider, addresses) {
  const unique = [...new Set(addresses)].filter((a) => a && !ensCache.has(a.toLowerCase()));
  for (const addr of unique) {
    try {
      const name = await provider.lookupAddress(addr);
      ensCache.set(addr.toLowerCase(), name || null);
    } catch {
      ensCache.set(addr.toLowerCase(), null);
    }
  }
  return (addr) => ensCache.get(addr?.toLowerCase()) || null;
}

async function filterOutEnsBots(provider, sandwiches) {
  const botAddrs = [...new Set(sandwiches.map((sw) => sw.bot_address))];
  if (botAddrs.length === 0) return sandwiches;
  log(`  ENS 反查 ${botAddrs.length} 个 bot 地址...`);
  const lookup = await resolveEns(provider, botAddrs);
  const before = sandwiches.length;
  const filtered = sandwiches.filter((sw) => !lookup(sw.bot_address));
  const removed = before - filtered.length;
  if (removed > 0) log(`  ✓ 过滤掉 ${removed} 笔 ENS bot 交易`);
  return filtered;
}

async function scanBlocks(provider, numBlocks = SCAN_BLOCKS) {
  const latest = await provider.getBlockNumber();
  const allArb = [];
  const allSandwich = [];

  for (let i = 0; i < numBlocks; i++) {
    const bn = latest - i;
    const hex = "0x" + bn.toString(16);
    log(`  扫描区块 ${bn}...`);

    try {
      const [receipts, block] = await Promise.all([
        provider.send("eth_getBlockReceipts", [hex]),
        provider.send("eth_getBlockByNumber", [hex, false]),
      ]);
      if (!receipts) {
        log(`    跳过 (无数据)`);
        continue;
      }
      const blockTimestamp = block?.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : null;
      const arbs = analyzeReceipts(receipts, bn);
      const sws = detectSandwiches(receipts, bn);
      for (const sw of sws) sw.block_timestamp = blockTimestamp;
      log(`    ${receipts.length} 笔交易, ${arbs.length} 笔套利, ${sws.length} 笔三明治`);
      allArb.push(...arbs);
      allSandwich.push(...sws);
    } catch (e) {
      log(`    [!] 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  return { arbs: allArb, sandwiches: allSandwich };
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

async function saveOutput(output) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  fs.mkdirSync(path.join("web", "public"), { recursive: true });
  fs.writeFileSync(WEB_OUTPUT, JSON.stringify(output, null, 2), "utf-8");
  await uploadToOSS(OUTPUT_FILE);
  await appendSandwichHistory(output.sandwiches);
}

async function runOnce(provider) {
  const relayBlocks = await fetchRelayBlocks(30);
  const { arbs: arbTxs, sandwiches } = await scanBlocks(provider, SCAN_BLOCKS);
  arbTxs.sort((a, b) => b.swap_count - a.swap_count);

  const allTokens = new Set();
  allTokens.add("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  for (const tx of arbTxs) {
    for (const token of Object.keys(tx.net_token_flows ?? {})) {
      allTokens.add(token);
    }
  }
  for (const sw of sandwiches) {
    allTokens.add(sw.entry_tx.token_in);
    allTokens.add(sw.entry_tx.token_out);
    allTokens.add(sw.exit_tx.token_in);
    allTokens.add(sw.exit_tx.token_out);
  }
  const prices = await fetchTokenPrices([...allTokens]);
  computePnl(arbTxs, prices);
  enrichSandwiches(sandwiches, prices);

  return { relayBlocks, arbTxs, sandwiches };
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
    const { arbs: arbTxs, sandwiches } = await scanBlocks(provider, SCAN_BLOCKS);
    log(`  ✓ ${arbTxs.length} 笔套利交易, ${sandwiches.length} 笔三明治`);
    arbTxs.sort((a, b) => b.swap_count - a.swap_count);

    log("\n[3/3] 查询价格 & 计算 PnL...");
    const allTokens = new Set(["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]);
    for (const tx of arbTxs) {
      for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
    }
    for (const sw of sandwiches) {
      allTokens.add(sw.entry_tx.token_in);
      allTokens.add(sw.entry_tx.token_out);
      allTokens.add(sw.exit_tx.token_in);
      allTokens.add(sw.exit_tx.token_out);
    }
    const prices = await fetchTokenPrices([...allTokens]);
    computePnl(arbTxs, prices);
    enrichSandwiches(sandwiches, prices);
    sandwiches = await filterOutEnsBots(provider, sandwiches);

    const pnlTxs = arbTxs.filter((t) => t.pnl_usd !== null);
    const totalPnl = pnlTxs.reduce((s, t) => s + t.pnl_usd, 0);
    log(`  ✓ ${pnlTxs.length} 笔有 PnL, 总计 $${totalPnl.toFixed(2)}`);

    await saveOutput({
      updated_at: new Date().toISOString(),
      scan_blocks: SCAN_BLOCKS,
      total_arbitrage_txs: arbTxs.length,
      total_sandwiches: sandwiches.length,
      relay_blocks: relayBlocks.slice(0, 15),
      transactions: arbTxs,
      sandwiches,
    });

    log(`\n  已保存 → ${OUTPUT_FILE} & OSS`);
    return;
  }

  // ---- Watch 模式 ----
  let lastBlock = 0;
  let allTxs = [];
  let allSandwiches = [];
  const MAX_TXS = 500;
  const MAX_SANDWICHES = 300;

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

      const newArbs = [];
      const newSandwiches = [];
      for (let i = 0; i < blocksToScan; i++) {
        const blockNum = currentBlock - i;
        const hex = "0x" + blockNum.toString(16);
        try {
          const [receipts, block] = await Promise.all([
            provider.send("eth_getBlockReceipts", [hex]),
            provider.send("eth_getBlockByNumber", [hex, false]),
          ]);
          if (!receipts) continue;
          const blockTimestamp = block?.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : null;
          const arbs = analyzeReceipts(receipts, blockNum);
          const sws = detectSandwiches(receipts, blockNum);
          for (const sw of sws) sw.block_timestamp = blockTimestamp;
          if (arbs.length > 0 || sws.length > 0) {
            log(`  区块 ${blockNum}: ${arbs.length} 笔套利, ${sws.length} 笔三明治`);
          }
          newArbs.push(...arbs);
          newSandwiches.push(...sws);
        } catch (e) {
          log(`  [!] 区块 ${blockNum}: ${e.message?.slice(0, 60)}`);
        }
      }

      // Price & PnL
      const allTokens = new Set(["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]);
      for (const tx of newArbs) {
        for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
      }
      for (const sw of newSandwiches) {
        allTokens.add(sw.entry_tx.token_in);
        allTokens.add(sw.entry_tx.token_out);
        allTokens.add(sw.exit_tx.token_in);
        allTokens.add(sw.exit_tx.token_out);
      }
      if (allTokens.size > 1 || newArbs.length > 0 || newSandwiches.length > 0) {
        const prices = await fetchTokenPrices([...allTokens]);
        computePnl(newArbs, prices);
        enrichSandwiches(newSandwiches, prices);
        newSandwiches = await filterOutEnsBots(provider, newSandwiches);
      }

      // Merge arbs
      const seen = new Set();
      const merged = [];
      for (const tx of [...newArbs, ...allTxs]) {
        if (seen.has(tx.tx_hash)) continue;
        seen.add(tx.tx_hash);
        merged.push(tx);
        if (merged.length >= MAX_TXS) break;
      }
      allTxs = merged;

      // Merge sandwiches (dedup by entry_tx hash)
      const seenSw = new Set();
      const mergedSw = [];
      for (const sw of [...newSandwiches, ...allSandwiches]) {
        if (seenSw.has(sw.entry_tx.tx_hash)) continue;
        seenSw.add(sw.entry_tx.tx_hash);
        mergedSw.push(sw);
        if (mergedSw.length >= MAX_SANDWICHES) break;
      }
      allSandwiches = mergedSw;

      await saveOutput({
        updated_at: new Date().toISOString(),
        scan_blocks: blocksToScan,
        total_arbitrage_txs: allTxs.length,
        total_sandwiches: allSandwiches.length,
        relay_blocks: relayBlocks.slice(0, 15),
        transactions: allTxs,
        sandwiches: allSandwiches,
      });

      log(`  ✓ +${newArbs.length} 套利, +${newSandwiches.length} 三明治, 累计 ${allTxs.length}/${allSandwiches.length}`);
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
