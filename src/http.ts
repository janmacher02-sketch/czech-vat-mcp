import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const app = express();
app.use(express.json());

const UNKEY_API_ID = process.env.UNKEY_API_ID!;
const FREE_LIMIT = 10;
const freeCalls = new Map<string, { count: number; resetAt: number }>();

async function verifyKeyViaRest(apiKey: string): Promise<{ valid: boolean; remaining?: number }> {
  try {
    const res = await fetch("https://api.unkey.dev/v1/keys.verifyKey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey, apiId: UNKEY_API_ID }),
    });
    if (!res.ok) return { valid: false };
    const data = await res.json() as any;
    return { valid: data.valid === true, remaining: data.ratelimit?.remaining };
  } catch {
    return { valid: false };
  }
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"] ?? "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : (req.headers["x-api-key"] as string ?? "");

  if (apiKey) {
    const { valid, remaining } = await verifyKeyViaRest(apiKey);
    if (!valid) {
      res.status(401).json({
        error: "Invalid API key.",
        message: "Get your key at https://buy.stripe.com/4gM3cw8Dz28qcAYdHJaEE00",
      });
      return;
    }
    if (remaining !== undefined && remaining === 0) {
      res.status(429).json({
        error: "Rate limit exceeded.",
        message: "Upgrade at https://buy.stripe.com/4gM3cw8Dz28qcAYdHJaEE00",
      });
      return;
    }
    next();
    return;
  }

  // No key → free tier (10 calls/day per IP)
  const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const entry = freeCalls.get(ip);
  if (!entry || entry.resetAt < now) {
    freeCalls.set(ip, { count: 1, resetAt: now + 86400000 });
    next();
    return;
  }
  if (entry.count >= FREE_LIMIT) {
    res.status(429).json({
      error: `Free tier limit reached (${FREE_LIMIT} calls/day).`,
      message: "Get a paid API key: https://buy.stripe.com/4gM3cw8Dz28qcAYdHJaEE00",
    });
    return;
  }
  entry.count++;
  next();
}

app.get("/", (_req, res) => {
  res.json({ name: "czech-vat-mcp", version: "1.0.0", status: "ok" });
});

app.post("/mcp", authMiddleware, async (req, res) => {
  const server = new McpServer({ name: "czech-vat-mcp", version: "1.0.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Czech VAT MCP running on port ${PORT}`));
