import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKlaviyoTools } from "./platforms/klaviyo/tools.js";
import { registerShopifyTools } from "./platforms/shopify/tools.js";
import { registerCrossPlatformTools } from "./cross-platform/tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "dtc-mcp",
    version: "0.2.0",
  });

  registerKlaviyoTools(server);
  registerShopifyTools(server);
  registerCrossPlatformTools(server);

  return server;
}
