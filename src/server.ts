import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCode } from "./tools/execute_code.js";
import { registerSearchDocs } from "./tools/search_docs.js";
import { registerReadDoc } from "./tools/read_doc.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "dtc-mcp",
    version: "1.0.1",
  });

  registerExecuteCode(server);
  registerSearchDocs(server);
  registerReadDoc(server);

  return server;
}
