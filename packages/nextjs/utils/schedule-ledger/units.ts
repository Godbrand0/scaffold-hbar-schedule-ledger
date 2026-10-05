// HBAR has 8 protocol decimals (tinybar). Inside the EVM on Hedera, `msg.value` is in tinybar, while the
// JSON-RPC layer (wallets, viem) speaks 18-decimal "weibar". 1 tinybar = 1e10 weibar.

export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** Parse a decimal HBAR string such as "1.25" into tinybar. Returns null for anything that is not a
 *  positive amount with at most 8 decimal places. */
export function hbarToTinybar(input: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(input.trim());
  if (!match) return null;
  const whole = BigInt(match[1]) * TINYBAR_PER_HBAR;
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  const total = whole + fraction;
  return total > 0n ? total : null;
}

/** Parse a decimal USD string such as "10.50" into the contract's USD units (8 decimals, 1e8 = $1). USD plans use
 *  the same 8-decimal scale as tinybar, so this is the same parse. */
export const usdToUnits = hbarToTinybar;

/** Format USD units (8 decimals) as dollars with at least two decimals, e.g. 1050000000 -> "$10.50". */
export function formatUsd(units: string | bigint): string {
  const value = BigInt(units);
  const whole = value / TINYBAR_PER_HBAR;
  const fraction = (value % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${fraction}`;
}

/** Format an oracle price with `decimals` decimals as dollars per HBAR, e.g. 103310000000000000n -> "$0.1033". */
export function formatOraclePrice(price: bigint, decimals = 18): string {
  const scale = 10n ** BigInt(decimals);
  const whole = price / scale;
  const fraction = (price % scale).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${fraction}`;
}

/** The per-run HBAR cap to suggest for a USD plan: `headroom` times today's conversion, so a price drop of up to
 *  that factor does not pause the plan. Rounds up to a whole HBAR. */
export function suggestedCapTinybar(quoteTinybar: bigint, headroom = 2n): bigint {
  const capped = quoteTinybar * headroom;
  return ((capped + TINYBAR_PER_HBAR - 1n) / TINYBAR_PER_HBAR) * TINYBAR_PER_HBAR;
}

/** Format tinybar (as a decimal string from the indexer) as HBAR, trimming trailing zeros. */
export function tinybarToHbar(tinybar: string | bigint): string {
  const value = BigInt(tinybar);
  const whole = value / TINYBAR_PER_HBAR;
  const fraction = (value % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The `value` to attach to a transaction so the contract sees `tinybar` in `msg.value`. */
export function tinybarToWeibar(tinybar: bigint): bigint {
  return tinybar * WEIBAR_PER_TINYBAR;
}

/** "1h 30m", "45s", ... for an interval in seconds. */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const units: [string, number][] = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [label, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${count}${label}`);
    rest -= count * size;
  }
  if (rest > 0 && parts.length === 0) parts.push(`${rest}s`);
  return parts.join(" ");
}
