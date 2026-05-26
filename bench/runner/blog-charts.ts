/**
 * Generate hand-crafted SVG charts for the Substack blog post. Matches the
 * dtc-mcp hero image palette (warm cream/terracotta + slate). No chart
 * library — bars are just <rect> elements; full control over typography
 * and spacing.
 *
 * Output: bench/notes/blog-assets/*.svg + *.html (preview wrapper).
 * Convert to PNG separately via `sips -s format png <svg>` on macOS.
 *
 * Usage:
 *   tsx bench/runner/blog-charts.ts [chart_id]
 *   tsx bench/runner/blog-charts.ts sample
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../notes/blog-assets");

// ─── Brand palette (matches hero image) ────────────────────────────────────

const COLORS = {
  bg:         "#F5F1EA",   // cream background
  fg:         "#2A1F18",   // near-black text (warm)
  muted:      "#7A6B5F",   // muted gray-brown for secondary text
  grid:       "#E5DDD0",   // very soft gridlines
  primary:    "#C9532E",   // terracotta (dtc-mcp brand)
  secondary:  "#5B7A99",   // slate blue (Klaviyo official MCP)
  accent:     "#D97757",   // warm orange (highlight)
  badGood:    "#7B9B6F",   // soft green for "better"
  badBad:     "#B5523F",   // soft red for "worse"
};

// Use single quotes inside the style attribute to avoid escaping issues.
const FONT = `-apple-system,BlinkMacSystemFont,Inter,'Segoe UI',sans-serif`;

// ─── SVG primitives ────────────────────────────────────────────────────────

interface ChartConfig {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  title: string;
  subtitle?: string;
}

function chartShell(cfg: ChartConfig, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cfg.width} ${cfg.height}" width="${cfg.width}" height="${cfg.height}">
  <rect x="0" y="0" width="${cfg.width}" height="${cfg.height}" fill="${COLORS.bg}"/>
  <style>text { font-family: ${FONT}; }</style>
  <text x="${cfg.margin.left}" y="36" font-size="22" font-weight="600" fill="${COLORS.fg}">${escape(cfg.title)}</text>
  ${cfg.subtitle ? `<text x="${cfg.margin.left}" y="60" font-size="13" fill="${COLORS.muted}">${escape(cfg.subtitle)}</text>` : ""}
  ${inner}
</svg>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Grouped bar chart (paired bars per category) ──────────────────────────

interface GroupedBarSeries {
  label: string;
  color: string;
  values: number[];
}

interface GroupedBarChartArgs {
  title: string;
  subtitle?: string;
  categories: string[];
  series: GroupedBarSeries[];
  yLabel?: string;
  valueFormatter?: (v: number) => string;
}

function groupedBarChart(args: GroupedBarChartArgs): string {
  const cfg: ChartConfig = {
    width: 1100,
    height: 560,
    margin: { top: 90, right: 50, bottom: 110, left: 90 },
    title: args.title,
    subtitle: args.subtitle,
  };
  const plotW = cfg.width - cfg.margin.left - cfg.margin.right;
  const plotH = cfg.height - cfg.margin.top - cfg.margin.bottom;
  const fmt = args.valueFormatter ?? ((v) => v.toLocaleString());

  const allValues = args.series.flatMap((s) => s.values);
  const maxVal = Math.max(...allValues);
  // Pick a sensible yMax based on the magnitude of the data.
  function niceMax(v: number): number {
    if (v <= 5) return 6;
    if (v <= 10) return 10;
    if (v <= 20) return 20;
    if (v < 100) return Math.ceil(v / 10) * 10;
    if (v < 1000) return Math.ceil(v / 100) * 100;
    if (v < 10000) return Math.ceil(v / 1000) * 1000;
    return Math.ceil(v / 10000) * 10000;
  }
  const yMax = niceMax(maxVal * 1.15);
  const yTicks = 5;
  const yStep = yMax / yTicks;

  const groupCount = args.categories.length;
  const groupWidth = plotW / groupCount;
  const barGap = 6;
  const barWidth = (groupWidth - barGap * (args.series.length + 1)) / args.series.length;
  const groupInnerPad = (groupWidth - barWidth * args.series.length - barGap * (args.series.length - 1)) / 2;

  const inner: string[] = [];

  // Y gridlines + ticks
  for (let i = 0; i <= yTicks; i++) {
    const v = yStep * i;
    const y = cfg.margin.top + plotH - (v / yMax) * plotH;
    inner.push(
      `<line x1="${cfg.margin.left}" x2="${cfg.margin.left + plotW}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`,
    );
    inner.push(
      `<text x="${cfg.margin.left - 12}" y="${y + 4}" font-size="11" fill="${COLORS.muted}" text-anchor="end">${fmt(v)}</text>`,
    );
  }

  // Y axis label
  if (args.yLabel) {
    inner.push(
      `<text x="${cfg.margin.left - 60}" y="${cfg.margin.top + plotH / 2}" font-size="12" fill="${COLORS.muted}" text-anchor="middle" transform="rotate(-90, ${cfg.margin.left - 60}, ${cfg.margin.top + plotH / 2})">${escape(args.yLabel)}</text>`,
    );
  }

  // Bars + category labels + value labels
  for (let gi = 0; gi < groupCount; gi++) {
    const groupX = cfg.margin.left + gi * groupWidth;
    for (let si = 0; si < args.series.length; si++) {
      const s = args.series[si];
      const v = s.values[gi];
      const barH = (v / yMax) * plotH;
      const barX = groupX + groupInnerPad + si * (barWidth + barGap);
      const barY = cfg.margin.top + plotH - barH;
      inner.push(
        `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barH}" fill="${s.color}" rx="3"/>`,
      );
      // Value label on top
      inner.push(
        `<text x="${barX + barWidth / 2}" y="${barY - 6}" font-size="11" fill="${COLORS.fg}" text-anchor="middle" font-weight="500">${fmt(v)}</text>`,
      );
    }
    // Category label — supports two-line labels via "\n"
    const catX = groupX + groupWidth / 2;
    const catY = cfg.margin.top + plotH + 28;
    const parts = args.categories[gi].split("\n");
    for (let li = 0; li < parts.length; li++) {
      const fontSize = li === 0 ? 14 : 12;
      const color = li === 0 ? COLORS.fg : COLORS.muted;
      inner.push(
        `<text x="${catX}" y="${catY + li * 18}" font-size="${fontSize}" fill="${color}" text-anchor="middle">${escape(parts[li])}</text>`,
      );
    }
  }

  // X axis baseline
  inner.push(
    `<line x1="${cfg.margin.left}" x2="${cfg.margin.left + plotW}" y1="${cfg.margin.top + plotH}" y2="${cfg.margin.top + plotH}" stroke="${COLORS.fg}" stroke-width="1.5"/>`,
  );

  // Legend (bottom)
  const legendY = cfg.height - 22;
  let legendX = cfg.margin.left;
  for (const s of args.series) {
    inner.push(
      `<rect x="${legendX}" y="${legendY - 11}" width="14" height="14" fill="${s.color}" rx="2"/>`,
    );
    inner.push(
      `<text x="${legendX + 22}" y="${legendY}" font-size="13" fill="${COLORS.fg}">${escape(s.label)}</text>`,
    );
    legendX += 22 + s.label.length * 7.5 + 40;
  }

  return chartShell(cfg, inner.join("\n  "));
}

// ─── Styled table (PNG-friendly alternative to markdown tables) ───────────

interface StyledTableArgs {
  title: string;
  subtitle?: string;
  headers: string[];
  rows: Array<{ cells: string[]; highlight?: "good" | "bad" | "neutral" }>;
  /** Per-column alignment: "left" | "center" | "right". Defaults to "left" for col 0, "right" elsewhere. */
  align?: ("left" | "center" | "right")[];
  /** Per-column width as a flex ratio (sum normalized). Defaults to 1.5 for col 0, 1 elsewhere. */
  weights?: number[];
}

