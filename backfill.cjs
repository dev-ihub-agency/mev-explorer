#!/usr/bin/env node
/**
 * One-time backfill: scan many blocks to populate sandwich-history.json
 * Usage: node backfill.js [eth|bsc|sol] [numBlocks]
 */
require("dotenv").config();
const { ethers } = require("ethers");
const OSS = require("ali-oss");

const chain = process.argv[2] || "eth";
const numBlocks = parseInt(process.argv[3] || (chain === "sol" ? "30" : chain === "bsc" ? "200" : "100"), 10);

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const HISTORY_KEY = `${chain}/sandwich-history.json`;

const SWAP_TOPICS = {
  V2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  V3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
};

const ERC20_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function detectSandwiches(receipts, blockNumber, explorerBase) {
  const swapRecords = [];

  for (const receipt of receipts) {
    if (receipt.status !== "0x1") continue;
    const txHash = receipt.transactionHash;
    const txFrom = receipt.from?.toLowerCase();
    const txIndex = parseInt(receipt.transactionIndex, 16);

    for (const log of receipt.logs) {
      const topic0 = log.topics?.[0];
      if (topic0 !== SWAP_TOPICS.V2 && topic0 !== SWAP_TOPICS.V3) continue;

      const pool = log.address?.toLowerCase();
      let tokenIn, tokenOut, amountIn, amountOut;
      const dex = topic0 === SWAP_TOPICS.V2
        ? (chain === "bsc" ? "PancakeSwap V2" : "Uniswap V2")
        : (chain === "bsc" ? "PancakeSwap V3" : "Uniswap V3");

      const transfers = receipt.logs.filter(
        (l) => l.topics?.[0] === ERC20_TRANSFER && l.address
      );

      const inTransfers = transfers.filter(
        (l) => l.topics[2] && l.topics[2].toLowerCase().includes(pool?.slice(2))
      );
      const outTransfers = transfers.filter(
        (l) => l.topics[1] && l.topics[1].toLowerCase().includes(pool?.slice(2))
      );

      if (inTransfers.length > 0 && outTransfers.length > 0) {
        tokenIn = inTransfers[0].address?.toLowerCase();
        amountIn = inTransfers[0].data;
        tokenOut = outTransfers[0].address?.toLowerCase();
        amountOut = outTransfers[0].data;
      }

      if (tokenIn && tokenOut) {
        swapRecords.push({
          txHash, txFrom, txIndex, pool, dex,
          tokenIn, amountIn, tokenOut, amountOut,
        });
      }
    }
  }

  const poolGroups = {};
  for (const r of swapRecords) {
    const key = r.pool;
    if (!poolGroups[key]) poolGroups[key] = [];
    poolGroups[key].push(r);
  }

  const sandwiches = [];
  for (const [pool, records] of Object.entries(poolGroups)) {
    records.sort((a, b) => a.txIndex - b.txIndex);

    const byBot = {};
    for (const r of records) {
      if (!byBot[r.txFrom]) byBot[r.txFrom] = [];
      byBot[r.txFrom].push(r);
    }

    for (const [bot, botRecords] of Object.entries(byBot)) {
      if (botRecords.length < 2) continue;

      for (let i = 0; i < botRecords.length - 1; i++) {
        const entry = botRecords[i];
        const exit = botRecords[i + 1];

        if (entry.tokenIn === exit.tokenOut && entry.tokenOut === exit.tokenIn) {
          const victims = records.filter(
            (r) => r.txFrom !== bot && r.txIndex > entry.txIndex && r.txIndex < exit.txIndex
          );
          if (victims.length === 0) continue;

          sandwiches.push({
            type: "sandwich",
            block_number: blockNumber,
            bot_address: bot,
            pool,
            dex: entry.dex,
            entry_tx: {
              tx_hash: entry.txHash,
              token_in: entry.tokenIn, amount_in: entry.amountIn,
              token_out: entry.tokenOut, amount_out: entry.amountOut,
            },
            exit_tx: {
              tx_hash: exit.txHash,
              token_in: exit.tokenIn, amount_in: exit.amountIn,
              token_out: exit.tokenOut, amount_out: exit.amountOut,
            },
            victims: victims.map((v) => ({
              tx_hash: v.txHash, from_address: v.txFrom,
              token_in: v.tokenIn, amount_in: v.amountIn,
              token_out: v.tokenOut, amount_out: v.amountOut,
            })),
            bot_profit_usd: null,
            explorer_base: explorerBase,
            block_timestamp: null,
          });
        }
      }
    }
  }
  return sandwiches;
}

