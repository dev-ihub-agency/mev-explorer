"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ─── Types ───

type ChainId = "all" | "eth" | "bsc" | "sol";

interface ChainConfig {
  id: ChainId;
  label: string;
  nativeSymbol: string;
  explorerLabel: string;
  explorerTxUrl: string;
  explorerAddrUrl: string;
  secondaryExplorerLabel: string;
  secondaryExplorerUrl: (hash: string) => string;
}

const CHAINS: ChainConfig[] = [
  {
    id: "eth",
    label: "Ethereum",
    nativeSymbol: "ETH",
    explorerLabel: "Etherscan",
    explorerTxUrl: "https://etherscan.io/tx/",
    explorerAddrUrl: "https://etherscan.io/address/",
    secondaryExplorerLabel: "EigenPhi",
    secondaryExplorerUrl: (h) => `https://eigenphi.io/mev/eigentx/${h}`,
  },
  {
    id: "bsc",
    label: "BSC",
    nativeSymbol: "BNB",
    explorerLabel: "BscScan",
    explorerTxUrl: "https://bscscan.com/tx/",
    explorerAddrUrl: "https://bscscan.com/address/",
    secondaryExplorerLabel: "EigenPhi",
    secondaryExplorerUrl: (h) =>
      `https://eigenphi.io/mev/eigentx/${h}?chain=bsc`,
  },
  {
    id: "sol",
    label: "Solana",
    nativeSymbol: "SOL",
    explorerLabel: "Solscan",
    explorerTxUrl: "https://solscan.io/tx/",
    explorerAddrUrl: "https://solscan.io/account/",
    secondaryExplorerLabel: "Jito",
    secondaryExplorerUrl: (h) =>
      `https://explorer.jito.wtf/bundle/${h}`,
  },
];

interface Transaction {
  tx_hash: string;
  block_number: number;
  source: string;
  type: string;
  swap_count: number | null;
  dex_list: string[];
  pools?: string[];
  gas_used: number;
  gas_price_gwei: number;
  gas_cost_eth: number;
  from_address: string;
  to_address: string;
  etherscan_url: string;
  eigenphi_url: string;
  revenue_usd: number | null;
  gas_cost_usd: number | null;
  pnl_usd: number | null;
  profit_token: string | null;
  profit_token_amount: number | null;
  eth_price_usd?: number;
  native_price_usd?: number;
}

interface RelayBlock {
  slot: number;
  block_number: number;
  block_hash: string;
  value_eth: number;
  proposer_fee_recipient: string;
}

interface SandwichTxInfo {
  tx_hash: string;
  token_in: string;
  token_in_symbol?: string;
  amount_in: string;
  amount_in_formatted?: string;
  token_out: string;
  token_out_symbol?: string;
  amount_out: string;
  amount_out_formatted?: string;
}

interface SandwichVictim extends SandwichTxInfo {
  from_address: string;
}

interface Sandwich {
  type: "sandwich";
  block_number: number;
  bot_address: string;
  pool: string;
  dex: string;
  entry_tx: SandwichTxInfo;
  exit_tx: SandwichTxInfo;
  victims: SandwichVictim[];
  bot_profit_usd: number | null;
  bot_profit_amount?: string;
  bot_profit_token?: string;
  bot_ens?: string;
  explorer_base: string;
  block_timestamp?: string;
}


interface Data {
  updated_at: string;
  scan_blocks: number;
  total_arbitrage_txs: number;
  relay_blocks: RelayBlock[];
  transactions: Transaction[];
  sandwiches?: Sandwich[];
  chain?: string;
}

// ─── Helpers ───

const OSS_BASE =
  process.env.NEXT_PUBLIC_OSS_BASE ||
  "https://mev-explorer-data.oss-ap-southeast-1.aliyuncs.com";

function dataUrlForChain(chain: ChainId) {
  return `${OSS_BASE}/${chain}/data.json`;
}

function historyUrlForChain(chain: ChainId) {
  return `${OSS_BASE}/${chain}/sandwich-history.json`;
}

type TimeFrame = "all" | "1d" | "7d" | "14d" | "30d" | "3m";
const TIMEFRAMES: { id: TimeFrame; label: string; ms: number }[] = [
  { id: "all", label: "All", ms: 0 },
  { id: "1d", label: "1D", ms: 1 * 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7D", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "14d", label: "14D", ms: 14 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30D", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "3m", label: "3M", ms: 90 * 24 * 60 * 60 * 1000 },
];

const TIMEZONES: { value: string; label: string; short: string }[] = [
  { value: "UTC", label: "UTC", short: "UTC" },
  { value: "America/New_York", label: "Eastern (ET)", short: "ET" },
  { value: "America/Chicago", label: "Central (CT)", short: "CT" },
  { value: "America/Los_Angeles", label: "Pacific (PT)", short: "PT" },
  { value: "Europe/London", label: "London (GMT/BST)", short: "GMT" },
  { value: "Europe/Berlin", label: "Central Europe (CET)", short: "CET" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)", short: "JST" },
  { value: "Asia/Shanghai", label: "China (CST)", short: "CST" },
  { value: "Asia/Singapore", label: "Singapore (SGT)", short: "SGT" },
  { value: "Asia/Kuala_Lumpur", label: "Malaysia (MYT)", short: "MYT" },
  { value: "Asia/Dubai", label: "Dubai (GST)", short: "GST" },
  { value: "Australia/Sydney", label: "Sydney (AEST)", short: "AEST" },
];

