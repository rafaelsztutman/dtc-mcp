#!/usr/bin/env node

// CommonJS bootstrap — runs BEFORE any ESM module evaluation.
// Catches errors during ESM module loading and writes to a debug log file.
// This exists because Claude Desktop's built-in Node.js does not capture stderr.

const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG = path.join(os.tmpdir(), "dtc-mcp-debug.log");

function debugLog(msg: string): void {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // can't write to log file
  }
}

try {
  fs.writeFileSync(LOG, "");
} catch {
  // ignore
}

debugLog("=== dtc-mcp bootstrap ===");
debugLog(`node: ${process.version}`);
debugLog(`platform: ${process.platform} ${process.arch}`);
debugLog(`argv: ${JSON.stringify(process.argv)}`);
debugLog(`cwd: ${process.cwd()}`);
debugLog(
  `env KLAVIYO_API_KEY set: ${!!process.env.KLAVIYO_API_KEY} (length: ${process.env.KLAVIYO_API_KEY?.length ?? 0})`,
);
debugLog(`env SHOPIFY_STORE set: ${!!process.env.SHOPIFY_STORE}`);
debugLog(`env SHOPIFY_CLIENT_ID set: ${!!process.env.SHOPIFY_CLIENT_ID}`);
debugLog(
  `env SHOPIFY_CLIENT_SECRET set: ${!!process.env.SHOPIFY_CLIENT_SECRET}`,
);
debugLog(
  `env SHOPIFY_ACCESS_TOKEN set: ${!!process.env.SHOPIFY_ACCESS_TOKEN}`,
);

process.on("uncaughtException", (err: Error) => {
  debugLog(`uncaughtException: ${err?.stack || err}`);
});
process.on("unhandledRejection", (err: unknown) => {
  debugLog(
    `unhandledRejection: ${err instanceof Error ? err.stack : String(err)}`,
  );
});
process.on("exit", (code: number) => {
  debugLog(`process exit: code=${code}`);
});

debugLog("loading ESM module...");
import("./index.js")
  .then(() => {
    debugLog("ESM module loaded OK");
  })
  .catch((err: Error) => {
    debugLog(`ESM module load FAILED: ${err?.stack || err}`);
    process.exit(1);
  });
