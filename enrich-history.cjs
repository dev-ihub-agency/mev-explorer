#!/usr/bin/env node
/**
 * Enrich historical sandwich data with bot_profit_usd using DeFi Llama prices.
 * Usage: node enrich-history.cjs [eth|bsc|sol]
 */
require("dotenv").config();
const OSS = require("ali-oss");

const chain = process.argv[2] || "eth";
const DEFI_LLAMA_PRICE_API = "https://coins.llama.fi/prices/current";

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const HISTORY_KEY = `${chain}/sandwich-history.json`;

const CHAIN_PREFIX = chain === "bsc" ? "bsc" : chain === "sol" ? "solana" : "ethereum";

const STABLECOIN_FALLBACK = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { price: 1, decimals: 6, symbol: "USDT" },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { price: 1, decimals: 6, symbol: "USDC" },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { price: 1, decimals: 18, symbol: "DAI" },
  "0x55d398326f99059ff775485246999027b3197955": { price: 1, decimals: 18, symbol: "BSC-USD" },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { price: 1, decimals: 18, symbol: "USDC" },
  "es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb": { price: 1, decimals: 6, symbol: "USDT" },
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v": { price: 1, decimals: 6, symbol: "USDC" },
};

async function fetchTokenPrices(tokenAddrs) {
  if (tokenAddrs.length === 0) return {};
  const BATCH = 30;
  const prices = {};

  for (let i = 0; i < tokenAddrs.length; i += BATCH) {
    const batch = tokenAddrs.slice(i, i + BATCH);
    const ids = batch.map((a) => `${CHAIN_PREFIX}:${a}`).join(",");
    try {
      const resp = await fetch(`${DEFI_LLAMA_PRICE_API}/${ids}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      for (const [key, info] of Object.entries(data.coins ?? {})) {
        const addr = key.split(":")[1]?.toLowerCase();
        if (addr) prices[addr] = { price: info.price, decimals: info.decimals, symbol: info.symbol };
      }
    } catch (e) {
      console.log(`  [!] Price batch failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  for (const [addr, info] of Object.entries(STABLECOIN_FALLBACK)) {
    if (!prices[addr.toLowerCase()]) prices[addr.toLowerCase()] = info;
  }
  return prices;
}

function enrichSandwiches(sandwiches, prices) {
  let enriched = 0;
  for (const sw of sandwiches) {
    if (sw.bot_profit_usd !== null && sw.bot_profit_usd !== undefined) continue;

    const entryIn = sw.entry_tx?.token_in?.toLowerCase();
    const entryOut = sw.entry_tx?.token_out?.toLowerCase();
    const exitIn = sw.exit_tx?.token_in?.toLowerCase();
    const exitOut = sw.exit_tx?.token_out?.toLowerCase();

    if (prices[entryIn]) {
      sw.entry_tx.token_in_symbol = prices[entryIn].symbol;
      try { sw.entry_tx.amount_in_formatted = (Number(BigInt(sw.entry_tx.amount_in)) / 10 ** prices[entryIn].decimals).toFixed(6); } catch {}
    }
    if (prices[entryOut]) {
      sw.entry_tx.token_out_symbol = prices[entryOut].symbol;
      try { sw.entry_tx.amount_out_formatted = (Number(BigInt(sw.entry_tx.amount_out)) / 10 ** prices[entryOut].decimals).toFixed(6); } catch {}
    }
    if (prices[exitIn]) {
      sw.exit_tx.token_in_symbol = prices[exitIn].symbol;
      try { sw.exit_tx.amount_in_formatted = (Number(BigInt(sw.exit_tx.amount_in)) / 10 ** prices[exitIn].decimals).toFixed(6); } catch {}
    }
    if (prices[exitOut]) {
      sw.exit_tx.token_out_symbol = prices[exitOut].symbol;
      try { sw.exit_tx.amount_out_formatted = (Number(BigInt(sw.exit_tx.amount_out)) / 10 ** prices[exitOut].decimals).toFixed(6); } catch {}
    }

    const profitToken = entryIn;
    const profitInfo = prices[profitToken];
    if (!profitInfo) continue;

    try {
      const netRaw = BigInt(sw.exit_tx.amount_out) - BigInt(sw.entry_tx.amount_in);
      const netAmount = Number(netRaw) / 10 ** profitInfo.decimals;
      sw.bot_profit_amount = Math.abs(netAmount).toFixed(6);
      sw.bot_profit_token = profitInfo.symbol;
      sw.bot_profit_usd = Math.round(netAmount * profitInfo.price * 100) / 100;
      enriched++;
    } catch {}
  }
  return enriched;
}

async function main() {
  console.log(`[${chain.toUpperCase()}] Downloading ${HISTORY_KEY}...`);
  let data;
  try {
    const res = await ossClient.get(HISTORY_KEY);
    data = JSON.parse(res.content.toString());
  } catch (e) {
    console.log("Failed to download:", e.message);
    return;
  }

  const needEnrich = data.filter((s) => s.bot_profit_usd === null || s.bot_profit_usd === undefined);
  console.log(`Total: ${data.length}, need enrichment: ${needEnrich.length}`);

  if (needEnrich.length === 0) {
    console.log("All records already have profit data.");
    return;
  }

  const allTokens = new Set();
  for (const sw of needEnrich) {
    if (sw.entry_tx?.token_in) allTokens.add(sw.entry_tx.token_in.toLowerCase());
    if (sw.entry_tx?.token_out) allTokens.add(sw.entry_tx.token_out.toLowerCase());
    if (sw.exit_tx?.token_in) allTokens.add(sw.exit_tx.token_in.toLowerCase());
    if (sw.exit_tx?.token_out) allTokens.add(sw.exit_tx.token_out.toLowerCase());
  }

  console.log(`Fetching prices for ${allTokens.size} unique tokens...`);
  const prices = await fetchTokenPrices([...allTokens]);
  console.log(`Got prices for ${Object.keys(prices).length} tokens`);

  const enriched = enrichSandwiches(data, prices);
  console.log(`Enriched ${enriched} / ${needEnrich.length} sandwiches with profit data`);

  const buf = Buffer.from(JSON.stringify(data), "utf-8");
  await ossClient.put(HISTORY_KEY, buf, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  });
  console.log(`✓ Uploaded ${data.length} records to ${HISTORY_KEY}`);
}

main().catch(console.error);