function dateInTz(date: Date, tz: string) {
  return new Date(date.toLocaleString("en-US", { timeZone: tz }));
}

function formatDateTz(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dateBucketKey(iso: string, tz: string, hourly: boolean): string {
  const d = new Date(iso);
  const locStr = d.toLocaleString("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const m = locStr.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+)/);
  if (!m) return iso;
  const [, mo, dd, yr, hh] = m;
  return hourly
    ? `${yr}-${mo}-${dd} ${hh}:00`
    : `${yr}-${mo}-${dd}`;
}

function truncHash(hash: string) {
  if (hash.length > 20)
    return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
  return hash;
}

function truncAddr(addr: string, head = 6, tail = 4) {
  if (!addr || addr.length < head + tail + 2) return addr || "—";
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  const prefix = value < 0 ? "-" : "";
  if (abs >= 1000)
    return `${prefix}$${abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `${prefix}$${abs.toFixed(2)}`;
  return `${prefix}$${abs.toFixed(4)}`;
}


// ─── Shared Components ───

const CHAIN_TAB_OPTIONS: { id: ChainId; label: string }[] = [
  { id: "all", label: "All Chains" },
  ...CHAINS.map((c) => ({ id: c.id, label: c.label })),
];

const CHAIN_NAV_ITEMS: {
  id: ChainId;
  label: string;
  color: string;
  logo?: string;
}[] = [
  { id: "all", label: "All", color: "#d4a017" },
  { id: "eth", label: "ETH", color: "#627eea", logo: "/chains/eth.png" },
  { id: "bsc", label: "BNB", color: "#f0b90b", logo: "/chains/bsc.png" },
  { id: "sol", label: "SOL", color: "#9945ff", logo: "/chains/sol.png" },
];

function BottomNav({
  active,
  onChange,
}: {
  active: ChainId;
  onChange: (c: ChainId) => void;
}) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-[var(--color-border)]" style={{ background: "rgba(9,9,11,0.95)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
      <div className="max-w-screen-lg mx-auto flex">
        {CHAIN_NAV_ITEMS.map((item) => {
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={`flex-1 flex flex-col items-center gap-[3px] pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-all duration-200 cursor-pointer relative ${
                isActive ? "text-[var(--color-text)]" : "text-[rgba(255,255,255,0.35)]"
              }`}
            >
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-[2px] rounded-full bg-[var(--color-text)] transition-all duration-300" />
              )}
              {item.logo ? (
                <img
                  src={item.logo}
                  alt={item.label}
                  className={`w-[20px] h-[20px] rounded-full transition-opacity duration-200 ${isActive ? "opacity-100" : "opacity-30 grayscale"}`}
                />
              ) : (
                <svg className="w-[20px] h-[20px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="4" y1="7" x2="20" y2="7" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="17" x2="20" y2="17" />
                </svg>
              )}
              <span className={`text-[9px] sm:text-[10px] tracking-wide transition-all duration-200 ${isActive ? "font-semibold" : "font-medium"}`}>
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0 text-center bg-[var(--color-surface)] rounded-lg px-3 py-3 sm:px-4 sm:py-4">
      <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] mb-1 truncate">
        {label}
      </div>
      <div
        className="text-[18px] sm:text-[22px] font-semibold leading-none tabular-nums truncate"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] sm:text-[11px] text-[var(--color-text-secondary)] mt-1 truncate">
          {sub}
        </div>
      )}
    </div>
  );
}

function DexBadge({ name }: { name: string }) {
  const isV3 = name.includes("V3") || name.includes("CLMM") || name.includes("Whirlpool");
  return (
    <span
      className="inline-block text-[10px] font-medium tracking-wide px-[6px] py-[2px] rounded-[3px] mr-1 mb-0.5"
      style={{
        background: isV3 ? "#1a2a1a" : "#2a1a1a",
        color: isV3 ? "#6ab88a" : "#c8885a",
      }}
    >
      {name}
    </span>
  );
}


function formatTokenAmount(raw?: string, formatted?: string, compact?: boolean): string {
  if (formatted) {
    const n = Number(formatted);
    if (!isNaN(n) && isFinite(n)) {
      if (compact) {
        const abs = Math.abs(n);
        if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
        if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
        if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
        if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
      }
      if (Math.abs(n) >= 1e6) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
      if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
      if (Math.abs(n) >= 0.0001) return n.toFixed(6);
      return n.toExponential(2);
    }
    return formatted;
  }
  if (!raw) return "?";
  const n = Number(raw);
  if (!isNaN(n) && isFinite(n)) {
    if (compact) {
      const abs = Math.abs(n);
      if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
      if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
    }
    if (Math.abs(n) < 0.0001) return n.toExponential(2);
    if (Math.abs(n) >= 1e6) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return n.toFixed(6);
  }
  return raw.length > 12 ? `${raw.slice(0, 10)}...` : raw;
}

function SandwichFlowStep({
  role,
  label,
  address,
  tokenInSymbol,
  amountIn,
  amountInFormatted,
  tokenOutSymbol,
  amountOut,
  amountOutFormatted,
  txHash,
  chain,
}: {
  role: "bot-entry" | "bot-exit" | "victim";
  label: string;
  address: string;
  tokenInSymbol?: string;
  amountIn?: string;
  amountInFormatted?: string;
  tokenOutSymbol?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  txHash: string;
  chain: ChainConfig;
}) {
  const borderColor =
    role === "victim"
      ? "var(--color-negative)"
      : "var(--color-positive)";
  const bgColor =
    role === "victim"
      ? "rgba(220,60,60,0.06)"
      : "rgba(60,180,100,0.06)";
  const roleIcon = role === "victim" ? "VICTIM" : "BOT";

  return (
    <div
      className="px-2.5 sm:px-3 py-2 sm:py-2.5 rounded-[4px]"
      style={{ borderLeft: `3px solid ${borderColor}`, background: bgColor }}
    >
      {/* Row 1: Role badge + label + tx link */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <span
            className="text-[8px] sm:text-[9px] font-bold tracking-wider px-1 sm:px-1.5 py-0.5 rounded-[3px] shrink-0"
            style={{
              background: role === "victim" ? "rgba(220,60,60,0.15)" : "rgba(60,180,100,0.15)",
              color: borderColor,
            }}
          >
            {roleIcon}
          </span>
          <span className="text-[10px] sm:text-[11px] text-[var(--color-text-secondary)]">
            {label}
          </span>
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-dim)] hidden sm:inline">
            {truncAddr(address, 6, 4)}
          </span>
        </div>
        <a
          href={`${chain.explorerTxUrl}${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-[family-name:var(--font-mono)] text-[9px] sm:text-[10px] text-[var(--color-text-dim)] hover:text-[var(--color-accent)] transition-colors shrink-0"
        >
          {truncHash(txHash)} ↗
        </a>
      </div>

      {/* Row 2: Address (mobile only) */}
      <div className="sm:hidden mb-1">
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-dim)]">
          {truncAddr(address, 6, 4)}
        </span>
      </div>

      {/* Row 3: Swap flow — stacked on mobile, inline on desktop */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-1 text-[11px] sm:text-[12px]">
        <div className="flex items-center gap-1 min-w-0">
          <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--color-text)] truncate">
            {formatTokenAmount(amountIn, amountInFormatted, true)}
          </span>
          <span className="text-[var(--color-text-secondary)] text-[10px] sm:text-[11px] shrink-0">
            {tokenInSymbol || "???"}
          </span>
        </div>
        <span className="text-[var(--color-text-dim)] mx-0.5 shrink-0 self-start sm:self-auto">→</span>
        <div className="flex items-center gap-1 min-w-0">
          <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--color-text)] truncate">
            {formatTokenAmount(amountOut, amountOutFormatted, true)}
          </span>
          <span className="text-[var(--color-text-secondary)] text-[10px] sm:text-[11px] shrink-0">
            {tokenOutSymbol || "???"}
          </span>
        </div>
      </div>
    </div>
  );
}

