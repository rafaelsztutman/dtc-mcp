#!/usr/bin/env bash
# Build the .mcpb bundle with all the production deps, ad-hoc sign every
# native module (.node) so they pass macOS hardened-runtime checks when run
# by a child Node process, then pack.
#
# Usage:  tools/build-mcpb.sh                # → dtc-mcp-vX.Y.Z.mcpb in repo root
#         tools/build-mcpb.sh path/out.mcpb  # → custom output path

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./package.json").version')
OUT="${1:-dtc-mcp-v${VERSION}.mcpb}"
STAGING=".mcpb-staging"

echo "→ Building dist/"
npm run build >/dev/null

echo "→ Staging .mcpb at $STAGING/"
rm -rf "$STAGING"
mkdir -p "$STAGING/server"
cp manifest.json icon.png PRIVACY.md "$STAGING/"
cp -r dist/. "$STAGING/server/"
# IMPORTANT: data/ goes at the EXTENSION ROOT, sibling of server/. The docs
# loader resolves the path as `../../data/docs.json` from
# server/docs/loader.js — putting data inside server/ breaks the lookup at
# install time even though it works in dev (where dist/ sits next to data/).
cp -r data "$STAGING/data"

echo "→ Writing prod-only package.json"
cat > "$STAGING/server/package.json" <<EOF
{
  "name": "dtc-mcp-server",
  "version": "$VERSION",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "dotenv": "^17.3.1",
    "isolated-vm": "^6.1.2",
    "minisearch": "^7.1.0",
    "sucrase": "^3.35.0",
    "zod": "^3.23.8"
  }
}
EOF

echo "→ Installing production deps (may compile isolated-vm from source)"
( cd "$STAGING/server" && npm install --omit=dev --omit=optional --no-audit --no-fund --silent )

# Native modules built locally on macOS must be ad-hoc signed or the
# system's Gatekeeper/hardened-runtime checks reject them at dlopen.
# Doesn't help with Library Validation inside Claude Desktop's Electron
# (that's why we have the sidecar) but the sidecar's spawned Node DOES
# enforce ad-hoc signatures on some setups.
if [[ "$(uname)" == "Darwin" ]]; then
  echo "→ Ad-hoc signing native modules"
  find "$STAGING/server" -name '*.node' -print0 |
    xargs -0 -I{} codesign --force --sign - {} 2>&1 |
    grep -v 'replacing existing signature' || true
fi

echo "→ Packing $OUT"
rm -f "$OUT"
npx -y @anthropic-ai/mcpb pack "$STAGING" "$OUT" >/dev/null

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ Built $OUT ($SIZE)"
