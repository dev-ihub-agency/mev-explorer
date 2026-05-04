/**
 * MEV Arbitrage Transaction Crawler — Solana
 *
 * 通过 getBlock 扫描最新 slot，识别包含多个 DEX swap 的套利交易。
 * 使用 preTokenBalances / postTokenBalances 计算 PnL。
 * 输出: OSS sol/data.json
 */

import { Connection } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";

// ---------- 配置 ----------

const RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const OUTPUT_FILE = path.join("public", "sol-data.json");
const SCAN_SLOTS = 3;

const DEX_PROGRAMS = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium V4",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter V6",
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX9V: "Jupiter V4",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca V2",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: "Raydium Route",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
};

const WSOL = "So11111111111111111111111111111111111111112";

const DEFI_LLAMA_PRICE_API = "https://coins.llama.fi/prices/current";
const PRICE_PREFIX = "solana";

const log = (msg) => console.log(msg);

// ---------- Aliyun OSS ----------

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const OSS_KEY = "sol/data.json";

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

// ---------- Solana RPC ----------

function makeConnection() {
  return new Connection(RPC_URL, {
    commitment: "confirmed",
    disableRetryOnRateLimit: false,
  });
}

// ---------- 套利分析 ----------

function resolveAccountKeys(tx) {
  const msg = tx.transaction?.message;
  if (!msg) return [];
  const keys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) =>
    String(k)
  );
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    for (const k of loaded.writable ?? []) keys.push(String(k));
    for (const k of loaded.readonly ?? []) keys.push(String(k));
  }
  return keys;
}

function countDexSwaps(tx) {
  const dexHits = new Map();
  const allKeys = resolveAccountKeys(tx);
  const msg = tx.transaction?.message;

  const programIds = new Set();
  const ixs = msg?.compiledInstructions ?? msg?.instructions ?? [];
  for (const ix of ixs) {
    const pid = allKeys[ix.programIdIndex];
    if (pid) programIds.add(pid);
  }

  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      const pid = allKeys[ix.programIdIndex];
      if (pid) programIds.add(pid);
    }
  }

  for (const pid of programIds) {
    const dexName = DEX_PROGRAMS[pid];
    if (dexName) {
      dexHits.set(dexName, (dexHits.get(dexName) ?? 0) + 1);
    }
  }

  return dexHits;
}

function computeTokenBalanceDiffs(tx) {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const signerIndex = 0;
  const allKeys = resolveAccountKeys(tx);
  const signerStr = allKeys[signerIndex] ?? "";

  if (!signerStr) return { flows: {}, signer: "" };

  const balanceMap = new Map();

  for (const b of pre) {
    const owner = b.owner;
    if (owner !== signerStr) continue;
    const mint = b.mint;
    const amount = BigInt(b.uiTokenAmount?.amount ?? "0");
    balanceMap.set(mint, { pre: amount, post: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 });
  }

  for (const b of post) {
    const owner = b.owner;
    if (owner !== signerStr) continue;
    const mint = b.mint;
    const amount = BigInt(b.uiTokenAmount?.amount ?? "0");
    if (balanceMap.has(mint)) {
      balanceMap.get(mint).post = amount;
    } else {
      balanceMap.set(mint, { pre: 0n, post: amount, decimals: b.uiTokenAmount?.decimals ?? 0 });
    }
  }

  const flows = {};
  for (const [mint, bal] of balanceMap) {
    const diff = bal.post - bal.pre;
    if (diff !== 0n) {
      flows[mint] = { amount: diff.toString(), decimals: bal.decimals };
    }
  }

  // SOL balance diff
  const preSol = BigInt(tx.meta?.preBalances?.[signerIndex] ?? 0);
  const postSol = BigInt(tx.meta?.postBalances?.[signerIndex] ?? 0);
  const solDiff = postSol - preSol + BigInt(tx.meta?.fee ?? 0);
  if (solDiff !== 0n) {
    flows[WSOL] = { amount: solDiff.toString(), decimals: 9 };
  }

  return { flows, signer: signerStr };
}