async function backfillSolana() {
  const { Connection } = require("@solana/web3.js");
  const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(RPC_URL, { commitment: "confirmed" });

  const latestSlot = await conn.getSlot("confirmed");
  console.log(`[SOL] Latest slot: ${latestSlot}, scanning ${numBlocks} slots back...`);

  const DEX_PROGRAMS = [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  ];
  const WSOL = "So11111111111111111111111111111111111111112";

  let allSandwiches = [];

  for (let i = 0; i < numBlocks; i++) {
    const slot = latestSlot - i;
    try {
      const block = await conn.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: "full",
        rewards: false,
      });
      if (!block) continue;
      const blockTimestamp = block.blockTime ? new Date(block.blockTime * 1000).toISOString() : null;
      const txs = block.transactions || [];

      const swapTxs = [];
      for (let ti = 0; ti < txs.length; ti++) {
        const tx = txs[ti];
        if (tx.meta?.err) continue;
        const msg = tx.transaction?.message;
        if (!msg) continue;
        const staticKeys = msg.staticAccountKeys?.map(k => k.toString()) || [];
        const loaded = tx.meta?.loadedAddresses || { writable: [], readonly: [] };
        const allKeys = [...staticKeys, ...loaded.writable.map(k => k.toString()), ...loaded.readonly.map(k => k.toString())];
        const hasDex = allKeys.some(k => DEX_PROGRAMS.includes(k));
        if (!hasDex) continue;

        const signer = staticKeys[0];
        const pre = tx.meta?.preTokenBalances || [];
        const post = tx.meta?.postTokenBalances || [];
        const diffs = {};
        for (const b of post) {
          const mint = b.mint;
          const owner = b.owner;
          if (owner !== signer) continue;
          const preB = pre.find(p => p.accountIndex === b.accountIndex);
          const preAmt = preB ? Number(preB.uiTokenAmount?.amount || 0) : 0;
          const postAmt = Number(b.uiTokenAmount?.amount || 0);
          const diff = postAmt - preAmt;
          if (diff !== 0) diffs[mint] = (diffs[mint] || 0) + diff;
        }

        const mints = Object.keys(diffs);
        if (mints.length >= 2) {
          const inMints = mints.filter(m => diffs[m] < 0);
          const outMints = mints.filter(m => diffs[m] > 0);
          if (inMints.length > 0 && outMints.length > 0) {
            swapTxs.push({
              txIndex: ti,
              signer,
              sig: tx.transaction.signatures[0],
              tokenIn: inMints[0],
              amountIn: String(Math.abs(diffs[inMints[0]])),
              tokenOut: outMints[0],
              amountOut: String(diffs[outMints[0]]),
            });
          }
        }
      }

      const bySigner = {};
      for (const r of swapTxs) {
        if (!bySigner[r.signer]) bySigner[r.signer] = [];
        bySigner[r.signer].push(r);
      }

      for (const [signer, records] of Object.entries(bySigner)) {
        if (records.length < 2) continue;
        records.sort((a, b) => a.txIndex - b.txIndex);

        for (let j = 0; j < records.length - 1; j++) {
          const entry = records[j];
          const exit = records[j + 1];
          if (entry.tokenIn === exit.tokenOut && entry.tokenOut === exit.tokenIn) {
            const victims = swapTxs.filter(
              r => r.signer !== signer && r.txIndex > entry.txIndex && r.txIndex < exit.txIndex
            );
            if (victims.length === 0) continue;
            allSandwiches.push({
              type: "sandwich",
              block_number: slot,
              bot_address: signer,
              pool: "",
              dex: "Solana DEX",
              entry_tx: { tx_hash: entry.sig, token_in: entry.tokenIn, amount_in: entry.amountIn, token_out: entry.tokenOut, amount_out: entry.amountOut },
              exit_tx: { tx_hash: exit.sig, token_in: exit.tokenIn, amount_in: exit.amountIn, token_out: exit.tokenOut, amount_out: exit.amountOut },
              victims: victims.map(v => ({ tx_hash: v.sig, from_address: v.signer, token_in: v.tokenIn, amount_in: v.amountIn, token_out: v.tokenOut, amount_out: v.amountOut })),
              bot_profit_usd: null,
              explorer_base: "https://solscan.io",
              block_timestamp: blockTimestamp,
            });
          }
        }
      }
      if ((i + 1) % 10 === 0 || i === numBlocks - 1) {
        console.log(`  Slot ${latestSlot} → ${slot}: scanned ${i + 1}/${numBlocks}, ${allSandwiches.length} sandwiches`);
      }
    } catch (e) {
      if (!e.message?.includes("was skipped")) {
        console.log(`  [!] Slot ${slot}: ${e.message?.slice(0, 60)}`);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return allSandwiches;
}

async function main() {
  let allSandwiches = [];

  if (chain === "sol") {
    allSandwiches = await backfillSolana();
  } else {
    const RPC_URL = chain === "bsc"
      ? (process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org")
      : (process.env.ETH_RPC_URL || "https://eth.llamarpc.com");

    const chainId = chain === "bsc" ? 56 : 1;
    const explorerBase = chain === "bsc" ? "https://bscscan.com" : "https://etherscan.io";

    const req = new ethers.FetchRequest(RPC_URL);
    req.timeout = 30_000;
    const provider = new ethers.JsonRpcProvider(req, chainId, {
      staticNetwork: ethers.Network.from(chainId),
    });

    const latest = await provider.getBlockNumber();
    console.log(`[${chain.toUpperCase()}] Latest block: ${latest}, scanning ${numBlocks} blocks back...`);

    const BATCH = 5;

    for (let i = 0; i < numBlocks; i += BATCH) {
      const batchEnd = Math.min(i + BATCH, numBlocks);
      const promises = [];
      for (let j = i; j < batchEnd; j++) {
        const bn = latest - j;
        const hex = "0x" + bn.toString(16);
        promises.push(
          Promise.all([
            provider.send("eth_getBlockReceipts", [hex]),
            provider.send("eth_getBlockByNumber", [hex, false]),
          ]).then(([receipts, block]) => {
            if (!receipts) return [];
            const ts = block?.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : null;
            const sws = detectSandwiches(receipts, bn, explorerBase);
            for (const sw of sws) sw.block_timestamp = ts;
            return sws;
          }).catch((e) => {
            console.log(`  [!] Block ${bn}: ${e.message?.slice(0, 60)}`);
            return [];
          })
        );
      }
      const results = await Promise.all(promises);
      const found = results.flat();
      allSandwiches.push(...found);
      console.log(`  Blocks ${latest - i} → ${latest - batchEnd + 1}: ${found.length} sandwiches (total: ${allSandwiches.length})`);

      if (i + BATCH < numBlocks) await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Filter out ENS bots (ETH only)
  if (chain === "eth" && allSandwiches.length > 0) {
    const provider = new ethers.JsonRpcProvider(
      new ethers.FetchRequest(process.env.ETH_RPC_URL || "https://eth.llamarpc.com"),
      1, { staticNetwork: ethers.Network.from(1) }
    );
    const botAddrs = [...new Set(allSandwiches.map((s) => s.bot_address))];
    console.log(`\nENS lookup for ${botAddrs.length} bot addresses...`);
    const ensMap = new Map();
    for (const addr of botAddrs) {
      try {
        const name = await provider.lookupAddress(addr);
        if (name) ensMap.set(addr.toLowerCase(), name);
      } catch {}
    }
    if (ensMap.size > 0) {
      const before = allSandwiches.length;
      allSandwiches = allSandwiches.filter((s) => !ensMap.has(s.bot_address.toLowerCase()));
      console.log(`Filtered out ${before - allSandwiches.length} ENS bot trades (${[...ensMap.values()].join(", ")})`);
    }
  }

  console.log(`\nTotal sandwiches found: ${allSandwiches.length}`);

  if (allSandwiches.length === 0) {
    console.log("No sandwiches found, nothing to upload.");
    return;
  }

  let existing = [];
  try {
    const res = await ossClient.get(HISTORY_KEY);
    existing = JSON.parse(res.content.toString());
    console.log(`Existing history: ${existing.length} records`);
  } catch {
    console.log("No existing history file, creating new one.");
  }

  const seenTx = new Set(existing.map((s) => s.entry_tx?.tx_hash));
  const toAdd = allSandwiches.filter((s) => s.block_timestamp && !seenTx.has(s.entry_tx?.tx_hash));
  console.log(`New unique sandwiches to add: ${toAdd.length}`);

  const merged = [...existing, ...toAdd];
  const buf = Buffer.from(JSON.stringify(merged), "utf-8");
  await ossClient.put(HISTORY_KEY, buf, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  });
  console.log(`✓ Uploaded: ${merged.length} total records to ${HISTORY_KEY}`);
}

main().catch(console.error);