function SandwichCard({
  sw,
  chain,
  isExpanded,
  onToggle,
  showChainBadge,
  tz,
}: {
  sw: Sandwich & { chainId?: string };
  chain: ChainConfig;
  isExpanded: boolean;
  onToggle: () => void;
  showChainBadge?: boolean;
  tz: string;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-[6px] mb-2 sm:mb-3 overflow-hidden card-hover">
      {/* Header — clickable */}
      <div
        className="px-2.5 sm:px-4 py-2.5 sm:py-3 cursor-pointer hover:bg-[var(--color-surface)] transition-all duration-200"
        onClick={onToggle}
      >
        {/* Top row: badge + block + dex + profit */}
        <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <span className="text-[9px] sm:text-[10px] font-bold tracking-wider px-1 sm:px-1.5 py-0.5 rounded-[3px] bg-[rgba(220,60,60,0.12)] text-[var(--color-negative)] shrink-0">
              SANDWICH
            </span>
            {showChainBadge && sw.chainId && (
              <span className="text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-medium shrink-0">
                {CHAINS.find(c => c.id === sw.chainId)?.label ?? sw.chainId}
              </span>
            )}
            <span className="font-[family-name:var(--font-mono)] text-[11px] sm:text-[12px] text-[var(--color-text-secondary)] tabular-nums">
              #{sw.block_number}
            </span>
            <DexBadge name={sw.dex} />
          </div>
          <div className="text-right shrink-0">
            <span
              className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums"
              style={{ color: sw.bot_profit_usd != null ? (sw.bot_profit_usd >= 0 ? "var(--color-positive)" : "var(--color-negative)") : "var(--color-text-dim)" }}
            >
              {sw.bot_profit_usd != null ? formatUsd(sw.bot_profit_usd) : "N/A"}
            </span>
            {sw.bot_profit_token && sw.bot_profit_amount && (
              <div className="text-[9px] sm:text-[10px] text-[var(--color-text-dim)] mt-0.5 font-[family-name:var(--font-mono)] tabular-nums">
                +{formatTokenAmount(sw.bot_profit_amount)} {sw.bot_profit_token}
              </div>
            )}
          </div>
        </div>

        {/* Bottom row: bot address + victim count + expand hint */}
        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 text-[10px] sm:text-[11px]">
          <span className="text-[var(--color-text-dim)]">
            Bot: {sw.bot_ens ? (
              <span className="text-[var(--color-accent)]">{sw.bot_ens}</span>
            ) : (
              <span className="font-[family-name:var(--font-mono)]">{truncAddr(sw.bot_address, 6, 4)}</span>
            )}
          </span>
          <span className="text-[var(--color-negative)]">
            {sw.victims.length} victim{sw.victims.length !== 1 ? "s" : ""}
          </span>
          {sw.block_timestamp && (
            <span className="text-[var(--color-text-dim)] font-[family-name:var(--font-mono)] tabular-nums">
              {formatDateTz(sw.block_timestamp, tz)}
            </span>
          )}
          <span className="text-[var(--color-text-dim)]">
            {isExpanded ? "▾" : "▸"} details
          </span>
        </div>
      </div>

      {/* Expanded flow visualization */}
      {isExpanded && (
        <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-1 bg-[var(--color-surface)] expand-content">
          <div className="flex flex-col gap-1 sm:gap-1.5">
            <SandwichFlowStep
              role="bot-entry"
              label="Entry"
              address={sw.bot_address}
              tokenInSymbol={sw.entry_tx.token_in_symbol}
              amountIn={sw.entry_tx.amount_in}
              amountInFormatted={sw.entry_tx.amount_in_formatted}
              tokenOutSymbol={sw.entry_tx.token_out_symbol}
              amountOut={sw.entry_tx.amount_out}
              amountOutFormatted={sw.entry_tx.amount_out_formatted}
              txHash={sw.entry_tx.tx_hash}
              chain={chain}
            />

            {sw.victims.map((v, i) => (
              <SandwichFlowStep
                key={v.tx_hash}
                role="victim"
                label={sw.victims.length > 1 ? `Victim ${i + 1}` : "Victim"}
                address={v.from_address}
                tokenInSymbol={v.token_in_symbol}
                amountIn={v.amount_in}
                amountInFormatted={v.amount_in_formatted}
                tokenOutSymbol={v.token_out_symbol}
                amountOut={v.amount_out}
                amountOutFormatted={v.amount_out_formatted}
                txHash={v.tx_hash}
                chain={chain}
              />
            ))}

            <SandwichFlowStep
              role="bot-exit"
              label="Exit"
              address={sw.bot_address}
              tokenInSymbol={sw.exit_tx.token_in_symbol}
              amountIn={sw.exit_tx.amount_in}
              amountInFormatted={sw.exit_tx.amount_in_formatted}
              tokenOutSymbol={sw.exit_tx.token_out_symbol}
              amountOut={sw.exit_tx.amount_out}
              amountOutFormatted={sw.exit_tx.amount_out_formatted}
              txHash={sw.exit_tx.tx_hash}
              chain={chain}
            />
          </div>

          {/* Profit summary */}
          {sw.bot_profit_usd != null && (
            <div className="mt-2 sm:mt-3 pt-2 sm:pt-2.5 border-t border-[var(--color-border)] flex items-center justify-between">
              <span className="text-[10px] sm:text-[11px] text-[var(--color-text-dim)] uppercase tracking-wide">
                Bot Profit
              </span>
              <div className="text-right flex items-baseline gap-1.5 sm:gap-2">
                <span
                  className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums"
                  style={{ color: (sw.bot_profit_usd ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}
                >
                  {formatUsd(sw.bot_profit_usd)}
                </span>
                {sw.bot_profit_token && sw.bot_profit_amount && (
                  <span className="text-[10px] sm:text-[11px] text-[var(--color-text-secondary)] font-[family-name:var(--font-mono)] tabular-nums">
                    ({formatTokenAmount(sw.bot_profit_amount)} {sw.bot_profit_token})
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Pagination helpers ───

function PagerBtn({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-w-[28px] h-7 px-1.5 text-[12px] rounded-[3px] tabular-nums transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default ${
        active
          ? "bg-[var(--color-accent)] text-[var(--color-bg)] font-medium"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );
}

function pageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "...")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) pages.push("...");
  for (let i = left; i <= right; i++) pages.push(i);
  if (right < total - 1) pages.push("...");
  pages.push(total);
  return pages;
}

// ─── Main Page ───

export default function Page() {
  const [chain, setChain] = useState<ChainId>("all");
  const [allChainData, setAllChainData] = useState<Record<string, Data | null>>({ eth: null, bsc: null, sol: null });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [chartTf, setChartTf] = useState<TimeFrame>("all");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [historyData, setHistoryData] = useState<Record<string, Sandwich[]>>({ eth: [], bsc: [], sol: [] });
  const PAGE_SIZE = 20;

  const chainConfig = chain === "all" ? null : CHAINS.find((c) => c.id === chain)!;
  const RAW_CHAINS: ("eth" | "bsc" | "sol")[] = ["eth", "bsc", "sol"];

  const [historyLoaded, setHistoryLoaded] = useState(false);

  // localStorage cache helpers
  const CACHE_KEY_DATA = "mev_cache_data";
  const CACHE_KEY_HISTORY = "mev_cache_history";
  const CACHE_TTL = 60_000;

  useEffect(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY_DATA);
      if (cached) {
        const { ts, data } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL) setAllChainData(data);
      }
      const cachedH = localStorage.getItem(CACHE_KEY_HISTORY);
      if (cachedH) {
        const { ts, data } = JSON.parse(cachedH);
        if (Date.now() - ts < CACHE_TTL) { setHistoryData(data); setHistoryLoaded(true); }
      }
    } catch {}
  }, []);

  const loadAll = useCallback(async () => {
    const results = await Promise.allSettled(
      RAW_CHAINS.map(async (c) => {
        const res = await fetch(dataUrlForChain(c) + "?" + Date.now());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { chain: c, data: (await res.json()) as Data };
      })
    );
    const next: Record<string, Data | null> = { eth: null, bsc: null, sol: null };
    for (const r of results) {
      if (r.status === "fulfilled") next[r.value.chain] = r.value.data;
    }
    setAllChainData(next);
    try { localStorage.setItem(CACHE_KEY_DATA, JSON.stringify({ ts: Date.now(), data: next })); } catch {}
  }, []);

  const loadHistory = useCallback(async () => {
    const results = await Promise.allSettled(
      RAW_CHAINS.map(async (c) => {
        const res = await fetch(historyUrlForChain(c) + "?" + Date.now());
        if (!res.ok) return { chain: c, data: [] as Sandwich[] };
        return { chain: c, data: (await res.json()) as Sandwich[] };
      })
    );
    const next: Record<string, Sandwich[]> = { eth: [], bsc: [], sol: [] };
    for (const r of results) {
      if (r.status === "fulfilled") next[r.value.chain] = r.value.data;
    }
    setHistoryData(next);
    setHistoryLoaded(true);
    try { localStorage.setItem(CACHE_KEY_HISTORY, JSON.stringify({ ts: Date.now(), data: next })); } catch {}
  }, []);

  useEffect(() => {
    setLoading(true);
    setExpanded(null);
    setSearch("");
    setPage(1);
    Promise.all([loadAll(), loadHistory()]).then(() => setLoading(false));
  }, [loadAll, loadHistory]);

  useEffect(() => {
    setExpanded(null);
    setSearch("");
    setPage(1);
  }, [chain]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadAll, 15_000);
    const hid = setInterval(loadHistory, 60_000);
    return () => { clearInterval(id); clearInterval(hid); };
  }, [autoRefresh, loadAll, loadHistory]);

  const toggle = useCallback(
    (hash: string) => setExpanded((v) => (v === hash ? null : hash)),
    []
  );

  const chartData = useMemo(() => {
    const historyChains = chain === "all" ? RAW_CHAINS : [chain as "eth" | "bsc" | "sol"];
    const allHistory = historyChains.flatMap(
      (c) => (historyData[c] ?? []).filter((sw) => {
        const p = sw.bot_profit_usd ?? 0;
        return p >= -10 && p <= 1000 && sw.block_timestamp;
      })
    );
    const tfConfig = TIMEFRAMES.find((t) => t.id === chartTf)!;
    const cutoff = tfConfig.ms > 0 ? Date.now() - tfConfig.ms : 0;
    const filtered = allHistory.filter(
      (sw) => new Date(sw.block_timestamp!).getTime() > cutoff
    );
    filtered.sort(
      (a, b) => new Date(a.block_timestamp!).getTime() - new Date(b.block_timestamp!).getTime()
    );

    const buckets = new Map<string, { date: string; profit: number; count: number }>();
    for (const sw of filtered) {
      const key = dateBucketKey(sw.block_timestamp!, tz, chartTf === "1d");
      const existing = buckets.get(key) || { date: key, profit: 0, count: 0 };
      existing.profit += sw.bot_profit_usd ?? 0;
      existing.count += 1;
      buckets.set(key, existing);
    }

    let cumulative = 0;
    return Array.from(buckets.values()).map((b) => {
      cumulative += b.profit;
      return { ...b, profit: Math.round(b.profit * 100) / 100, cumulative: Math.round(cumulative * 100) / 100 };
    });
  }, [historyData, chartTf, chain, tz]);

  const hasAnyData = RAW_CHAINS.some((c) => allChainData[c] !== null) && historyLoaded;

  if (loading || !hasAnyData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 pb-16">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
        <BottomNav active={chain} onChange={setChain} />
      </div>
    );
  }

  if (!hasAnyData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 pb-16">
        <div className="text-[var(--color-negative)] text-sm">
          No data available. Crawlers may not be running yet.
        </div>
        <BottomNav active={chain} onChange={setChain} />
      </div>
    );
  }

  const dateFromMs = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : 0;
  const dateToMs = dateTo ? new Date(dateTo + "T23:59:59").getTime() : Infinity;

  const hasDateFilter = dateFrom !== "" || dateTo !== "";
  const profitFilter = (sw: Sandwich) => {
    const p = sw.bot_profit_usd ?? 0;
    if (p < -10 || p > 1000) return false;
    if (hasDateFilter) {
      if (!sw.block_timestamp) return false;
      const t = new Date(sw.block_timestamp).getTime();
      if (isNaN(t)) return false;
      if (t < dateFromMs || t > dateToMs) return false;
    }
    return true;
  };

  const chainsToShow = chain === "all" ? RAW_CHAINS : [chain as "eth" | "bsc" | "sol"];
  const sandwiches: (Sandwich & { chainId?: string })[] = (() => {
    const seen = new Set<string>();
    const all: (Sandwich & { chainId?: string })[] = [];
    for (const c of chainsToShow) {
      const live = (allChainData[c]?.sandwiches ?? []).filter(profitFilter);
      for (const sw of live) {
        const key = sw.entry_tx?.tx_hash;
        if (key && !seen.has(key)) { seen.add(key); all.push({ ...sw, chainId: c }); }
      }
      const hist = (historyData[c] ?? []).filter(profitFilter);
      for (const sw of hist) {
        const key = sw.entry_tx?.tx_hash;
        if (key && !seen.has(key)) { seen.add(key); all.push({ ...sw, chainId: c }); }
      }
    }
    all.sort((a, b) => {
      const ta = a.block_timestamp ? new Date(a.block_timestamp).getTime() : 0;
      const tb = b.block_timestamp ? new Date(b.block_timestamp).getTime() : 0;
      return tb - ta;
    });
    return all;
  })();

  const totalSandwichProfit = sandwiches.reduce(
    (s, sw) => s + (sw.bot_profit_usd ?? 0),
    0
  );
  const totalVictims = sandwiches.reduce((s, sw) => s + sw.victims.length, 0);
  const totalBlocks = chainsToShow.reduce((s, c) => s + (allChainData[c]?.scan_blocks ?? 0), 0);

  const q = search.trim().toLowerCase();

  const filteredSandwich = q
    ? sandwiches.filter(
        (sw) =>
          sw.bot_address.toLowerCase().includes(q) ||
          sw.entry_tx.tx_hash.toLowerCase().includes(q) ||
          sw.exit_tx.tx_hash.toLowerCase().includes(q) ||
          sw.block_number.toString().includes(q) ||
          sw.dex.toLowerCase().includes(q) ||
          (sw.chainId ?? "").toLowerCase().includes(q) ||
          sw.victims.some(
            (v) =>
              v.from_address.toLowerCase().includes(q) ||
              v.tx_hash.toLowerCase().includes(q)
          )
      )
    : sandwiches;

  const totalPages = Math.max(1, Math.ceil(filteredSandwich.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedSandwiches = filteredSandwich.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  const blockLabel = chain === "sol" ? "slots" : chain === "all" ? "blocks/slots" : "blocks";

  const top10Trades = [...sandwiches]
    .filter((sw) => sw.bot_profit_usd !== null && sw.bot_profit_usd > 0)
    .sort((a, b) => (b.bot_profit_usd ?? 0) - (a.bot_profit_usd ?? 0))
    .slice(0, 10);

  return (
    <div className="min-h-screen px-3 py-6 sm:px-6 sm:py-8 md:px-8 lg:px-16 max-w-[1440px] mx-auto page-content">
      {/* Header */}
      <header className="mb-6 sm:mb-10">
        <div className="flex items-center justify-between gap-2 mb-3 sm:mb-0">
          <div className="flex items-center gap-3 sm:gap-4">
            <div>
              <h1 className="text-[14px] sm:text-[15px] font-semibold tracking-tight leading-none">
                MEV Scanner
              </h1>
              <p className="text-[10px] sm:text-[11px] text-[var(--color-text-dim)] mt-1 sm:mt-1.5 tracking-wide">
                Sandwich attacks {chain === "all" ? "across all chains" : `on ${chainConfig!.label}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="flex items-center gap-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[4px] px-1.5 py-1">
              <svg className="w-3 h-3 text-[var(--color-text-dim)] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M1.5 8h13M8 1.5C6 3.5 5.2 5.6 5.2 8s.8 4.5 2.8 6.5M8 1.5c2 2 2.8 4.1 2.8 6.5s-.8 4.5-2.8 6.5" />
              </svg>
              <select
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                className="bg-[var(--color-surface)] text-[10px] sm:text-[11px] text-[var(--color-text)] focus:outline-none cursor-pointer [color-scheme:dark] appearance-auto max-w-[80px] sm:max-w-none"
                style={{ colorScheme: "dark" }}
              >
                {TIMEZONES.map((t) => (
                  <option key={t.value} value={t.value} style={{ background: "#111113", color: "#d4d4d8" }}>
                    {t.short}
                  </option>
                ))}
              </select>
            </div>
            {autoRefresh && (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-positive)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-positive)] animate-pulse" />
                <span className="hidden sm:inline">Live</span>
              </span>
            )}
            <span className="text-[11px] text-[var(--color-text-dim)] hidden sm:inline">
              {timeAgo(
                RAW_CHAINS
                  .map((c) => allChainData[c]?.updated_at)
                  .filter(Boolean)
                  .sort()
                  .pop() ?? new Date().toISOString()
              )}
            </span>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`text-[11px] font-medium transition-colors cursor-pointer ${
                autoRefresh
                  ? "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  : "text-[var(--color-accent)] hover:text-[var(--color-text)]"
              }`}
            >
              {autoRefresh ? "Pause" : "Resume"}
            </button>
            <button
              onClick={loadAll}
              className="text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* MEV Stats — follows current chain + date/profit filter */}
      <section className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)] animate-fade-in" style={{ animationDelay: "50ms" }}>
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)] mb-4">
          MEV Stats {chain !== "all" && <span className="normal-case">— {chainConfig!.label}</span>}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-5">
          {[
            { label: "Average Profit", value: sandwiches.length > 0 ? formatUsd(totalSandwichProfit / sandwiches.length) : "—", color: "var(--color-positive)" },
            { label: "Total Profit", value: sandwiches.length > 0 ? formatUsd(totalSandwichProfit) : "—", color: "var(--color-positive)" },
            { label: "Transactions Count", value: sandwiches.length.toLocaleString(), color: "var(--color-accent)" },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-[10px] px-4 py-4 sm:p-5 text-center"
              style={{
                background: "linear-gradient(168deg, #1a1a1f 0%, #131315 60%, #0f0f12 100%)",
                borderTop: "1px solid rgba(255,255,255,0.07)",
                borderLeft: "1px solid rgba(255,255,255,0.04)",
                borderRight: "1px solid rgba(255,255,255,0.02)",
                borderBottom: "1px solid rgba(255,255,255,0.01)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)",
              }}
            >
              <div className="text-[10px] sm:text-[11px] text-[var(--color-text-dim)] uppercase tracking-wide mb-1.5">
                {card.label}
              </div>
              <div className="font-[family-name:var(--font-mono)] text-[20px] sm:text-[22px] font-bold tabular-nums" style={{ color: card.color }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Per-Chain Breakdown (only in All view) */}
      {chain === "all" && (
        <section className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)] mb-4">
            Per-Chain Stats
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {RAW_CHAINS.map((c) => {
              const chainCfg = CHAINS.find((ch) => ch.id === c)!;
              const seen = new Set<string>();
              const chainSw: Sandwich[] = [];
              for (const sw of (allChainData[c]?.sandwiches ?? []).filter(profitFilter)) {
                const key = sw.entry_tx?.tx_hash;
                if (key && !seen.has(key)) { seen.add(key); chainSw.push(sw); }
              }
              for (const sw of (historyData[c] ?? []).filter(profitFilter)) {
                const key = sw.entry_tx?.tx_hash;
                if (key && !seen.has(key)) { seen.add(key); chainSw.push(sw); }
              }
              const chainProfit = chainSw.reduce((s, sw) => s + (sw.bot_profit_usd ?? 0), 0);
              const chainBlocks = allChainData[c]?.scan_blocks ?? 0;
              return (
                <div
                  key={c}
                  className="bg-[var(--color-surface)] rounded-lg px-4 py-3 sm:p-4 cursor-pointer hover:border-[var(--color-accent)] border border-[var(--color-border)] transition-colors"
                  onClick={() => setChain(c)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] sm:text-[12px] font-medium text-[var(--color-text)]">
                      {chainCfg.label}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-dim)]">
                      {chainBlocks} {c === "sol" ? "slots" : "blocks"}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-[9px] text-[var(--color-text-dim)] uppercase">Txns</div>
                      <div className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums text-[var(--color-text)]">
                        {chainSw.length}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[var(--color-text-dim)] uppercase">Profit</div>
                      <div className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums text-[var(--color-positive)]">
                        {chainSw.length > 0 ? formatUsd(chainProfit) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] text-[var(--color-text-dim)] uppercase">Avg</div>
                      <div className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums text-[var(--color-positive)]">
                        {chainSw.length > 0 ? formatUsd(chainProfit / chainSw.length) : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Profit Chart */}
      <section className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
            Profit Over Time
          </h2>
          <div className="flex gap-1 p-0.5 bg-[var(--color-surface)] rounded-[5px]">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setChartTf(tf.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-[4px] transition-colors cursor-pointer ${
                  chartTf === tf.id
                    ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
        {chartData.length > 0 ? (
          <div className="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: string) => {
                    if (v.includes(":")) return v.split(" ")[1];
                    const parts = v.split("-");
                    return `${parts[1]}/${parts[2]}`;
                  }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}`}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(15,15,20,0.95)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "6px",
                    fontSize: "11px",
                    color: "#fff",
                  }}
                  formatter={(value: unknown, name: unknown) => [
                    `$${Number(value).toFixed(2)}`,
                    name === "cumulative" ? "Cumulative" : "Profit",
                  ]}
                  labelFormatter={(label: unknown) => `Date: ${label}`}
                />
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#22c55e"
                  strokeWidth={2}
                  fill="url(#profitGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#22c55e" }}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2 text-[10px] text-[var(--color-text-dim)]">
              <span>{chartData.length} data points</span>
              <span>Total: {formatUsd(chartData[chartData.length - 1]?.cumulative ?? 0)}</span>
            </div>
          </div>
        ) : (
          <div className="bg-[var(--color-surface)] rounded-lg p-8 text-center text-[var(--color-text-dim)] text-sm">
            No historical data yet. Chart will populate as crawlers collect data over time.
          </div>
        )}
      </section>

      {/* Top 10 Trades */}
      {top10Trades.length > 0 && (
        <section className="mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)] mb-4">
            Top Trades
          </h2>
          <div className="bg-[var(--color-surface)] rounded-lg overflow-hidden">
            {top10Trades.map((sw, i) => {
              const chainCfg = CHAINS.find((c) => c.id === sw.chainId) ?? (chainConfig || CHAINS[0]);
              return (
                <div
                  key={sw.entry_tx.tx_hash + "-" + i}
                  className={`px-3 sm:px-4 py-3 ${i < top10Trades.length - 1 ? "border-b border-[var(--color-border)]" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <span className="text-[11px] font-medium text-[var(--color-text-dim)] shrink-0">
                        #{i + 1}
                      </span>
                      <span className="text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-medium shrink-0">
                        {chainCfg.label}
                      </span>
                      <a
                        href={`${chainCfg.explorerTxUrl}${sw.entry_tx.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors truncate"
                      >
                        {truncHash(sw.entry_tx.tx_hash)}
                      </a>
                    </div>
                    <div className={`font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums shrink-0`} style={{ color: (sw.bot_profit_usd ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
                      {formatUsd(sw.bot_profit_usd ?? 0)}
                    </div>
                  </div>
                  {sw.bot_profit_amount && sw.bot_profit_token && (
                    <div className="hidden sm:flex mt-1 ml-[calc(1ch+2rem)] text-[11px] text-[var(--color-text-dim)] font-[family-name:var(--font-mono)] tabular-nums">
                      {sw.bot_profit_amount} {sw.bot_profit_token}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-[var(--color-text-dim)] mt-2 text-center">
            Top 10 trades (by profit)
          </p>
        </section>
      )}

      {/* Current View Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
        <Stat
          label="Sandwich Attacks"
          value={sandwiches.length}
          sub={`from ${totalBlocks} ${blockLabel}`}
        />
        <Stat
          label="Bot Profit"
          value={sandwiches.length > 0 ? formatUsd(totalSandwichProfit) : "—"}
          sub={`${sandwiches.filter(s => (s.bot_profit_usd ?? 0) > 0).length} profitable`}
          color={totalSandwichProfit >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
        />
        <Stat
          label="Victims"
          value={totalVictims}
          sub={`across ${sandwiches.length} attacks`}
        />
        <Stat
          label="Avg Profit"
          value={sandwiches.length > 0 ? formatUsd(totalSandwichProfit / sandwiches.length) : "—"}
          sub="per sandwich"
          color={totalSandwichProfit > 0 ? "var(--color-positive)" : undefined}
        />
      </section>

      {/* Sandwich List */}
      <section>
        <div className="flex flex-col gap-2.5 sm:gap-0 sm:flex-row sm:items-center justify-between mb-3 sm:mb-4">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
            Sandwich Attacks
            {q && (
              <span className="normal-case tracking-normal ml-2 text-[var(--color-text-dim)]">
                — {filteredSandwich.length} result{filteredSandwich.length !== 1 ? "s" : ""}
              </span>
            )}
          </h2>
          <div className="relative w-full sm:w-64">
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search bot, victim, hash..."
              className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[4px] px-3 py-1.5 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent-dim)] transition-colors font-[family-name:var(--font-mono)]"
            />
            {search && (
              <button
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-[14px] leading-none cursor-pointer"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4 overflow-x-auto">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[4px] px-2 py-1 text-[11px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent-dim)] transition-colors font-[family-name:var(--font-mono)] [color-scheme:dark] shrink-0"
          />
          <span className="text-[10px] text-[var(--color-text-dim)] shrink-0">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[4px] px-2 py-1 text-[11px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent-dim)] transition-colors font-[family-name:var(--font-mono)] [color-scheme:dark] shrink-0"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
              className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-text)] transition-colors cursor-pointer shrink-0"
            >
              ✕
            </button>
          )}
        </div>

        <div className="space-y-0">
          {pagedSandwiches.map((sw, i) => {
            const swChain = chain === "all"
              ? CHAINS.find((c) => c.id === sw.chainId) ?? CHAINS[0]
              : chainConfig!;
            return (
              <div key={sw.entry_tx.tx_hash + "-" + i} className="animate-fade-in" style={{ animationDelay: `${i * 30}ms` }}>
                <SandwichCard
                  sw={sw}
                  chain={swChain}
                  isExpanded={expanded === sw.entry_tx.tx_hash}
                  onToggle={() => toggle(sw.entry_tx.tx_hash)}
                  showChainBadge={chain === "all"}
                  tz={tz}
                />
              </div>
            );
          })}
        </div>
        {filteredSandwich.length === 0 && (
          <div className="text-center py-16 text-[var(--color-text-dim)] text-sm">
            {q ? `No results for "${q}"` : "No sandwich attacks found. Crawler may still be syncing."}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--color-border)]">
            <span className="text-[11px] text-[var(--color-text-dim)] tabular-nums">
              {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredSandwich.length)} of {filteredSandwich.length}
            </span>
            <div className="flex items-center gap-1">
              <PagerBtn
                label="‹"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              />
              {pageNumbers(safePage, totalPages).map((n, i) =>
                n === "..." ? (
                  <span key={`dot-${i}`} className="text-[11px] text-[var(--color-text-dim)] px-1">
                    ...
                  </span>
                ) : (
                  <PagerBtn
                    key={n}
                    label={String(n)}
                    active={n === safePage}
                    onClick={() => setPage(n as number)}
                  />
                )
              )}
              <PagerBtn
                label="›"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              />
            </div>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="mt-12 sm:mt-16 pb-20 text-[10px] text-[var(--color-text-dim)] border-t border-[var(--color-border)] pt-4">
        {chain === "all"
          ? "Cross-chain sandwich attack monitoring across Ethereum, BSC, and Solana."
          : chain === "eth"
            ? "On-chain Swap event scanning. Sandwich = same bot front-runs & back-runs victim swaps on the same pool within one block."
            : chain === "bsc"
              ? "On-chain Swap event scanning on BSC. Sandwich = same bot front-runs & back-runs victim swaps on the same pool."
              : "On-chain DEX instruction scanning on Solana. Sandwich = same signer brackets victim swaps in the same slot."}
      </footer>

      {/* Bottom Navigation */}
      <BottomNav active={chain} onChange={setChain} />
    </div>
  );
}