function styledTable(args: StyledTableArgs): string {
  const padX = 50;
  const padTop = 90;
  const padBottom = 30;
  const rowH = 44;
  const headerH = 50;
  const tableW = 1000;
  const innerW = tableW - padX * 2;

  const ncols = args.headers.length;
  const weights = args.weights ?? args.headers.map((_, i) => (i === 0 ? 1.5 : 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const colWidths = weights.map((w) => (w / totalWeight) * innerW);
  const colXs: number[] = [];
  {
    let x = padX;
    for (const w of colWidths) { colXs.push(x); x += w; }
  }

  const align = args.align ?? args.headers.map((_, i) => (i === 0 ? "left" as const : "right" as const));

  const tableH = padTop + headerH + rowH * args.rows.length + padBottom;
  const cfg: ChartConfig = { width: tableW, height: tableH, margin: { top: 0, right: 0, bottom: 0, left: 0 }, title: args.title, subtitle: args.subtitle };

  const inner: string[] = [];

  // Header row background
  inner.push(`<rect x="${padX}" y="${padTop}" width="${innerW}" height="${headerH}" fill="${COLORS.grid}" rx="6"/>`);

  // Header cells
  for (let c = 0; c < ncols; c++) {
    const cellX = colXs[c] + 14;
    const cellW = colWidths[c] - 28;
    const textX = align[c] === "left" ? cellX : align[c] === "center" ? cellX + cellW / 2 : cellX + cellW;
    const anchor = align[c] === "left" ? "start" : align[c] === "center" ? "middle" : "end";
    inner.push(
      `<text x="${textX}" y="${padTop + headerH / 2 + 5}" font-size="12" font-weight="600" fill="${COLORS.fg}" text-anchor="${anchor}" letter-spacing="0.04em" style="text-transform:uppercase;">${escape(args.headers[c])}</text>`,
    );
  }

  // Data rows
  for (let r = 0; r < args.rows.length; r++) {
    const row = args.rows[r];
    const y = padTop + headerH + r * rowH;
    // Subtle alternating row backgrounds — actually skip, looks cleaner without
    // Highlight row if marked
    if (row.highlight === "good") {
      inner.push(`<rect x="${padX}" y="${y}" width="${innerW}" height="${rowH}" fill="${COLORS.badGood}" fill-opacity="0.15"/>`);
    } else if (row.highlight === "bad") {
      inner.push(`<rect x="${padX}" y="${y}" width="${innerW}" height="${rowH}" fill="${COLORS.badBad}" fill-opacity="0.10"/>`);
    }
    // Subtle horizontal separator
    if (r > 0) {
      inner.push(`<line x1="${padX + 14}" y1="${y}" x2="${padX + innerW - 14}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    }
    for (let c = 0; c < ncols; c++) {
      const cellX = colXs[c] + 14;
      const cellW = colWidths[c] - 28;
      const textX = align[c] === "left" ? cellX : align[c] === "center" ? cellX + cellW / 2 : cellX + cellW;
      const anchor = align[c] === "left" ? "start" : align[c] === "center" ? "middle" : "end";
      const fontWeight = c === 0 ? "500" : "400";
      const color = c === 0 ? COLORS.fg : COLORS.fg;
      inner.push(
        `<text x="${textX}" y="${y + rowH / 2 + 5}" font-size="13" font-weight="${fontWeight}" fill="${color}" text-anchor="${anchor}">${escape(row.cells[c])}</text>`,
      );
    }
  }

  return chartShell(cfg, inner.join("\n  "));
}

// ─── Chart data + builders ─────────────────────────────────────────────────

const fmtK = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

function chart1_v104_overview(): string {
  return groupedBarChart({
    title: "v1.0.4 bench: real tokens per task",
    subtitle: "lower is better · mean of 2 trials · Klaviyo live data",
    categories: [
      "task 02\n(1 turn · baseline)",
      "task 05\n(2 turn · short)",
      "task 06\n(5 turn · medium)",
      "task 09\n(10 turn · long)",
    ],
    series: [
      { label: "dtc-mcp",            color: COLORS.primary,   values: [38625, 42484, 42222, 65719] },
      { label: "klaviyo official MCP", color: COLORS.secondary, values: [48021, 48712, 58688, 78462] },
    ],
    yLabel: "tokens",
    valueFormatter: fmtK,
  });
}

function chart2_v105_regression(): string {
  return groupedBarChart({
    title: "v1.0.5 regression: prescriptive description backfired",
    subtitle: "dtc-mcp tokens on multi-turn tasks · v1.0.4 baseline vs v1.0.5 attempt",
    categories: [
      "task 04\n(2 turn · welcome flow)",
      "task 08\n(10 turn · full analytics)",
    ],
    series: [
      { label: "v1.0.4 (baseline)", color: COLORS.muted,  values: [54611, 110811] },
      { label: "v1.0.5 (attempt)",  color: COLORS.badBad, values: [70274, 130000] },
    ],
    yLabel: "tokens",
    valueFormatter: fmtK,
  });
}

function chart3_ablation_hallucinations(): string {
  return groupedBarChart({
    title: "Description ablation: hallucinations per candidate",
    subtitle: "lower is better · sum across 3 Sonnet sub-agent trials · revenue-analysis scenario",
    categories: [
      "A\nminimal",
      "B\nschema-first",
      "C\nexample",
      "D\nultra-compressed",
      "E\nhybrid",
      "F\nv1.0.6 design",
    ],
    series: [
      { label: "hallucinated method names",  color: COLORS.primary, values: [5, 3, 1, 5, 1, 0] },
    ],
    yLabel: "hallucinations",
    valueFormatter: (v) => String(v),
  });
}

function chart4_fresh_v104_v106(data: { tasks: string[]; v104: number[]; v106: number[] }): string {
  return groupedBarChart({
    title: "v1.0.6 recovers + matches v1.0.4 on dtc-mcp tokens",
    subtitle: "fresh 16-cell run · mean of 2 trials · dtc-mcp only",
    categories: data.tasks,
    series: [
      { label: "v1.0.4",  color: COLORS.muted,   values: data.v104 },
      { label: "v1.0.6",  color: COLORS.primary, values: data.v106 },
    ],
    yLabel: "tokens",
    valueFormatter: fmtK,
  });
}

function previewHtml(title: string, svg: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { margin: 0; padding: 40px; background: #FAF7F2; font-family: ${FONT}; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  .label { font-size: 12px; color: #7A6B5F; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  svg { display: block; max-width: 100%; }
</style>
</head><body>
<div class="wrap">
  <div class="label">Preview · ${escape(title)}</div>
  ${svg}
</div>
</body></html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function writeChart(id: string, title: string, svg: string): void {
  writeFileSync(resolve(OUT_DIR, `${id}.svg`), svg);
  writeFileSync(resolve(OUT_DIR, `${id}.html`), previewHtml(title, svg));
  console.log(`Wrote ${OUT_DIR}/${id}.svg + ${id}.html`);
}

const which = process.argv[2] ?? "all";

mkdirSync(OUT_DIR, { recursive: true });

if (which === "sample") {
  writeChart("sample", "Sample — v1.0.4 bench tokens per task", chart1_v104_overview());
}

if (which === "all" || which === "1") {
  writeChart("01-v104-overview", "v1.0.4 overview", chart1_v104_overview());
}

if (which === "all" || which === "2") {
  writeChart("02-v105-regression", "v1.0.5 regression", chart2_v105_regression());
}

if (which === "all" || which === "3") {
  writeChart("03-ablation-hallucinations", "Ablation hallucinations", chart3_ablation_hallucinations());
}

if (which === "all" || which === "3b") {
  const svg = styledTable({
    title: "Description ablation: full result table",
    subtitle: "5 description styles · 3 Sonnet sub-agent trials each · revenue-analysis scenario",
    headers: ["Candidate", "Stash", "Refed", "Calls/turn", "Hallucs", "Resp len"],
    weights: [2.5, 1, 1, 1.3, 1, 1.2],
    rows: [
      { cells: ["A — minimal (v1.0.4)",            "3/3", "3/3", "4.0", "5", "2034"] },
      { cells: ["B — schema-first",                "3/3", "3/3", "2.0", "3", "1795"] },
      { cells: ["C — example-first",               "3/3", "3/3", "3.3", "1", "1968"] },
      { cells: ["D — ultra-compressed (35 tok)",   "3/3", "3/3", "3.3", "5", "2096"] },
      { cells: ["E — hybrid (schema + example)",   "3/3", "3/3", "4.0", "1", "2349"] },
      { cells: ["F — v1.0.6 design (canonical)",   "3/3", "3/3", "3.0", "0", "2121"], highlight: "good" },
    ],
  });
  writeChart("03b-ablation-table", "Ablation full table", svg);
}

if (which === "4") {
  // Chart 4 needs the fresh-run data from state.json. Read it.
  const statePath = "/Users/roliveira/ai-projects/dtc-mcp/bench/results/2026-05-25_13-57-02/state.json";
  const s = JSON.parse(require("node:fs").readFileSync(statePath, "utf8"));
  const taskIds = [
    "02-baseline-top-flow-revenue",
    "05-short-campaign-comparison",
    "06-medium-campaign-performance-investigation",
    "09-long-campaign-postmortem-and-strategy",
  ];
  const taskLabels = ["task 02\n(1 turn)", "task 05\n(2 turn)", "task 06\n(5 turn)", "task 09\n(10 turn)"];
  function dtcMean(taskId: string): number {
    const cells = Object.values(s.cells).filter(
      (c: any) => c.taskId === taskId && c.mcp === "dtc-mcp" && c.status === "recorded",
    ) as any[];
    if (cells.length === 0) return 0;
    return Math.round(cells.reduce((a, c) => a + (c.usage?.totalTokens ?? 0), 0) / cells.length);
  }
  const baseline = JSON.parse(
    require("node:fs").readFileSync(
      "/Users/roliveira/ai-projects/dtc-mcp/bench/notes/v1.0.4-baseline-blog-16cells.json",
      "utf8",
    ),
  );
  function dtcMeanBaseline(taskId: string): number {
    const ids = [`${taskId}::dtc-mcp::trial-1`, `${taskId}::dtc-mcp::trial-2`];
    const vals = ids.map((id) => baseline.cells[id]?.tokens ?? 0).filter((v: number) => v > 0);
    return vals.length ? Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length) : 0;
  }
  const v104 = taskIds.map(dtcMeanBaseline);
  const v106 = taskIds.map(dtcMean);
  console.log("v1.0.4 dtc:", v104);
  console.log("v1.0.6 dtc:", v106);
  writeChart("04-fresh-v106", "Fresh v1.0.4 vs v1.0.6 (dtc-mcp)", chart4_fresh_v104_v106({ tasks: taskLabels, v104, v106 }));
}
