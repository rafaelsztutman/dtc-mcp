#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Load .env for local development (not needed in .mcpb — env vars come from user_config)
import("dotenv")
  .then(async (m) => {
    const { fileURLToPath } = await import("url");
    const { dirname, resolve } = await import("path");
    const dir = dirname(fileURLToPath(import.meta.url));
    m.default.config({ path: resolve(dir, "..", ".env"), quiet: true });
  })
  .catch(() => {});

const server = createServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err: unknown) => {
  console.error("[dtc-mcp] fatal: failed to connect:", err);
  process.exit(1);
});

console.error("[dtc-mcp] server running");
