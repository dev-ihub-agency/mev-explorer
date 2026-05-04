"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ───

type ChainId = "eth" | "bsc" | "sol";

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
  explorer_base: string;
}

type MevType = "arbitrage" | "sandwich";

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

function pnlColor(pnl: number | null) {
  if (pnl === null) return "var(--color-text-dim)";
  return pnl >= 0 ? "var(--color-positive)" : "var(--color-negative)";
}

// ─── Shared Components ───

function ChainTabs({
  active,
  onChange,
}: {
  active: ChainId;
  onChange: (c: ChainId) => void;
}) {
  return (
    <div className="flex gap-1 p-0.5 bg-[var(--color-surface)] rounded-[5px]">
      {CHAINS.map((c) => (
        <button
          key={c.id}
          onClick={() => onChange(c.id)}
          className={`px-3 py-1.5 text-[12px] font-medium rounded-[4px] transition-colors cursor-pointer ${
            active === c.id
              ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
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
    <div className="min-w-0">
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

function SwapDots({ count }: { count: number }) {
  const n = Math.min(count, 8);
  return (
    <span className="inline-flex items-center gap-[3px] ml-2">
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          className="w-[5px] h-[5px] rounded-full"
          style={{
            background:
              i < 2
                ? "var(--color-accent)"
                : i < 4
                  ? "var(--color-accent-dim)"
                  : "var(--color-text-dim)",
          }}
        />
      ))}
      {count > 8 && (
        <span className="text-[10px] text-[var(--color-text-dim)]">
          +{count - 8}
        </span>
      )}
    </span>
  );
}

function TypeTabs({
  active,
  onChange,
  arbCount,
  sandwichCount,
}: {
  active: MevType;
  onChange: (t: MevType) => void;
  arbCount: number;
  sandwichCount: number;
}) {
  const tabs: { id: MevType; label: string; count: number }[] = [
    { id: "sandwich", label: "Sandwich", count: sandwichCount },
    { id: "arbitrage", label: "Arbitrage", count: arbCount },
  ];
  return (
    <div className="flex gap-1 p-0.5 bg-[var(--color-surface)] rounded-[5px]">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-1.5 text-[12px] font-medium rounded-[4px] transition-colors cursor-pointer ${
            active === t.id
              ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          }`}
        >
          {t.label}
          <span className="ml-1 opacity-70 tabular-nums">({t.count})</span>
        </button>
      ))}
    </div>
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
}: {
  sw: Sandwich;
  chain: ChainConfig;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-[6px] mb-2 sm:mb-3 overflow-hidden">
      {/* Header — clickable */}
      <div
        className="px-2.5 sm:px-4 py-2.5 sm:py-3 cursor-pointer hover:bg-[var(--color-surface)] transition-colors"
        onClick={onToggle}
      >
        {/* Top row: badge + block + dex + profit */}
        <div className="flex items-start justify-between gap-2 mb-1.5 sm:mb-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
            <span className="text-[9px] sm:text-[10px] font-bold tracking-wider px-1 sm:px-1.5 py-0.5 rounded-[3px] bg-[rgba(220,60,60,0.12)] text-[var(--color-negative)] shrink-0">
              SANDWICH
            </span>
            <span className="font-[family-name:var(--font-mono)] text-[11px] sm:text-[12px] text-[var(--color-text-secondary)] tabular-nums">
              #{sw.block_number}
            </span>
            <DexBadge name={sw.dex} />
          </div>
          <div className="text-right shrink-0">
            <span
              className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold tabular-nums"
              style={{ color: sw.bot_profit_usd != null ? "var(--color-positive)" : "var(--color-text-dim)" }}
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
            Bot: <span className="font-[family-name:var(--font-mono)]">{truncAddr(sw.bot_address, 6, 4)}</span>
          </span>
          <span className="text-[var(--color-negative)]">
            {sw.victims.length} victim{sw.victims.length !== 1 ? "s" : ""}
          </span>
          <span className="text-[var(--color-text-dim)]">
            {isExpanded ? "▾" : "▸"} details
          </span>
        </div>
      </div>

      {/* Expanded flow visualization */}
      {isExpanded && (
        <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-1 bg-[var(--color-surface)]">
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
                  style={{ color: "var(--color-positive)" }}
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

function Detail({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
        {label}
      </span>
      <span
        className={`${mono ? "font-[family-name:var(--font-mono)]" : ""} text-[12px] text-[var(--color-text-secondary)] break-all leading-relaxed`}
      >
        {children}
      </span>
    </div>
  );
}

function ExternalLinks({
  tx,
  chain,
  className,
}: {
  tx: Transaction;
  chain: ChainConfig;
  className?: string;
}) {
  return (
    <span className={`inline-flex gap-3 text-[11px] ${className ?? ""}`}>
      <a
        href={`${chain.explorerTxUrl}${tx.tx_hash}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-[var(--color-text-dim)] hover:text-[var(--color-accent)] active:text-[var(--color-accent)] transition-colors"
      >
        {chain.explorerLabel} ↗
      </a>
      <a
        href={chain.secondaryExplorerUrl(tx.tx_hash)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-[var(--color-text-dim)] hover:text-[var(--color-accent)] active:text-[var(--color-accent)] transition-colors"
      >
        {chain.secondaryExplorerLabel} ↗
      </a>
    </span>
  );
}

function PnlBreakdown({ tx }: { tx: Transaction }) {
  if (tx.pnl_usd === null) return null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 mb-4 pb-3 border-b border-[var(--color-border)]">
      <div>
        <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
          Revenue
        </span>
        <div className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] mt-0.5 tabular-nums">
          {formatUsd(tx.revenue_usd)}
        </div>
      </div>
      <div className="text-[var(--color-text-dim)] self-end text-[13px]">−</div>
      <div>
        <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
          Gas Cost
        </span>
        <div className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] mt-0.5 tabular-nums">
          {formatUsd(tx.gas_cost_usd)}
        </div>
      </div>
      <div className="text-[var(--color-text-dim)] self-end text-[13px]">=</div>
      <div>
        <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
          Net PnL
        </span>
        <div
          className="font-[family-name:var(--font-mono)] text-[13px] sm:text-[14px] font-semibold mt-0.5 tabular-nums"
          style={{ color: pnlColor(tx.pnl_usd) }}
        >
          {formatUsd(tx.pnl_usd)}
        </div>
      </div>
      {tx.profit_token && (
        <div className="sm:ml-auto sm:text-right">
          <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
            Profit Token
          </span>
          <div className="text-[12px] sm:text-[13px] mt-0.5">
            <span className="font-[family-name:var(--font-mono)] tabular-nums">
              {tx.profit_token_amount?.toFixed(6)}
            </span>{" "}
            <span className="text-[var(--color-text-secondary)]">
              {tx.profit_token}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandedDetails({
  tx,
  chain,
}: {
  tx: Transaction;
  chain: ChainConfig;
}) {
  return (
    <div className="px-3 sm:px-5 py-4 bg-[var(--color-surface)]">
      <PnlBreakdown tx={tx} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3 text-[12px]">
        <div className="sm:col-span-2 lg:col-span-3">
          <Detail label="Transaction Hash" mono>
            {tx.tx_hash}
          </Detail>
        </div>
        <Detail label="From" mono>
          {tx.from_address || "—"}
        </Detail>
        {tx.to_address && (
          <Detail label="To (Contract)" mono>
            {tx.to_address}
          </Detail>
        )}
        <Detail label="Source">{tx.source}</Detail>
        <Detail label={chain.id === "sol" ? "Compute Units" : "Gas Used"}>
          {tx.gas_used.toLocaleString()}
        </Detail>
        {chain.id !== "sol" && (
          <Detail label="Gas Price">{tx.gas_price_gwei} Gwei</Detail>
        )}
        <Detail label={chain.id === "sol" ? "Fee" : "Gas Cost"}>
          {tx.gas_cost_eth.toFixed(6)} {chain.nativeSymbol}
        </Detail>
        {tx.pools && tx.pools.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3 mt-1">
            <span className="text-[10px] text-[var(--color-text-dim)] uppercase tracking-wide">
              Pools ({tx.pools.length})
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tx.pools.map((p, i) => (
                <a
                  key={i}
                  href={`${chain.explorerAddrUrl}${p}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] bg-[var(--color-surface-hover)] px-2 py-1 rounded-[3px] transition-colors"
                >
                  {truncAddr(p, 8, 6)}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mobile Card ───

function TxCard({
  tx,
  chain,
  isExpanded,
  onToggle,
}: {
  tx: Transaction;
  chain: ChainConfig;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-[var(--color-border)]">
      <div
        className="px-1 py-3 cursor-pointer active:bg-[var(--color-surface)] transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <span className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--color-text)]">
            {truncHash(tx.tx_hash)}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] text-[14px] font-semibold tabular-nums shrink-0"
            style={{ color: pnlColor(tx.pnl_usd) }}
          >
            {tx.pnl_usd !== null ? formatUsd(tx.pnl_usd) : "N/A"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] tabular-nums">
            #{tx.block_number}
          </span>
          <span className="inline-flex items-center text-[var(--color-text-secondary)]">
            {tx.swap_count ?? 0} swaps
            {tx.swap_count && <SwapDots count={tx.swap_count} />}
          </span>
          {tx.dex_list.map((d) => (
            <DexBadge key={d} name={d} />
          ))}
          <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-dim)] tabular-nums">
            gas {tx.gas_cost_usd !== null ? formatUsd(tx.gas_cost_usd) : "—"}
          </span>
          {tx.profit_token && (
            <span className="text-[var(--color-text-dim)]">
              {tx.profit_token}
            </span>
          )}
        </div>

        <div className="mt-2">
          <ExternalLinks tx={tx} chain={chain} />
        </div>
      </div>

      {isExpanded && <ExpandedDetails tx={tx} chain={chain} />}
    </div>
  );
}

// ─── Desktop Table Row ───

function TxRow({
  tx,
  chain,
  isExpanded,
  onToggle,
}: {
  tx: Transaction;
  chain: ChainConfig;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="group border-b border-[var(--color-border)] cursor-pointer transition-colors hover:bg-[var(--color-surface)]"
        onClick={onToggle}
      >
        <td className="py-3 pr-4">
          <span className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--color-text)] group-hover:text-[var(--color-accent)] transition-colors whitespace-nowrap">
            {truncHash(tx.tx_hash)}
          </span>
        </td>
        <td className="py-3 pr-4">
          <span className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--color-text-secondary)] tabular-nums">
            {tx.block_number}
          </span>
        </td>
        <td className="py-3 pr-4">
          <span className="inline-flex items-center">
            <span className="font-[family-name:var(--font-mono)] text-[13px] font-medium tabular-nums">
              {tx.swap_count ?? "—"}
            </span>
            {tx.swap_count && <SwapDots count={tx.swap_count} />}
          </span>
        </td>
        <td className="py-3 pr-4">
          {tx.dex_list.length > 0
            ? tx.dex_list.map((d) => <DexBadge key={d} name={d} />)
            : <span className="text-[var(--color-text-dim)]">—</span>}
        </td>
        <td className="py-3 pr-4 text-right">
          <span className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--color-text-secondary)] tabular-nums">
            {tx.gas_cost_usd !== null ? formatUsd(tx.gas_cost_usd) : "—"}
          </span>
        </td>
        <td className="py-3 pr-4 text-right">
          <span
            className="font-[family-name:var(--font-mono)] text-[13px] font-medium tabular-nums"
            style={{ color: pnlColor(tx.pnl_usd) }}
          >
            {tx.pnl_usd !== null ? formatUsd(tx.pnl_usd) : "N/A"}
          </span>
          {tx.profit_token && (
            <div className="text-[10px] text-[var(--color-text-dim)] mt-0.5">
              {tx.profit_token}
            </div>
          )}
        </td>
        <td className="py-3 text-right">
          <ExternalLinks tx={tx} chain={chain} />
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <ExpandedDetails tx={tx} chain={chain} />
          </td>
        </tr>
      )}
    </>
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
  const [chain, setChain] = useState<ChainId>("eth");
  const [mevType, setMevType] = useState<MevType>("sandwich");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const chainConfig = CHAINS.find((c) => c.id === chain)!;

  const load = useCallback(async () => {
    try {
      const url = dataUrlForChain(chain);
      const res = await fetch(url + "?" + Date.now());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: Data = await res.json();
      setData(json);
    } catch (e) {
      console.error("Failed to load data:", e);
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    setExpanded(null);
    setSearch("");
    setPage(1);
    setMevType("sandwich");
    load();
  }, [chain, load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const toggle = useCallback(
    (hash: string) => setExpanded((v) => (v === hash ? null : hash)),
    []
  );

  if (loading && !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <ChainTabs active={chain} onChange={setChain} />
        <div className="text-[var(--color-text-dim)] text-sm">Loading...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <ChainTabs active={chain} onChange={setChain} />
        <div className="text-[var(--color-negative)] text-sm">
          No data available for {chainConfig.label}. Crawler may not be running yet.
        </div>
      </div>
    );
  }

  const hasRelay = data.relay_blocks && data.relay_blocks.length > 0;
  const maxMev = hasRelay
    ? Math.max(...data.relay_blocks.map((b) => b.value_eth))
    : 0;
  const avgMev = hasRelay
    ? data.relay_blocks.reduce((s, b) => s + b.value_eth, 0) /
      data.relay_blocks.length
    : 0;

  const sandwiches = data.sandwiches ?? [];

  const pnlTxs = data.transactions.filter((t) => t.pnl_usd !== null);
  const totalPnl = pnlTxs.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const profitableTxs = pnlTxs.filter((t) => (t.pnl_usd ?? 0) > 0);

  const totalSandwichProfit = sandwiches.reduce(
    (s, sw) => s + (sw.bot_profit_usd ?? 0),
    0
  );
  const totalVictims = sandwiches.reduce((s, sw) => s + sw.victims.length, 0);

  const q = search.trim().toLowerCase();

  const filteredArb = q
    ? data.transactions.filter(
        (tx) =>
          tx.tx_hash.toLowerCase().includes(q) ||
          tx.from_address.toLowerCase().includes(q) ||
          (tx.to_address ?? "").toLowerCase().includes(q) ||
          tx.block_number.toString().includes(q) ||
          (tx.profit_token ?? "").toLowerCase().includes(q) ||
          tx.dex_list.some((d) => d.toLowerCase().includes(q))
      )
    : data.transactions;

  const filteredSandwich = q
    ? sandwiches.filter(
        (sw) =>
          sw.bot_address.toLowerCase().includes(q) ||
          sw.entry_tx.tx_hash.toLowerCase().includes(q) ||
          sw.exit_tx.tx_hash.toLowerCase().includes(q) ||
          sw.block_number.toString().includes(q) ||
          sw.dex.toLowerCase().includes(q) ||
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

  const blockLabel = chain === "sol" ? "slots" : "blocks";

  return (
    <div className="min-h-screen px-3 py-6 sm:px-6 sm:py-8 md:px-8 lg:px-16 max-w-[1440px] mx-auto">
      {/* Header */}
      <header className="mb-6 sm:mb-10">
        <div className="flex items-center justify-between gap-2 mb-3 sm:mb-0">
          <div className="flex items-center gap-3 sm:gap-4">
            <div>
              <h1 className="text-[14px] sm:text-[15px] font-semibold tracking-tight leading-none">
                MEV Scanner
              </h1>
              <p className="text-[10px] sm:text-[11px] text-[var(--color-text-dim)] mt-1 sm:mt-1.5 tracking-wide">
                Sandwich attacks on {chainConfig.label}
              </p>
            </div>
            <div className="hidden sm:block">
              <ChainTabs active={chain} onChange={setChain} />
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            {autoRefresh && (
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-positive)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-positive)] animate-pulse" />
                <span className="hidden sm:inline">Live</span>
              </span>
            )}
            <span className="text-[11px] text-[var(--color-text-dim)] hidden sm:inline">
              {timeAgo(data.updated_at)}
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
              onClick={load}
              className="text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
            >
              Refresh
            </button>
          </div>
        </div>
        {/* Chain tabs on mobile — full width row */}
        <div className="sm:hidden">
          <ChainTabs active={chain} onChange={setChain} />
        </div>
      </header>

      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
        <Stat
          label="Sandwich Attacks"
          value={sandwiches.length}
          sub={`from ${data.scan_blocks} ${blockLabel}`}
        />
        <Stat
          label="Bot Profit"
          value={sandwiches.length > 0 ? formatUsd(totalSandwichProfit) : "—"}
          sub={`${sandwiches.filter(s => (s.bot_profit_usd ?? 0) > 0).length} profitable`}
          color={totalSandwichProfit > 0 ? "var(--color-positive)" : undefined}
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

        <div className="space-y-0">
          {pagedSandwiches.map((sw, i) => (
            <SandwichCard
              key={sw.entry_tx.tx_hash + "-" + i}
              sw={sw}
              chain={chainConfig}
              isExpanded={expanded === sw.entry_tx.tx_hash}
              onToggle={() => toggle(sw.entry_tx.tx_hash)}
            />
          ))}
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
      <footer className="mt-12 sm:mt-16 pb-6 sm:pb-8 text-[10px] text-[var(--color-text-dim)] border-t border-[var(--color-border)] pt-4">
        {chain === "eth"
          ? "On-chain Swap event scanning. Sandwich = same bot front-runs & back-runs victim swaps on the same pool within one block."
          : chain === "bsc"
            ? "On-chain Swap event scanning on BSC. Sandwich = same bot front-runs & back-runs victim swaps on the same pool."
            : "On-chain DEX instruction scanning on Solana. Sandwich = same signer brackets victim swaps in the same slot."}
      </footer>
    </div>
  );
}
