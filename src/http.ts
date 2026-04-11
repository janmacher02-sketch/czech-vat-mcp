import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "czech-vat-mcp", version: "1.0.0" });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Health check
app.get("/", (_req, res) => {
  res.json({ name: "czech-vat-mcp", version: "1.0.0", status: "ok" });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Czech VAT MCP running on port ${PORT}`));
