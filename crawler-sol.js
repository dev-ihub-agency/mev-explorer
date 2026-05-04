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
const OSS_HISTORY_KEY = "sol/sandwich-history.json";
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

function extractFlowDirection(flows) {
  let tokenIn = { mint: "", amount: "0", absVal: 0n };
  let tokenOut = { mint: "", amount: "0", absVal: 0n };
  for (const [mint, info] of Object.entries(flows)) {
    const amt = BigInt(info.amount);
    const abs = amt < 0n ? -amt : amt;
    if (amt < 0n && abs > tokenIn.absVal) {
      tokenIn = { mint, amount: abs.toString(), absVal: abs };
    } else if (amt > 0n && abs > tokenOut.absVal) {
      tokenOut = { mint, amount: abs.toString(), absVal: abs };
    }
  }
  return {
    token_in: tokenIn.mint,
    amount_in: tokenIn.amount,
    token_out: tokenOut.mint,
    amount_out: tokenOut.amount,
  };
}

function detectSandwiches(block, slotNumber) {
  const txs = block.transactions ?? [];

  const swapTxs = [];
  for (let txIndex = 0; txIndex < txs.length; txIndex++) {
    const tx = txs[txIndex];
    if (tx.meta?.err) continue;

    const dexHits = countDexSwaps(tx);
    if (dexHits.size === 0) continue;

    const allKeys = resolveAccountKeys(tx);
    const signer = allKeys[0] ?? "";
    if (!signer) continue;

    const signature = tx.transaction?.signatures?.[0];
    if (!signature) continue;

    const { flows } = computeTokenBalanceDiffs(tx);

    swapTxs.push({
      txIndex,
      signature,
      signer,
      dexList: [...dexHits.keys()],
      flows,
    });
  }

  const bySigner = new Map();
  for (const stx of swapTxs) {
    if (!bySigner.has(stx.signer)) bySigner.set(stx.signer, []);
    bySigner.get(stx.signer).push(stx);
  }

  const sandwiches = [];

  for (const [signer, signerTxs] of bySigner) {
    if (signerTxs.length < 2) continue;
    signerTxs.sort((a, b) => a.txIndex - b.txIndex);

    for (let i = 0; i < signerTxs.length; i++) {
      for (let j = i + 1; j < signerTxs.length; j++) {
        const entry = signerTxs[i];
        const exit = signerTxs[j];

        const sharedTokens = new Set();
        for (const mint of Object.keys(entry.flows)) {
          if (!(mint in exit.flows)) continue;
          const entryAmt = BigInt(entry.flows[mint].amount);
          const exitAmt = BigInt(exit.flows[mint].amount);
          if ((entryAmt > 0n && exitAmt < 0n) || (entryAmt < 0n && exitAmt > 0n)) {
            sharedTokens.add(mint);
          }
        }
        if (sharedTokens.size === 0) continue;

        const victims = [];
        for (const stx of swapTxs) {
          if (stx.signer === signer) continue;
          if (stx.txIndex <= entry.txIndex || stx.txIndex >= exit.txIndex) continue;

          let sharesToken = false;
          for (const mint of sharedTokens) {
            if (mint in stx.flows) { sharesToken = true; break; }
          }
          if (!sharesToken) continue;

          const vDir = extractFlowDirection(stx.flows);
          victims.push({
            tx_hash: stx.signature,
            from_address: stx.signer,
            token_in: vDir.token_in,
            amount_in: vDir.amount_in,
            token_out: vDir.token_out,
            amount_out: vDir.amount_out,
          });
        }

        if (victims.length === 0) continue;

        const entryDir = extractFlowDirection(entry.flows);
        const exitDir = extractFlowDirection(exit.flows);
        const allDexes = [...new Set([...entry.dexList, ...exit.dexList])];

        sandwiches.push({
          type: "sandwich",
          block_number: slotNumber,
          bot_address: signer,
          pool: "",
          dex: allDexes.join(", "),
          entry_tx: {
            tx_hash: entry.signature,
            token_in: entryDir.token_in,
            amount_in: entryDir.amount_in,
            token_out: entryDir.token_out,
            amount_out: entryDir.amount_out,
          },
          exit_tx: {
            tx_hash: exit.signature,
            token_in: exitDir.token_in,
            amount_in: exitDir.amount_in,
            token_out: exitDir.token_out,
            amount_out: exitDir.amount_out,
          },
          victims,
          bot_profit_usd: null,
          explorer_base: "https://solscan.io",
        });
      }
    }
  }

  return sandwiches;
}

