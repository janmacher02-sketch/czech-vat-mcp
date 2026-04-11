import express, { Request, Response, NextFunction } from "express";
import { Unkey } from "@unkey/api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const app = express();
app.use(express.json());

// ─── Unkey middleware ─────────────────────────────────────────────────────────

const unkey = new Unkey({ rootKey: process.env.UNKEY_ROOT_KEY! });
const UNKEY_API_ID = process.env.UNKEY_API_ID!;

// In-memory free tier tracker (resets on redeploy — good enough for start)
const freeCalls = new Map<string, { count: number; resetAt: number }>();
const FREE_LIMIT = 10;

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"] ?? "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : (req.headers["x-api-key"] as string ?? "");

  // With API key → verify via Unkey
  if (apiKey) {
    const { result, error } = await unkey.keys.verify({ key: apiKey, apiId: UNKEY_API_ID });

    if (error || !result?.valid) {
      res.status(401).json({
        error: "Invalid API key.",
        message: "Get your free API key at https://czechvat.janmacher.dev",
      });
      return;
    }

    if (result.ratelimit && result.remaining === 0) {
      res.status(429).json({
        error: "Rate limit exceeded.",
        message: "Upgrade to Pro for unlimited calls: https://czechvat.janmacher.dev",
        resetAt: result.ratelimit.reset,
      });
      return;
    }

    next();
    return;
  }

  // No key → free tier (10 calls/day per IP)
  const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const entry = freeCalls.get(ip);

  if (!entry || entry.resetAt < now) {
    freeCalls.set(ip, { count: 1, resetAt: now + dayMs });
    next();
    return;
  }

  if (entry.count >= FREE_LIMIT) {
    res.status(429).json({
      error: `Free tier limit reached (${FREE_LIMIT} calls/day).`,
      message: "Get a free API key for more calls: https://czechvat.janmacher.dev",
    });
    return;
  }

  entry.count++;
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "czech-vat-mcp",
    version: "1.0.0",
    status: "ok",
    docs: "https://github.com/janmacher02-sketch/czech-vat-mcp",
    getApiKey: "https://czechvat.janmacher.dev",
  });
});

app.post("/mcp", authMiddleware, async (req, res) => {
  const server = new McpServer({ name: "czech-vat-mcp", version: "1.0.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Czech VAT MCP running on port ${PORT}`));
