#!/usr/bin/env node
/**
 * One-time cleanup: remove ENS bot trades from existing OSS data
 */
require("dotenv").config();
const { ethers } = require("ethers");
const OSS = require("ali-oss");

const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || "oss-ap-southeast-1",
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || "mev-explorer-data",
});

const provider = new ethers.JsonRpcProvider(
  new ethers.FetchRequest(process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com"),
  1, { staticNetwork: ethers.Network.from(1) }
);

async function cleanFile(key) {
  console.log(`\n--- Cleaning ${key} ---`);
  let data;
  try {
    const res = await ossClient.get(key);
    data = JSON.parse(res.content.toString());
  } catch {
    console.log(`  File not found, skipping.`);
    return;
  }

  const isHistory = Array.isArray(data);
  const sandwiches = isHistory ? data : (data.sandwiches || []);
  console.log(`  Found ${sandwiches.length} sandwiches`);

  const botAddrs = [...new Set(sandwiches.map((s) => s.bot_address).filter(Boolean))];
  console.log(`  Resolving ENS for ${botAddrs.length} unique bot addresses...`);

  const ensMap = new Map();
  for (const addr of botAddrs) {
    try {
      const name = await provider.lookupAddress(addr);
      if (name) {
        ensMap.set(addr.toLowerCase(), name);
        console.log(`    ${addr} → ${name}`);
      }
    } catch {}
  }

  if (ensMap.size === 0) {
    console.log(`  No ENS bots found, file is clean.`);
    return;
  }

  const cleaned = sandwiches.filter((s) => !ensMap.has(s.bot_address?.toLowerCase()));
  const removed = sandwiches.length - cleaned.length;
  console.log(`  Removing ${removed} ENS bot trades`);

  const output = isHistory ? cleaned : { ...data, sandwiches: cleaned };
  const buf = Buffer.from(JSON.stringify(output), "utf-8");
  await ossClient.put(key, buf, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  });
  console.log(`  ✓ Uploaded cleaned file (${cleaned.length} sandwiches)`);
}

async function main() {
  await cleanFile("eth/data.json");
  await cleanFile("eth/sandwich-history.json");
  console.log("\nDone!");
}

main().catch(console.error);
