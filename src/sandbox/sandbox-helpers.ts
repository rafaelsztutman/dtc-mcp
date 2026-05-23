/**
 * JS source for the output-discipline helpers that get injected into the
 * sandbox global scope. Same code runs in both runners (node:vm and
 * isolated-vm) — keeping this as a single string source-of-truth means the
 * behavior the LLM observes is identical regardless of which runner is
 * actually executing.
 *
 * Why these helpers exist: Stainless's published benchmark caps factuality
 * at 53% across all code-mode MCPs, with the model "tending toward verbose
 * responses beyond what's strictly necessary." These helpers give the LLM
 * a vocabulary to project / aggregate / trim raw API responses before
 * returning, and the docs explicitly point at them.
 */

export const SANDBOX_HELPERS_SOURCE = `
/**
 * pick(value, schema) — projection over deep objects + arrays.
 *
 * schema is a partial mirror of value's shape; truthy leaves are kept.
 *   pick({a:1,b:2,c:{x:3,y:4}}, {a:true, c:{x:true}}) → {a:1, c:{x:3}}
 *
 * Arrays inherit the schema for each element:
 *   pick([{a:1,b:2}, {a:3,b:4}], {a:true}) → [{a:1}, {a:3}]
 */
globalThis.pick = function pick(value, schema) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => pick(item, schema));
  if (typeof value !== 'object') return value;
  if (schema === true) return value;
  if (!schema || typeof schema !== 'object') return undefined;
  const out = {};
  for (const key of Object.keys(schema)) {
    if (!(key in value)) continue;
    const subSchema = schema[key];
    if (subSchema === true) {
      out[key] = value[key];
    } else if (subSchema && typeof subSchema === 'object') {
      out[key] = pick(value[key], subSchema);
    }
  }
  return out;
};

/**
 * topN(arr, n, by) — top N items by a numeric key (descending).
 *   topN([{revenue: 10}, {revenue: 30}, {revenue: 20}], 2, 'revenue')
 *     → [{revenue: 30}, {revenue: 20}]
 *
 * by can be a string (property name) or a function (custom comparator value).
 */
globalThis.topN = function topN(arr, n, by) {
  if (!Array.isArray(arr)) return [];
  const keyFn = typeof by === 'function' ? by : (item) => (item == null ? 0 : item[by] ?? 0);
  return [...arr]
    .map((item) => ({ item, key: Number(keyFn(item)) || 0 }))
    .sort((a, b) => b.key - a.key)
    .slice(0, n)
    .map((entry) => entry.item);
};

/**
 * summarize(arr, opts) — auto-summarize an array. Returns:
 *   { count, top?, total?, avg?, min?, max? }
 *
 * Options:
 *   - by: string | (item) => number — the numeric field to aggregate
 *   - topN: number — also return the top N items by 'by' (default: omitted)
 *   - total: boolean — include sum (default: true when 'by' is set)
 *   - stats: boolean — include avg/min/max (default: true when 'by' is set)
 */
globalThis.summarize = function summarize(arr, opts) {
  opts = opts || {};
  if (!Array.isArray(arr)) {
    return { count: 0 };
  }
  const result = { count: arr.length };
  if (opts.by !== undefined) {
    const keyFn = typeof opts.by === 'function' ? opts.by : (item) => (item == null ? 0 : item[opts.by] ?? 0);
    const values = arr.map((item) => Number(keyFn(item)) || 0);
    const wantTotal = opts.total !== false;
    const wantStats = opts.stats !== false;
    if (wantTotal) {
      result.total = values.reduce((s, v) => s + v, 0);
    }
    if (wantStats && values.length > 0) {
      result.min = Math.min(...values);
      result.max = Math.max(...values);
      result.avg = result.total !== undefined
        ? result.total / values.length
        : values.reduce((s, v) => s + v, 0) / values.length;
    }
    if (opts.topN && opts.topN > 0) {
      result.top = topN(arr, opts.topN, opts.by);
    }
  }
  return result;
};
`.trim();
