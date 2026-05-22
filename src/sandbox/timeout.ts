/**
 * Parse an opt-in `// @timeout <duration>` annotation from user code.
 * Defaults to 30 seconds. Honors only the FIRST occurrence in the first
 * 20 non-blank lines, so a comment buried deep in user code can't extend
 * timeouts unexpectedly.
 *
 * Accepted forms (case-insensitive, optional whitespace):
 *   // @timeout 30s     → 30000ms
 *   // @timeout 2m      → 120000ms
 *   // @timeout 5min    → 300000ms
 *   // @timeout 90000   → 90000ms (raw milliseconds)
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 minutes hard ceiling

export function resolveTimeout(code: string): number {
  const lines = code.split("\n").slice(0, 20);
  for (const line of lines) {
    const match = line.match(/\/\/\s*@timeout\s+(\d+)\s*(ms|s|m|min)?/i);
    if (!match) continue;
    const value = parseInt(match[1], 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = (match[2] ?? "ms").toLowerCase();
    let ms: number;
    if (unit === "s") ms = value * 1_000;
    else if (unit === "m" || unit === "min") ms = value * 60_000;
    else ms = value;
    return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, ms));
  }
  return DEFAULT_TIMEOUT_MS;
}

export { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
