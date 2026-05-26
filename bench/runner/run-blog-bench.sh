#!/usr/bin/env bash
# Sequential 16-cell v1.0.6 fresh-run for the blog post. Tasks 02 / 05 / 06 / 09 — one per
# turn-count bucket (1 / 2 / 5 / 10), no segments. Interleaved by task → trial → mcp so we
# get incremental side-by-side data as the run progresses.
#
# Pacing: 21s between cells (3s base + 8s reporting + 10s mcp switch).
set -u
cd "$(dirname "$0")/.."

CELLS=(
  '02-baseline-top-flow-revenue::dtc-mcp::trial-1'
  '02-baseline-top-flow-revenue::klaviyo-mcp::trial-1'
  '02-baseline-top-flow-revenue::dtc-mcp::trial-2'
  '02-baseline-top-flow-revenue::klaviyo-mcp::trial-2'
  '05-short-campaign-comparison::dtc-mcp::trial-1'
  '05-short-campaign-comparison::klaviyo-mcp::trial-1'
  '05-short-campaign-comparison::dtc-mcp::trial-2'
  '05-short-campaign-comparison::klaviyo-mcp::trial-2'
  '06-medium-campaign-performance-investigation::dtc-mcp::trial-1'
  '06-medium-campaign-performance-investigation::klaviyo-mcp::trial-1'
  '06-medium-campaign-performance-investigation::dtc-mcp::trial-2'
  '06-medium-campaign-performance-investigation::klaviyo-mcp::trial-2'
  '09-long-campaign-postmortem-and-strategy::dtc-mcp::trial-1'
  '09-long-campaign-postmortem-and-strategy::klaviyo-mcp::trial-1'
  '09-long-campaign-postmortem-and-strategy::dtc-mcp::trial-2'
  '09-long-campaign-postmortem-and-strategy::klaviyo-mcp::trial-2'
)

for i in "${!CELLS[@]}"; do
  cell="${CELLS[$i]}"
  if [[ $i -gt 0 ]]; then
    echo "[blog-bench] sleeping 21s before cell $((i+1))/16"
    sleep 21
  fi
  echo "[blog-bench] cell $((i+1))/16: $cell"
  npx tsx runner/cli.ts multiturn --cell "$cell" 2>&1 | tail -2
done

echo "[blog-bench] DONE — all 16 cells processed"
