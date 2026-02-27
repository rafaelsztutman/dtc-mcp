#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Load .env for local development (not needed in .mcpb — env vars come from user_config).
// Dynamic import so dotenv is optional and won't crash if missing.
const dir = dirname(fileURLToPath(import.meta.url));
import("dotenv")
  .then((m) => m.default.config({ path: resolve(dir, "..", ".env"), quiet: true }))
  .catch(() => {});

const server = createServer();
const transport = new StdioServerTransport();

// Match official mcpb examples: fire-and-forget connect, no top-level await
server.connect(transport).catch((err: unknown) => {
  console.error("[dtc-mcp] fatal: failed to start server:", err);
  process.exit(1);
});

console.error("[dtc-mcp] server running");
