#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Local-dev convenience: load .env if present. .mcpb installs pass user_config
// through process.env directly, so this is a no-op there.
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

console.error("[dtc-mcp] v1.0.0-rc.4 ready");