function analyzeBlock(block, slotNumber) {
  const arbTxs = [];

  for (const tx of block.transactions ?? []) {
    if (tx.meta?.err) continue;

    const dexHits = countDexSwaps(tx);
    const totalDexPrograms = dexHits.size;

    let totalSwapCount = 0;
    for (const count of dexHits.values()) {
      totalSwapCount += count;
    }

    if (totalSwapCount < 2) continue;

    const signature = tx.transaction?.signatures?.[0];
    if (!signature) continue;

    const { flows, signer } = computeTokenBalanceDiffs(tx);

    const fee = tx.meta?.fee ?? 0;
    const feeSol = fee / 1e9;

    const netTokenFlows = {};
    for (const [mint, info] of Object.entries(flows)) {
      netTokenFlows[mint] = info.amount;
    }

    arbTxs.push({
      tx_hash: signature,
      block_number: slotNumber,
      source: "onchain_scan",
      type: "arbitrage",
      swap_count: totalSwapCount,
      dex_list: [...dexHits.keys()].sort(),
      pools: [],
      gas_used: tx.meta?.computeUnitsConsumed ?? 0,
      gas_price_gwei: 0,
      gas_cost_eth: feeSol,
      from_address: signer,
      to_address: "",
      net_token_flows: netTokenFlows,
      token_decimals: Object.fromEntries(
        Object.entries(flows).map(([mint, info]) => [mint, info.decimals])
      ),
      etherscan_url: `https://solscan.io/tx/${signature}`,
      eigenphi_url: `https://explorer.jito.wtf/bundle/${signature}`,
    });
  }

  return arbTxs;
}

async function scanSlots(conn, numSlots = SCAN_SLOTS) {
  const latestSlot = await conn.getSlot("confirmed");
  const allArb = [];

  for (let i = 0; i < numSlots; i++) {
    const slot = latestSlot - i;
    log(`  扫描 slot ${slot}...`);

    try {
      const block = await conn.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "full",
        rewards: false,
      });
      if (!block) {
        log(`    跳过 (无数据)`);
        continue;
      }
      const arbs = analyzeBlock(block, slot);
      log(`    ${block.transactions?.length ?? 0} 笔交易, ${arbs.length} 笔套利`);
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
        const addr = key.replace(`${PRICE_PREFIX}:`, "");
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

  return prices;
}

function computePnl(arbTxs, prices) {
  const solPrice = prices[WSOL]?.price ?? 0;

  for (const tx of arbTxs) {
    const flows = tx.net_token_flows ?? {};
    const decimalsMap = tx.token_decimals ?? {};
    const entries = Object.entries(flows);

    if (entries.length === 0) {
      tx.revenue_usd = null;
      tx.gas_cost_usd = solPrice > 0 ? Math.round(tx.gas_cost_eth * solPrice * 100) / 100 : null;
      tx.pnl_usd = null;
      tx.profit_token = null;
      tx.profit_token_amount = null;
      tx.native_price_usd = solPrice;
      continue;
    }

    let revenueUsd = 0;
    let profitToken = null;
    let profitTokenAmount = 0;
    let maxUsdFlow = 0;
    let hasPriceData = false;

    for (const [token, rawStr] of entries) {
      const raw = BigInt(rawStr);
      const info = prices[token];
      const decimals = info?.decimals ?? decimalsMap[token] ?? 9;
      const price = info?.price ?? 0;

      if (price === 0) continue;

      hasPriceData = true;
      const amount = Number(raw) / 10 ** decimals;
      const usdValue = amount * price;
      revenueUsd += usdValue;

      if (usdValue > maxUsdFlow) {
        maxUsdFlow = usdValue;
        profitToken = info?.symbol ?? token.slice(0, 6);
        profitTokenAmount = amount;
      }
    }

    const gasCostUsd = tx.gas_cost_eth * solPrice;
    const pnlUsd = revenueUsd - gasCostUsd;

    tx.revenue_usd = hasPriceData ? Math.round(revenueUsd * 100) / 100 : null;
    tx.gas_cost_usd = solPrice > 0 ? Math.round(gasCostUsd * 100) / 100 : null;
    tx.pnl_usd = hasPriceData && solPrice > 0 ? Math.round(pnlUsd * 100) / 100 : null;
    tx.profit_token = profitToken;
    tx.profit_token_amount =
      profitTokenAmount !== 0 ? Math.round(profitTokenAmount * 1e8) / 1e8 : null;
    tx.native_price_usd = solPrice;
  }
}