function enrichSandwiches(sandwiches, prices) {
  const solPrice = prices[WSOL]?.price ?? 0;

  for (const sw of sandwiches) {
    for (const field of [sw.entry_tx, sw.exit_tx]) {
      if (field.token_in && prices[field.token_in]) {
        const info = prices[field.token_in];
        field.token_in_symbol = info.symbol;
        field.amount_in_formatted = (Number(field.amount_in) / 10 ** (info.decimals ?? 9)).toFixed(6);
      }
      if (field.token_out && prices[field.token_out]) {
        const info = prices[field.token_out];
        field.token_out_symbol = info.symbol;
        field.amount_out_formatted = (Number(field.amount_out) / 10 ** (info.decimals ?? 9)).toFixed(6);
      }
    }
    for (const v of sw.victims) {
      if (v.token_in && prices[v.token_in]) {
        const info = prices[v.token_in];
        v.token_in_symbol = info.symbol;
        v.amount_in_formatted = (Number(v.amount_in) / 10 ** (info.decimals ?? 9)).toFixed(6);
      }
      if (v.token_out && prices[v.token_out]) {
        const info = prices[v.token_out];
        v.token_out_symbol = info.symbol;
        v.amount_out_formatted = (Number(v.amount_out) / 10 ** (info.decimals ?? 9)).toFixed(6);
      }
    }

    const entryTx = sw.entry_tx;
    const exitTx = sw.exit_tx;

    if (entryTx.token_in === WSOL && exitTx.token_out === WSOL) {
      const solSpent = Number(entryTx.amount_in) / 1e9;
      const solReceived = Number(exitTx.amount_out) / 1e9;
      const profitSol = solReceived - solSpent;
      sw.bot_profit_amount = Math.abs(profitSol).toFixed(6);
      sw.bot_profit_token = "SOL";
      if (solPrice > 0) {
        sw.bot_profit_usd = Math.round(profitSol * solPrice * 100) / 100;
      }
    } else {
      const netFlows = {};
      if (entryTx.token_in)
        netFlows[entryTx.token_in] = -Number(entryTx.amount_in);
      if (entryTx.token_out)
        netFlows[entryTx.token_out] =
          (netFlows[entryTx.token_out] ?? 0) + Number(entryTx.amount_out);
      if (exitTx.token_in)
        netFlows[exitTx.token_in] =
          (netFlows[exitTx.token_in] ?? 0) - Number(exitTx.amount_in);
      if (exitTx.token_out)
        netFlows[exitTx.token_out] =
          (netFlows[exitTx.token_out] ?? 0) + Number(exitTx.amount_out);

      let profitUsd = 0;
      let hasPriceData = false;
      let maxAbsFlow = 0;
      let bestMint = "";
      for (const [mint, rawAmount] of Object.entries(netFlows)) {
        const info = prices[mint];
        if (!info?.price) continue;
        hasPriceData = true;
        const usd = (rawAmount / 10 ** (info.decimals ?? 9)) * info.price;
        profitUsd += usd;
        if (Math.abs(usd) > maxAbsFlow) {
          maxAbsFlow = Math.abs(usd);
          bestMint = mint;
        }
      }
      if (hasPriceData) {
        sw.bot_profit_usd = Math.round(profitUsd * 100) / 100;
        if (bestMint && prices[bestMint]) {
          const info = prices[bestMint];
          const amt = (netFlows[bestMint] ?? 0) / 10 ** (info.decimals ?? 9);
          sw.bot_profit_amount = Math.abs(amt).toFixed(6);
          sw.bot_profit_token = info.symbol;
        }
      }
    }
  }
}

