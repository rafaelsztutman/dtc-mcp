#!/usr/bin/env node

// Catch any uncaught errors so the process doesn't silently exit
process.on("uncaughtException", (err) => {
  console.error("[dtc-mcp] fatal: uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[dtc-mcp] fatal: unhandled rejection:", err);
});

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Load .env from project root (not process.cwd(), which varies by launcher)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), quiet: true });

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

try {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  console.error("[dtc-mcp] fatal: failed to start server:", err);
  process.exit(1);
}
