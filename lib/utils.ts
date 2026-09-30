export function clsxm(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function formatBtc(sats?: number | null, unit = "BTC", maxDigits?: number) {
  if (sats == null || Number.isNaN(sats)) return "n/a";
  const btc = sats / 1e8;
  if (btc === 0) return `0 ${unit}`;
  const abs = Math.abs(btc);
  const digits = maxDigits ?? (abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.001 ? 5 : 8);
  return `${btc.toLocaleString("en-US", { maximumFractionDigits: digits })} ${unit}`;
}

export function formatSats(sats?: number | null) {
  if (sats == null || Number.isNaN(sats)) return "n/a";
  return `${Math.round(sats).toLocaleString("en-US")} sats`;
}

export function shortenHash(value: string, size = 4) {
  if (!value) return "n/a";
  if (value.length <= size * 2) return value;
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}