async function scanSlots(conn, numSlots = SCAN_SLOTS) {
  const latestSlot = await conn.getSlot("confirmed");
  const allArb = [];
  const allSandwiches = [];

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
      const blockTimestamp = block.blockTime ? new Date(block.blockTime * 1000).toISOString() : null;
      const arbs = analyzeBlock(block, slot);
      const sandwiches = detectSandwiches(block, slot);
      for (const sw of sandwiches) sw.block_timestamp = blockTimestamp;
      log(`    ${block.transactions?.length ?? 0} 笔交易, ${arbs.length} 笔套利, ${sandwiches.length} 笔夹子`);
      allArb.push(...arbs);
      allSandwiches.push(...sandwiches);
    } catch (e) {
      log(`    [!] 失败: ${e.message?.slice(0, 80)}`);
    }
  }

  return { arbs: allArb, sandwiches: allSandwiches };
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
  await appendSandwichHistory(output.sandwiches);
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
    const { arbs: arbTxs, sandwiches: allSandwiches } = await scanSlots(conn, SCAN_SLOTS);
    log(`  ✓ ${arbTxs.length} 笔套利交易, ${allSandwiches.length} 笔夹子攻击`);
    arbTxs.sort((a, b) => b.swap_count - a.swap_count);

    log("\n[2/2] 查询价格 & 计算 PnL...");
    const allTokens = new Set([WSOL]);
    for (const tx of arbTxs) {
      for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
    }
    for (const sw of allSandwiches) {
      for (const field of [sw.entry_tx, sw.exit_tx]) {
        if (field.token_in) allTokens.add(field.token_in);
        if (field.token_out) allTokens.add(field.token_out);
      }
      for (const v of sw.victims) {
        if (v.token_in) allTokens.add(v.token_in);
        if (v.token_out) allTokens.add(v.token_out);
      }
    }
    const prices = await fetchTokenPrices([...allTokens]);
    computePnl(arbTxs, prices);
    enrichSandwiches(allSandwiches, prices);

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
      sandwiches: allSandwiches,
    });

    log(`\n  已保存 → ${OUTPUT_FILE} & OSS`);
    return;
  }

  // ---- Watch 模式 ----
  let lastSlot = 0;
  let allTxs = [];
  let allSandwiches = [];
  const MAX_TXS = 500;
  const MAX_SANDWICHES = 300;

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
      const newSandwiches = [];
      for (let i = 0; i < slotsToScan; i++) {
        const s = currentSlot - i;
        try {
          const block = await conn.getBlock(s, {
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
            rewards: false,
          });
          if (!block) continue;
          const blockTimestamp = block.blockTime ? new Date(block.blockTime * 1000).toISOString() : null;
          const arbs = analyzeBlock(block, s);
          const sandwiches = detectSandwiches(block, s);
          for (const sw of sandwiches) sw.block_timestamp = blockTimestamp;
          if (arbs.length > 0 || sandwiches.length > 0) {
            log(`  slot ${s}: ${arbs.length} 笔套利, ${sandwiches.length} 笔夹子`);
          }
          newArbs.push(...arbs);
          newSandwiches.push(...sandwiches);
        } catch (e) {
          if (!e.message?.includes("was skipped")) {
            log(`  [!] slot ${s}: ${e.message?.slice(0, 60)}`);
          }
        }
      }

      if (newArbs.length > 0 || newSandwiches.length > 0) {
        const allTokens = new Set([WSOL]);
        for (const tx of newArbs) {
          for (const token of Object.keys(tx.net_token_flows ?? {})) allTokens.add(token);
        }
        for (const sw of newSandwiches) {
          for (const field of [sw.entry_tx, sw.exit_tx]) {
            if (field.token_in) allTokens.add(field.token_in);
            if (field.token_out) allTokens.add(field.token_out);
          }
          for (const v of sw.victims) {
            if (v.token_in) allTokens.add(v.token_in);
            if (v.token_out) allTokens.add(v.token_out);
          }
        }
        const prices = await fetchTokenPrices([...allTokens]);
        computePnl(newArbs, prices);
        enrichSandwiches(newSandwiches, prices);
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
        chain: "solana",
        scan_blocks: slotsToScan,
        total_arbitrage_txs: allTxs.length,
        relay_blocks: [],
        transactions: allTxs,
        sandwiches: allSandwiches,
      });

      const newCount = newArbs.length;
      log(`  ✓ +${newCount} 新套利, +${newSandwiches.length} 新夹子, 累计 ${allTxs.length} 笔套利 / ${allSandwiches.length} 笔夹子`);
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
