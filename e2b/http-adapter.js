import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || "8083");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || "30000");

class StdioMcpSession {
  constructor() {
    this.proc = spawn("node", ["./build/index.js"], {
      cwd: "/app",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.pending = new Map();

    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", () => {});
    this.proc.on("exit", (code) => {
      const err = new Error(`e2b MCP process exited with code ${code ?? -1}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    });
  }

  close() {
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) return;
      const body = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!body) continue;

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (message && message.id !== undefined && message.id !== null) {
        const key = String(message.id);
        const entry = this.pending.get(key);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(key);
          entry.resolve(message);
        }
      }
    }
  }

  request(message) {
    return new Promise((resolve, reject) => {
      const id = message && message.id !== undefined ? String(message.id) : null;
      if (id === null) {
        reject(new Error("MCP request must include an id"));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(message);
      const frame = `${payload}\n`;
      this.proc.stdin.write(frame, "utf8");
    });
  }
}

const sessions = new Map();

function sseResponse(res, payload, sessionId) {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  if (sessionId) res.setHeader("Mcp-Session-Id", sessionId);
  res.end(body);
}

function text(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    text(res, 200, "ok");
    return;
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    text(res, 404, "Not found");
    return;
  }

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });

  req.on("end", async () => {
    let rpc;
    try {
      rpc = JSON.parse(raw);
    } catch {
      text(res, 400, "bad request");
      return;
    }

    try {
      if (rpc.method === "initialize") {
        const sessionId = crypto.randomUUID().replace(/-/g, "");
        const session = new StdioMcpSession();
        sessions.set(sessionId, session);

        const upstream = await session.request(rpc);
        sseResponse(res, upstream, sessionId);
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || typeof sessionId !== "string") {
        text(res, 400, "missing or invalid Mcp-Session-Id");
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        text(res, 400, "missing or invalid Mcp-Session-Id");
        return;
      }

      const upstream = await session.request(rpc);
      sseResponse(res, upstream);
    } catch (err) {
      text(res, 502, `upstream error: ${String(err)}`);
    }
  });
});

server.listen(PORT, "0.0.0.0");

process.on("SIGTERM", () => {
  for (const session of sessions.values()) {
    session.close();
  }
  process.exit(0);
});
