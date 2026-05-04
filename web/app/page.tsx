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

interface Data {
  updated_at: string;
  scan_blocks: number;
  total_arbitrage_txs: number;
  relay_blocks: RelayBlock[];
  transactions: Transaction[];
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

  const pnlTxs = data.transactions.filter((t) => t.pnl_usd !== null);
  const totalPnl = pnlTxs.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const profitableTxs = pnlTxs.filter((t) => (t.pnl_usd ?? 0) > 0);

  const q = search.trim().toLowerCase();
  const filtered = q
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const blockLabel = chain === "sol" ? "slots" : "blocks";

  return (
    <div className="min-h-screen px-3 py-6 sm:px-6 sm:py-8 md:px-8 lg:px-16 max-w-[1440px] mx-auto">
      {/* Header */}
      <header className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3 mb-8 sm:mb-10">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight leading-none">
              MEV Scanner
            </h1>
            <p className="text-[11px] text-[var(--color-text-dim)] mt-1.5 tracking-wide">
              Arbitrage transactions on {chainConfig.label}
            </p>
          </div>
          <ChainTabs active={chain} onChange={setChain} />
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
      </header>

      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 sm:gap-6 mb-8 sm:mb-10 pb-6 sm:pb-8 border-b border-[var(--color-border)]">
        <Stat
          label="Arbitrage Txs"
          value={data.total_arbitrage_txs}
          sub={`from ${data.scan_blocks} ${blockLabel}`}
        />
        <Stat
          label="Total PnL"
          value={formatUsd(totalPnl)}
          sub={`${pnlTxs.length} txs with data`}
          color={totalPnl >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
        />
        <Stat
          label="Profitable"
          value={`${profitableTxs.length} / ${pnlTxs.length}`}
          sub="with PnL data"
        />
        {hasRelay ? (
          <>
            <Stat
              label="Peak MEV"
              value={`${maxMev.toFixed(4)} Ξ`}
              sub="per block (relay)"
            />
            <Stat
              label="Avg MEV / Block"
              value={`${avgMev.toFixed(4)} Ξ`}
              sub={`${data.relay_blocks.length} blocks`}
            />
          </>
        ) : (
          <>
            <Stat
              label="Avg Swaps / Tx"
              value={
                pnlTxs.length > 0
                  ? (
                      data.transactions.reduce(
                        (s, t) => s + (t.swap_count ?? 0),
                        0
                      ) / data.transactions.length
                    ).toFixed(1)
                  : "—"
              }
              sub="per arbitrage tx"
            />
            <Stat
              label="DEXes"
              value={
                new Set(data.transactions.flatMap((t) => t.dex_list)).size
              }
              sub="unique protocols"
            />
          </>
        )}
      </section>

      {/* Transactions */}
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
            Arbitrage Transactions
            {q && (
              <span className="normal-case tracking-normal ml-2 text-[var(--color-text-dim)]">
                — {filtered.length} result{filtered.length !== 1 ? "s" : ""}
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
              placeholder="Search hash, address, token..."
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

        {/* Desktop: Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
                <th className="text-left font-normal py-2 pr-4 w-[180px]">Tx Hash</th>
                <th className="text-left font-normal py-2 pr-4 w-[90px]">
                  {chain === "sol" ? "Slot" : "Block"}
                </th>
                <th className="text-left font-normal py-2 pr-4 w-[100px]">Swaps</th>
                <th className="text-left font-normal py-2 pr-4 w-[140px]">DEXes</th>
                <th className="text-right font-normal py-2 pr-4 w-[90px]">
                  {chain === "sol" ? "Fee" : "Gas"}
                </th>
                <th className="text-right font-normal py-2 pr-4 w-[100px]">PnL</th>
                <th className="text-right font-normal py-2 w-[130px]">Links</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((tx) => (
                <TxRow
                  key={tx.tx_hash}
                  tx={tx}
                  chain={chainConfig}
                  isExpanded={expanded === tx.tx_hash}
                  onToggle={() => toggle(tx.tx_hash)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: Cards */}
        <div className="md:hidden">
          {paged.map((tx) => (
            <TxCard
              key={tx.tx_hash}
              tx={tx}
              chain={chainConfig}
              isExpanded={expanded === tx.tx_hash}
              onToggle={() => toggle(tx.tx_hash)}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-16 text-[var(--color-text-dim)] text-sm">
            {q ? `No results for "${q}"` : "No arbitrage transactions found. Crawler may still be syncing."}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--color-border)]">
            <span className="text-[11px] text-[var(--color-text-dim)] tabular-nums">
              {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
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

      {/* Relay Blocks Chart (ETH only) */}
      {hasRelay && (
        <section className="mt-10 sm:mt-12">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-secondary)] mb-4">
            Recent MEV-Boost Blocks
          </h2>
          <div className="flex gap-[2px] items-end h-12 sm:h-16">
            {data.relay_blocks
              .slice()
              .reverse()
              .map((b) => {
                const h = Math.max(8, (b.value_eth / (maxMev || 1)) * 100);
                return (
                  <a
                    key={b.slot}
                    href={`${chainConfig.explorerTxUrl.replace("/tx/", "/block/")}${b.block_number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Block ${b.block_number}\n${b.value_eth.toFixed(4)} ETH`}
                    className="flex-1 min-w-[4px] sm:min-w-[6px] rounded-[2px] transition-opacity hover:opacity-70"
                    style={{
                      height: `${h}%`,
                      background:
                        b.value_eth > avgMev * 2
                          ? "var(--color-accent)"
                          : b.value_eth > avgMev
                            ? "var(--color-accent-dim)"
                            : "var(--color-border-light)",
                    }}
                  />
                );
              })}
          </div>
          <div className="flex justify-between text-[10px] text-[var(--color-text-dim)] mt-2">
            <span>
              #{data.relay_blocks[data.relay_blocks.length - 1]?.block_number}
            </span>
            <span>#{data.relay_blocks[0]?.block_number}</span>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-12 sm:mt-16 pb-6 sm:pb-8 text-[10px] text-[var(--color-text-dim)] border-t border-[var(--color-border)] pt-4">
        {chain === "eth"
          ? "Data from Flashbots Relay API & on-chain Swap event scanning. Arbitrage = ≥2 Uniswap swaps in a single transaction."
          : chain === "bsc"
            ? "On-chain Swap event scanning on BSC. Arbitrage = ≥2 PancakeSwap swaps in a single transaction."
            : "On-chain DEX instruction scanning on Solana. Arbitrage = ≥2 DEX swaps in a single transaction."}
      </footer>
    </div>
  );
}