// ---------- main ----------

const WATCH_INTERVAL = 3_000;

async function saveOutput(output) {
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  await uploadToOSS(OUTPUT_FILE);
}

async function main() {
  const isWatch = process.argv.includes("--watch");

  log("=".repeat(55));
  log(`  MEV Arbitrage Crawler — Solana${isWatch ? " (watch mode)" : ""}`);
  log("=".repeat(55));

  const conn = makeConnection();
  const slot = await conn.getSlot("confirmed");
  log(`  RPC 已连接, 当前 slot: ${slot}`);

  if (!isWatch) {
    log("\n[1/2] 扫描最近 slot...");
    let arbTxs = await scanSlots(conn, SCAN_SLOTS);
    log(`  ✓ ${arbTxs.length} 笔套利交易`);
    arbTxs.sort((a, b) => b.swap_count - a.swap_count);

    log("\n[2/2] 查询价格 & 计算 PnL...");
    const allTokens = new Set([WSOL]);
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
      chain: "solana",
      scan_blocks: SCAN_SLOTS,
      total_arbitrage_txs: arbTxs.length,
      relay_blocks: [],
      transactions: arbTxs,
    });

    log(`\n  已保存 → ${OUTPUT_FILE} & OSS`);
    return;
  }

  // ---- Watch 模式 ----
  let lastSlot = 0;
  let allTxs = [];
  const MAX_TXS = 200;

  async function tick() {
    try {
      const currentSlot = await conn.getSlot("confirmed");
      if (currentSlot <= lastSlot) return;

      const slotsToScan = lastSlot === 0
        ? SCAN_SLOTS
        : Math.min(currentSlot - lastSlot, 5);

      const ts = new Date().toLocaleTimeString();
      log(`\n[${ts}] slot ${currentSlot} (扫描 ${slotsToScan} 个)...`);

      const newArbs = [];
      for (let i = 0; i < slotsToScan; i++) {
        const s = currentSlot - i;
        try {
          const block = await conn.getBlock(s, {
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
            rewards: false,
          });
          if (!block) continue;
          const arbs = analyzeBlock(block, s);
          if (arbs.length > 0) {
            log(`  slot ${s}: ${arbs.length} 笔套利`);
          }
          newArbs.push(...arbs);
        } catch (e) {
          if (!e.message?.includes("was skipped")) {
            log(`  [!] slot ${s}: ${e.message?.slice(0, 60)}`);
          }
        }
      }

      if (newArbs.length > 0) {
        const allTokens = new Set([WSOL]);
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
        chain: "solana",
        scan_blocks: slotsToScan,
        total_arbitrage_txs: allTxs.length,
        relay_blocks: [],
        transactions: allTxs,
      });

      const newCount = newArbs.length;
      log(`  ✓ +${newCount} 新交易, 累计 ${allTxs.length} 笔`);
      lastSlot = currentSlot;
    } catch (e) {
      log(`  [!] tick 错误: ${e.message?.slice(0, 80)}`);
    }
  }

  await tick();

  log(`\n  进入 watch 模式, 每 ${WATCH_INTERVAL / 1000}s 检查新 slot...`);
  log("  按 Ctrl+C 退出\n");
  setInterval(tick, WATCH_INTERVAL);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
