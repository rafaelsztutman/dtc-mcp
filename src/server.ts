import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCode } from "./tools/execute_code.js";
import { registerSearchDocs } from "./tools/search_docs.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "dtc-mcp",
    version: "1.0.0-rc.1",
  });

  registerExecuteCode(server);
  registerSearchDocs(server);

  return server;
}
