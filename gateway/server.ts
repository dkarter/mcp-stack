import { Database } from "bun:sqlite";

type Json = Record<string, unknown>;

type Upstream = {
  name: string;
  url: string;
  enabled: number;
  oauth_metadata_url: string | null;
};

type OAuthClient = {
  upstream_name: string;
  auth_server: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  resource: string | null;
  client_id: string;
  client_secret: string | null;
  scope: string | null;
  redirect_uri: string;
};

const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT ?? "20") * 1000;
const defaultsRaw = process.env.MCP_UPSTREAMS
  ?? "context7=http://context7:8000/mcp,github=http://github:8082/mcp,e2b=http://e2b:8083/mcp";
const dbPath = process.env.GATEWAY_DB_PATH ?? "./gateway/gateway.db";
const fnoxBin = process.env.FNOX_BIN ?? "fnox";
const fnoxCwd = process.env.FNOX_CWD ?? process.cwd();
const secretBackendPref = (process.env.SECRET_BACKEND ?? "fnox").toLowerCase();
const registryInspectTimeoutMs = Number(process.env.REGISTRY_INSPECT_TIMEOUT ?? "4") * 1000;
const registryCacheTtlMs = Number(process.env.REGISTRY_CACHE_TTL ?? "15") * 1000;
const tlsCertPath = process.env.TLS_CERT_PATH ?? "";
const tlsKeyPath = process.env.TLS_KEY_PATH ?? "";
const port = Number(process.env.PORT ?? "8090");
const registryUiPath = new URL("./ui/registry.tsx", import.meta.url);
const registryUiTranspiler = new Bun.Transpiler({
  loader: "tsx",
  tsconfig: {
    compilerOptions: {
      jsx: "react",
      jsxFactory: "React.createElement",
      jsxFragmentFactory: "React.Fragment",
    },
  },
});

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS upstreams (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  oauth_metadata_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  upstream_name TEXT PRIMARY KEY,
  auth_server TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  resource TEXT,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  scope TEXT,
  redirect_uri TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_name) REFERENCES upstreams(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upstream_tokens (
  upstream_name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_name) REFERENCES upstreams(name) ON DELETE CASCADE
);
`);

for (
  const stmt of [
    "ALTER TABLE oauth_clients ADD COLUMN resource TEXT",
    "ALTER TABLE oauth_clients ADD COLUMN redirect_uri TEXT",
  ]
) {
  try {
    db.exec(stmt);
  } catch {
    // Column may already exist.
  }
}

function parseDefaults(raw: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const url = trimmed.slice(eq + 1).trim();
    if (name && url) out.push({ name, url });
  }
  return out;
}

const insertDefaultStmt = db.query(
  "INSERT OR IGNORE INTO upstreams (name, url, enabled) VALUES (?, ?, 1)",
);

for (const row of parseDefaults(defaultsRaw)) {
  insertDefaultStmt.run(row.name, row.url);
}

const listUpstreamsStmt = db.query<Upstream, []>(
  "SELECT name, url, enabled, oauth_metadata_url FROM upstreams ORDER BY name",
);
const getUpstreamStmt = db.query<Upstream, [string]>(
  "SELECT name, url, enabled, oauth_metadata_url FROM upstreams WHERE name = ?",
);
const upsertUpstreamStmt = db.query(
  "INSERT INTO upstreams (name, url, enabled, oauth_metadata_url) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url, enabled = 1, oauth_metadata_url = excluded.oauth_metadata_url",
);
const setEnabledStmt = db.query("UPDATE upstreams SET enabled = ? WHERE name = ?");
const deleteUpstreamStmt = db.query("DELETE FROM upstreams WHERE name = ?");
const setMetadataUrlStmt = db.query(
  "UPDATE upstreams SET oauth_metadata_url = ? WHERE name = ?",
);
const getOAuthClientStmt = db.query<OAuthClient, [string]>(
  "SELECT upstream_name, auth_server, authorization_endpoint, token_endpoint, registration_endpoint, resource, client_id, client_secret, scope, COALESCE(redirect_uri, '') AS redirect_uri FROM oauth_clients WHERE upstream_name = ?",
);
const upsertOAuthClientStmt = db.query(
  "INSERT INTO oauth_clients (upstream_name, auth_server, authorization_endpoint, token_endpoint, registration_endpoint, resource, client_id, client_secret, scope, redirect_uri, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(upstream_name) DO UPDATE SET auth_server=excluded.auth_server, authorization_endpoint=excluded.authorization_endpoint, token_endpoint=excluded.token_endpoint, registration_endpoint=excluded.registration_endpoint, resource=excluded.resource, client_id=excluded.client_id, client_secret=excluded.client_secret, scope=excluded.scope, redirect_uri=excluded.redirect_uri, updated_at=CURRENT_TIMESTAMP",
);
const upsertTokenStmt = db.query(
  "INSERT INTO upstream_tokens (upstream_name, token, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(upstream_name) DO UPDATE SET token=excluded.token, updated_at=CURRENT_TIMESTAMP",
);
const getTokenStmt = db.query<{ token: string }, [string]>(
  "SELECT token FROM upstream_tokens WHERE upstream_name = ?",
);
const clearTokenStmt = db.query("DELETE FROM upstream_tokens WHERE upstream_name = ?");

const gatewaySessions = new Map<string, Map<string, string>>();
const inspectionCache = new Map<string, { data: Json; updatedAt: number }>();
const inspectionInFlight = new Set<string>();
const registrySockets = new Set<ServerWebSocket<{ initialState?: Json[] }>>();
const oauthState = new Map<string, {
  upstreamName: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string | null;
  clientId: string;
  clientSecret: string | null;
  codeVerifier: string;
}>();

function listEnabledUpstreams(): Upstream[] {
  return listUpstreamsStmt.all().filter((u) => u.enabled === 1);
}

function gatewayBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1";
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

function gatewayMetadataPath(upstreamName: string): string {
  return `/.well-known/oauth-protected-resource/mcp?upstream=${encodeURIComponent(upstreamName)}`;
}

function gatewayMetadataUrl(req: Request, upstreamName: string): string {
  return `${gatewayBase(req)}${gatewayMetadataPath(upstreamName)}`;
}

function defaultUpstreamState(req: Request, upstream: Upstream): Json {
  return {
    name: upstream.name,
    url: upstream.url,
    status: "checking",
    error: "inspection pending",
    resource_metadata_url: gatewayMetadataUrl(req, upstream.name),
    has_secret: hasStoredSecret(upstream.name),
    tool_count: 0,
    resource_count: 0,
    prompt_count: 0,
    tools: [],
    resources: [],
    prompts: [],
  };
}

function defaultUpstreamStateNoReq(upstream: Upstream): Json {
  return {
    name: upstream.name,
    url: upstream.url,
    status: "checking",
    error: "inspection pending",
    resource_metadata_url: gatewayMetadataPath(upstream.name),
    has_secret: hasStoredSecret(upstream.name),
    tool_count: 0,
    resource_count: 0,
    prompt_count: 0,
    tools: [],
    resources: [],
    prompts: [],
  };
}

function mergeHasSecret(state: Json, hasSecret: boolean): Json {
  return { ...state, has_secret: hasSecret };
}

function broadcastRegistry(payload: Json): void {
  const message = JSON.stringify(payload);
  for (const ws of registrySockets) {
    try {
      ws.send(message);
    } catch {
      // Ignore per-socket send errors.
    }
  }
}

function currentUpstreamStateForBroadcast(upstreamName: string): Json | null {
  const upstream = getUpstreamStmt.get(upstreamName);
  if (!upstream) return null;
  const cached = inspectionCache.get(upstreamName)?.data ?? defaultUpstreamStateNoReq(upstream);
  return mergeHasSecret(cached, hasStoredSecret(upstreamName));
}

function broadcastUpstreamState(upstreamName: string): void {
  const upstream = currentUpstreamStateForBroadcast(upstreamName);
  if (!upstream) return;
  broadcastRegistry({ type: "upstream", upstream });
}

function scheduleInspect(req: Request, upstream: Upstream): void {
  if (inspectionInFlight.has(upstream.name)) return;
  inspectionInFlight.add(upstream.name);
  broadcastUpstreamState(upstream.name);
  void inspectWithTimeout(req, upstream)
    .then((data) => {
      inspectionCache.set(upstream.name, { data, updatedAt: Date.now() });
      broadcastUpstreamState(upstream.name);
    })
    .finally(() => {
      inspectionInFlight.delete(upstream.name);
    });
}

function parseChallengeMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const marker = "resource_metadata=\"";
  const i = wwwAuthenticate.indexOf(marker);
  if (i === -1) return null;
  const start = i + marker.length;
  const end = wwwAuthenticate.indexOf("\"", start);
  if (end === -1) return null;
  return wwwAuthenticate.slice(start, end);
}

function rewriteWwwAuthenticate(
  value: string,
  req: Request,
  upstreamName: string,
): string {
  const marker = "resource_metadata=\"";
  const i = value.indexOf(marker);
  if (i === -1) return value;
  const start = i + marker.length;
  const end = value.indexOf("\"", start);
  if (end === -1) return value;
  const rewritten = `${gatewayBase(req)}/.well-known/oauth-protected-resource/mcp?upstream=${
    encodeURIComponent(upstreamName)
  }`;
  return `${value.slice(0, start)}${rewritten}${value.slice(end)}`;
}

function firstSsePayload(text: string): Json {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload) return JSON.parse(payload) as Json;
  }
  throw new Error("No SSE payload");
}

function fnoxSecretKey(name: string): string {
  return `MCP_GATEWAY_TOKEN_${name.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
}

function fnoxProviderKeyName(name: string): string {
  return `mcp-gateway/${name}`;
}

function runFnox(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const decode = (bytes: Uint8Array<ArrayBufferLike>) => new TextDecoder().decode(bytes).trim();
  const run = (cmd: string[]) => {
    const proc = Bun.spawnSync({
      cmd,
      cwd: fnoxCwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: proc.exitCode === 0,
      stdout: decode(proc.stdout),
      stderr: decode(proc.stderr),
    };
  };

  try {
    const direct = run([fnoxBin, ...args]);
    if (direct.ok || !fnoxUnavailable(direct.stderr)) return direct;

    const viaMise = run(["mise", "x", "fnox@latest", "--", "fnox", ...args]);
    if (viaMise.ok) return viaMise;

    return {
      ok: false,
      stdout: "",
      stderr: direct.stderr || viaMise.stderr || "fnox execution failed",
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function fnoxUnavailable(stderr: string): boolean {
  const msg = stderr.toLowerCase();
  return msg.includes("executable not found") || msg.includes("enoent");
}

function setSecretInSqlite(name: string, token: string): { ok: true } {
  upsertTokenStmt.run(name, token);
  return { ok: true };
}

function getSecretFromSqlite(name: string): string | null {
  const row = getTokenStmt.get(name);
  return row?.token ?? null;
}

function clearSecretFromSqlite(name: string): { ok: true } {
  clearTokenStmt.run(name);
  return { ok: true };
}

function setSecretInKeychain(
  name: string,
  token: string,
): { ok: true } | { ok: false; error: string } {
  if (secretBackendPref === "sqlite") return setSecretInSqlite(name, token);
  const key = fnoxSecretKey(name);
  const set = runFnox([
    "set",
    key,
    token,
    "--provider",
    "keychain",
    "--key-name",
    fnoxProviderKeyName(name),
  ]);
  if (!set.ok) {
    if (secretBackendPref === "auto" && fnoxUnavailable(set.stderr)) {
      return setSecretInSqlite(name, token);
    }
    return { ok: false, error: set.stderr || "fnox set failed" };
  }
  return { ok: true };
}

function getSecretFromKeychain(name: string): string | null {
  if (secretBackendPref === "sqlite") return getSecretFromSqlite(name);
  const key = fnoxSecretKey(name);
  const got = runFnox(["get", key]);
  if (!got.ok && secretBackendPref === "auto" && fnoxUnavailable(got.stderr)) {
    return getSecretFromSqlite(name);
  }
  if (!got.ok) return null;
  return got.stdout || null;
}

function hasStoredSecret(name: string): boolean {
  return getSecretFromKeychain(name) !== null;
}

function clearSecretFromKeychain(name: string): { ok: true } | { ok: false; error: string } {
  if (secretBackendPref === "sqlite") return clearSecretFromSqlite(name);
  const key = fnoxSecretKey(name);
  const rm = runFnox(["remove", key]);
  if (!rm.ok) {
    if (secretBackendPref === "auto" && fnoxUnavailable(rm.stderr)) {
      return clearSecretFromSqlite(name);
    }
    const msg = rm.stderr.toLowerCase();
    if (msg.includes("not found") || msg.includes("missing")) {
      return { ok: true };
    }
    return { ok: false, error: rm.stderr || "fnox remove failed" };
  }
  return { ok: true };
}

async function upstreamRequest(args: {
  req: Request;
  upstreamName: string;
  upstreamUrl: string;
  payload: Json;
  sessionId?: string;
  authorization?: string;
  rewriteChallenge?: boolean;
}): Promise<{ status: number; headers: Headers; body: Json | string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  if (args.authorization) headers.set("authorization", args.authorization);
  if (args.sessionId) headers.set("mcp-session-id", args.sessionId);

  try {
    const resp = await fetch(args.upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(args.payload),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const outHeaders = new Headers(resp.headers);
      const challenge = outHeaders.get("www-authenticate");
      if (challenge && args.rewriteChallenge !== false) {
        outHeaders.set(
          "www-authenticate",
          rewriteWwwAuthenticate(challenge, args.req, args.upstreamName),
        );
      }
      return { status: resp.status, headers: outHeaders, body: text };
    }
    const ctype = resp.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      return { status: resp.status, headers: resp.headers, body: firstSsePayload(text) };
    }
    return { status: resp.status, headers: resp.headers, body: JSON.parse(text) as Json };
  } catch (error) {
    return {
      status: 502,
      headers: new Headers(),
      body: `upstream unreachable: ${String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sseResponse(payload: Json, sessionId?: string): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return new Response(body, { status: 200, headers });
}

function jsonResponse(status: number, payload: Json): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function plainResponse(status: number, body: string, headers?: Headers): Response {
  const out = new Headers({ "content-type": "text/plain; charset=utf-8" });
  if (headers) {
    for (const [k, v] of headers.entries()) {
      if (["content-type", "content-length", "connection"].includes(k.toLowerCase())) continue;
      out.set(k, v);
    }
  }
  return new Response(body, { status, headers: out });
}

function registryPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP Registry</title>
    <style>
      :root { --bg:#f6f3ee; --card:#fffefb; --ink:#1f2a2e; --muted:#607078; --line:#d9d0c2; --accent:#0f766e; --warn:#b45309; --bad:#b91c1c; }
      * { box-sizing: border-box; }
      body { margin:0; background: radial-gradient(circle at top left,#efe7da 0,#f6f3ee 40%,#f6f3ee 100%); color:var(--ink); font-family: ui-rounded, "Avenir Next", "Trebuchet MS", sans-serif; }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
      h1 { margin: 0 0 6px; font-size: 28px; }
      .sub { color: var(--muted); margin-bottom: 20px; }
      .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px; box-shadow: 0 8px 22px rgba(34,36,38,.05); }
      .name { font-weight: 700; font-size: 18px; margin-bottom: 6px; }
      .url { color: var(--muted); font-size: 12px; word-break: break-all; }
      .meta { display:flex; gap:10px; margin: 10px 0; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
      .status.ok { color: var(--accent); }
      .status.auth_required { color: var(--warn); }
      .status.error { color: var(--bad); }
      .actions { display:flex; gap:8px; flex-wrap: wrap; margin-top: 8px; }
      .tool-list { margin-top: 8px; }
      .tool-toggle { font-size: 12px; padding: 6px 9px; }
      .tool-list ul { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
      .tool-list li { margin: 2px 0; }
      button { border:1px solid var(--line); background:white; border-radius:10px; padding:7px 10px; cursor:pointer; }
      button.primary { background: var(--accent); color:#fff; border-color: var(--accent); }
      .panel { margin: 16px 0 20px; background: var(--card); border:1px solid var(--line); border-radius: 16px; padding: 14px; }
      input { border:1px solid var(--line); border-radius: 10px; padding: 8px 10px; width: 100%; margin-bottom:8px; }
      .row { display:grid; gap:8px; grid-template-columns: 1fr 2fr 2fr auto; align-items:end; }
      .tiny { font-size: 12px; color: var(--muted); margin-top:8px; }
      .notice { margin: 8px 0 14px; color: var(--muted); }
      .notice.error { color: var(--bad); }
      @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/registry/ui.js"></script>
  </body>
</html>`;
}

async function inspectOne(req: Request, upstream: Upstream): Promise<Json> {
  const auth = getSecretFromKeychain(upstream.name);
  const init = await upstreamRequest({
    req,
    upstreamName: upstream.name,
    upstreamUrl: upstream.url,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "registry-ui", version: "0.1.0" },
      },
    },
    authorization: auth ? `Bearer ${auth}` : undefined,
    rewriteChallenge: false,
  });

  const challenge = parseChallengeMetadataUrl(init.headers.get("www-authenticate"));
  if (challenge && !upstream.oauth_metadata_url) {
    setMetadataUrlStmt.run(challenge, upstream.name);
  }
  if (init.status !== 200) {
    return {
      name: upstream.name,
      url: upstream.url,
      status: init.status === 401 ? "auth_required" : "error",
      error: typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      resource_metadata_url: gatewayMetadataUrl(req, upstream.name),
      has_secret: hasStoredSecret(upstream.name),
      tool_count: 0,
      resource_count: 0,
      prompt_count: 0,
    };
  }

  const sid = init.headers.get("mcp-session-id");
  const calls = async (
    method: "tools/list" | "resources/list" | "prompts/list",
    id: number,
  ) => {
    const result = await upstreamRequest({
      req,
      upstreamName: upstream.name,
      upstreamUrl: upstream.url,
      sessionId: sid ?? undefined,
      payload: { jsonrpc: "2.0", id, method, params: {} },
      authorization: auth ? `Bearer ${auth}` : undefined,
      rewriteChallenge: false,
    });
    if (result.status !== 200) return [] as Json[];
    const obj = result.body as Json;
    const key = method.split("/")[0];
    return (((obj.result as Json | undefined)?.[key] as Json[]) ?? []);
  };

  const [tools, resources, prompts] = await Promise.all([
    calls("tools/list", 2),
    calls("resources/list", 3),
    calls("prompts/list", 4),
  ]);

  return {
    name: upstream.name,
    url: upstream.url,
    status: "ok",
    has_secret: hasStoredSecret(upstream.name),
    tool_count: tools.length,
    resource_count: resources.length,
    prompt_count: prompts.length,
    tools,
    resources,
    prompts,
  };
}

async function inspectWithTimeout(req: Request, upstream: Upstream): Promise<Json> {
  const fallback = {
    name: upstream.name,
    url: upstream.url,
    status: "timeout",
    error: "inspection timed out",
    resource_metadata_url: gatewayMetadataUrl(req, upstream.name),
    has_secret: hasStoredSecret(upstream.name),
    tool_count: 0,
    resource_count: 0,
    prompt_count: 0,
    tools: [],
    resources: [],
    prompts: [],
  } satisfies Json;

  return await Promise.race([
    inspectOne(req, upstream),
    new Promise<Json>((resolve) => setTimeout(() => resolve(fallback), registryInspectTimeoutMs)),
  ]);
}

function registryStateSnapshot(req: Request, upstreams: Upstream[]): Json[] {
  const now = Date.now();
  return upstreams.map((upstream) => {
    const cached = inspectionCache.get(upstream.name);
    const stale = !cached || now - cached.updatedAt > registryCacheTtlMs;
    if (stale) scheduleInspect(req, upstream);
    if (!cached) return defaultUpstreamState(req, upstream);
    return mergeHasSecret(cached.data, hasStoredSecret(upstream.name));
  });
}

async function fetchOAuthMetadataForUpstream(upstream: Upstream): Promise<Json | null> {
  const upstreamUrl = new URL(upstream.url);
  const candidates = upstream.oauth_metadata_url
    ? [upstream.oauth_metadata_url]
    : [
      `${upstreamUrl.origin}/.well-known/oauth-protected-resource${upstreamUrl.pathname}`,
      `${upstreamUrl.origin}/.well-known/oauth-protected-resource`,
    ];

  for (const source of candidates) {
    try {
      const resp = await fetch(source);
      if (!resp.ok) continue;
      const metadata = (await resp.json()) as Json;
      setMetadataUrlStmt.run(source, upstream.name);
      return metadata;
    } catch {
      // Try next metadata source.
    }
  }
  return null;
}

function getEnvOAuthConfig(
  upstreamName: string,
): { clientId: string; clientSecret: string | null } {
  const key = upstreamName.replace(/[^a-z0-9]/gi, "_").toUpperCase();
  const clientId = process.env[`${key}_OAUTH_CLIENT_ID`] ?? "";
  const clientSecret = process.env[`${key}_OAUTH_CLIENT_SECRET`] ?? null;
  return { clientId, clientSecret };
}

function b64url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function randomB64Url(byteLength: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256B64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return b64url(new Uint8Array(digest));
}

async function discoverAuthorizationServer(
  upstream: Upstream,
): Promise<{
  authServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  resource: string | null;
  scope: string | null;
}> {
  const metadata = await fetchOAuthMetadataForUpstream(upstream);
  if (!metadata) {
    throw new Error("OAuth resource metadata not found for upstream");
  }

  const authServer = Array.isArray(metadata.authorization_servers)
    ? String(metadata.authorization_servers[0] ?? "")
    : "";
  if (!authServer) {
    throw new Error("No authorization server advertised by upstream");
  }

  const scopes = Array.isArray(metadata.scopes_supported)
    ? metadata.scopes_supported.map((s) => String(s)).filter(Boolean)
    : [];
  const resource = metadata.resource ? String(metadata.resource) : null;

  const asMetadataUrl = `${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  const resp = await fetch(asMetadataUrl);
  if (!resp.ok) {
    throw new Error(`Authorization metadata fetch failed (${resp.status})`);
  }

  const asMeta = (await resp.json()) as Json;
  const authorizationEndpoint = String(asMeta.authorization_endpoint ?? "");
  const tokenEndpoint = String(asMeta.token_endpoint ?? "");
  const registrationEndpoint = asMeta.registration_endpoint
    ? String(asMeta.registration_endpoint)
    : null;

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("Authorization metadata missing endpoints");
  }

  return {
    authServer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    resource,
    scope: scopes.length > 0 ? scopes.join(" ") : null,
  };
}

async function ensureOAuthClient(
  req: Request,
  upstream: Upstream,
): Promise<OAuthClient> {
  const discovered = await discoverAuthorizationServer(upstream);
  const env = getEnvOAuthConfig(upstream.name);
  const existing = getOAuthClientStmt.get(upstream.name);

  const redirectUri = `${gatewayBase(req)}/registry/oauth/callback`;

  if (existing && !env.clientId && existing.redirect_uri === redirectUri) {
    return existing;
  }

  let clientId = env.clientId;
  let clientSecret = env.clientSecret;

  if (!clientId && discovered.registrationEndpoint) {
    const regResp = await fetch(discovered.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "MCP Stack Registry",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    if (regResp.ok) {
      const reg = (await regResp.json()) as Json;
      clientId = String(reg.client_id ?? "");
      clientSecret = reg.client_secret ? String(reg.client_secret) : null;
    }
  }

  if (!clientId) {
    const key = upstream.name.replace(/[^a-z0-9]/gi, "_").toUpperCase();
    throw new Error(
      `Missing OAuth client for ${upstream.name}. Set ${key}_OAUTH_CLIENT_ID (and optional ${key}_OAUTH_CLIENT_SECRET).`,
    );
  }

  upsertOAuthClientStmt.run(
    upstream.name,
    discovered.authServer,
    discovered.authorizationEndpoint,
    discovered.tokenEndpoint,
    discovered.registrationEndpoint,
    discovered.resource,
    clientId,
    clientSecret,
    discovered.scope,
    redirectUri,
  );

  return getOAuthClientStmt.get(upstream.name) as OAuthClient;
}

async function startOAuthFlow(
  req: Request,
  upstream: Upstream,
): Promise<{ authorizationUrl: string; resourceMetadataUrl: string }> {
  const client = await ensureOAuthClient(req, upstream);
  const redirectUri = `${gatewayBase(req)}/registry/oauth/callback`;
  const state = randomB64Url(24);
  const codeVerifier = randomB64Url(64);
  const codeChallenge = await sha256B64Url(codeVerifier);

  oauthState.set(state, {
    upstreamName: upstream.name,
    tokenEndpoint: client.token_endpoint,
    redirectUri,
    resource: client.resource,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    codeVerifier,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (client.scope) params.set("scope", client.scope);
  if (client.resource) params.set("resource", client.resource);

  return {
    authorizationUrl: `${client.authorization_endpoint}?${params.toString()}`,
    resourceMetadataUrl: gatewayMetadataUrl(req, upstream.name),
  };
}

async function exchangeOAuthCode(
  state: string,
  code: string,
): Promise<{ ok: true; upstreamName: string } | { ok: false; error: string }> {
  const pending = oauthState.get(state);
  if (!pending) return { ok: false, error: "Invalid OAuth state" };
  oauthState.delete(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
  });
  if (pending.resource) body.set("resource", pending.resource);
  if (pending.clientSecret) body.set("client_secret", pending.clientSecret);

  const tokenResp = await fetch(pending.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });

  if (!tokenResp.ok) {
    return { ok: false, error: `Token exchange failed (${tokenResp.status})` };
  }

  const tokenJson = (await tokenResp.json()) as Json;
  const accessToken = String(tokenJson.access_token ?? "");
  if (!accessToken) {
    return { ok: false, error: "Token response missing access_token" };
  }

  const saved = setSecretInKeychain(pending.upstreamName, accessToken);
  if (!saved.ok) return { ok: false, error: saved.error };

  return { ok: true, upstreamName: pending.upstreamName };
}

async function ensureInitialized(args: {
  req: Request;
  gatewaySessionId: string;
  upstream: Upstream;
}): Promise<{ ok: true } | { ok: false; response: Response }> {
  const map = gatewaySessions.get(args.gatewaySessionId);
  if (!map) return { ok: false, response: plainResponse(400, "missing or invalid Mcp-Session-Id") };
  if (map.has(args.upstream.name)) return { ok: true };

  const token = getSecretFromKeychain(args.upstream.name);
  const init = await upstreamRequest({
    req: args.req,
    upstreamName: args.upstream.name,
    upstreamUrl: args.upstream.url,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gateway", version: "0.1.0" },
      },
    },
    authorization: token ? `Bearer ${token}` : undefined,
  });

  if (init.status !== 200) {
    return {
      ok: false,
      response: plainResponse(
        init.status,
        typeof init.body === "string" ? init.body : JSON.stringify(init.body),
        init.headers,
      ),
    };
  }

  const sid = init.headers.get("mcp-session-id");
  if (sid) map.set(args.upstream.name, sid);
  return { ok: true };
}

async function handleMcp(req: Request): Promise<Response> {
  let rpc: Json;
  try {
    rpc = (await req.json()) as Json;
  } catch {
    return plainResponse(400, "bad request");
  }

  const method = String(rpc.method ?? "");
  const reqId = rpc.id;

  if (method === "initialize") {
    const sessionId = crypto.randomUUID().replaceAll("-", "");
    gatewaySessions.set(sessionId, new Map());
    return sseResponse(
      {
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Lightweight MCP Gateway", version: "0.2.0" },
        },
      },
      sessionId,
    );
  }

  const sessionId = req.headers.get("mcp-session-id") ?? "";
  if (!gatewaySessions.has(sessionId)) {
    return plainResponse(400, "missing or invalid Mcp-Session-Id");
  }

  const upstreams = listEnabledUpstreams();

  if (method === "tools/list") {
    const tools: Json[] = [];
    for (const upstream of upstreams) {
      const init = await ensureInitialized({ req, gatewaySessionId: sessionId, upstream });
      if (!init.ok) return init.response;

      const upstreamSession = gatewaySessions.get(sessionId)?.get(upstream.name);
      const token = getSecretFromKeychain(upstream.name);
      const result = await upstreamRequest({
        req,
        upstreamName: upstream.name,
        upstreamUrl: upstream.url,
        sessionId: upstreamSession,
        authorization: token ? `Bearer ${token}` : undefined,
        payload: {
          jsonrpc: "2.0",
          id: reqId,
          method: "tools/list",
          params: (rpc.params as Json | undefined) ?? {},
        },
      });

      if (result.status !== 200) {
        return plainResponse(
          result.status,
          typeof result.body === "string" ? result.body : JSON.stringify(result.body),
          result.headers,
        );
      }

      const upstreamTools = (((result.body as Json).result as Json | undefined)?.tools as
        | Json[]
        | undefined) ?? [];
      for (const tool of upstreamTools) {
        tools.push({ ...tool, name: `${upstream.name}__${String(tool.name ?? "tool")}` });
      }
    }
    return sseResponse({ jsonrpc: "2.0", id: reqId, result: { tools } });
  }

  if (method === "tools/call") {
    const params = (rpc.params as Json | undefined) ?? {};
    const fullName = String(params.name ?? "");
    const i = fullName.indexOf("__");
    if (i === -1) {
      return sseResponse({
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32602, message: "tool name must be namespaced as <server>__<tool>" },
      });
    }
    const upstreamName = fullName.slice(0, i);
    const toolName = fullName.slice(i + 2);
    const upstream = upstreams.find((u) => u.name === upstreamName);
    if (!upstream) {
      return sseResponse({
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32601, message: `unknown upstream: ${upstreamName}` },
      });
    }

    const init = await ensureInitialized({ req, gatewaySessionId: sessionId, upstream });
    if (!init.ok) return init.response;

    const upstreamSession = gatewaySessions.get(sessionId)?.get(upstream.name);
    const token = getSecretFromKeychain(upstream.name);
    const result = await upstreamRequest({
      req,
      upstreamName: upstream.name,
      upstreamUrl: upstream.url,
      sessionId: upstreamSession,
      authorization: token ? `Bearer ${token}` : undefined,
      payload: {
        jsonrpc: "2.0",
        id: reqId,
        method: "tools/call",
        params: { ...params, name: toolName },
      },
    });

    if (result.status !== 200) {
      return plainResponse(
        result.status,
        typeof result.body === "string" ? result.body : JSON.stringify(result.body),
        result.headers,
      );
    }
    return sseResponse(result.body as Json);
  }

  return sseResponse({
    jsonrpc: "2.0",
    id: reqId,
    error: { code: -32601, message: `method not supported by gateway: ${method}` },
  });
}

const serveOptions: Bun.Serve = {
  port,
  idleTimeout: 60,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return plainResponse(200, "ok");
    }

    if (req.method === "GET" && url.pathname === "/registry") {
      return new Response(registryPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && url.pathname === "/registry/ws") {
      const upstreams = listEnabledUpstreams();
      const snapshot = registryStateSnapshot(req, upstreams);
      if (server.upgrade(req, { data: { initialState: snapshot } })) {
        return new Response(null);
      }
      return plainResponse(400, "websocket upgrade failed");
    }

    if (req.method === "GET" && url.pathname === "/registry/oauth/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description") ?? "";

      if (error) {
        const html = `<!doctype html><html><body><h2>Authentication failed</h2><p>${error}${
          errorDescription ? `: ${errorDescription}` : ""
        }</p></body></html>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (!code || !state) {
        return plainResponse(400, "Missing OAuth callback parameters");
      }

      const exchanged = await exchangeOAuthCode(state, code);
      if (!exchanged.ok) {
        const html =
          `<!doctype html><html><body><h2>Authentication failed</h2><p>${exchanged.error}</p></body></html>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      const authedUpstream = getUpstreamStmt.get(exchanged.upstreamName);
      if (authedUpstream) scheduleInspect(req, authedUpstream);

      const html =
        `<!doctype html><html><body><h2>Authenticated ${exchanged.upstreamName}</h2><p>Returning to the registry...</p><script>const target='/registry?auth=success&upstream=${
          encodeURIComponent(exchanged.upstreamName)
        }';if(window.opener&&!window.opener.closed){window.opener.location=target;window.close();}else{setTimeout(()=>location.replace(target),250);}</script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && url.pathname === "/registry/ui.js") {
      try {
        const source = await Bun.file(registryUiPath).text();
        const js = registryUiTranspiler.transformSync(source);
        return new Response(js, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      } catch (error) {
        return plainResponse(500, `failed to transpile /registry/ui.js: ${String(error)}`);
      }
    }

    if (req.method === "GET" && url.pathname === "/registry/api/state") {
      const rows = listEnabledUpstreams();
      const snapshot = registryStateSnapshot(req, rows);
      return jsonResponse(200, { upstreams: snapshot });
    }

    if (req.method === "POST" && url.pathname === "/registry/api/upstreams") {
      const body = (await req.json()) as Json;
      const name = String(body.name ?? "").trim();
      const mcpUrl = String(body.url ?? "").trim();
      const metadata = body.oauthMetadataUrl === null || body.oauthMetadataUrl === undefined
        ? null
        : String(body.oauthMetadataUrl).trim();
      if (!/^[a-z0-9_-]+$/i.test(name)) {
        return jsonResponse(400, { error: "name must be alphanumeric, _, or -" });
      }
      if (!/^https?:\/\//i.test(mcpUrl)) {
        return jsonResponse(400, { error: "url must start with http:// or https://" });
      }
      upsertUpstreamStmt.run(name, mcpUrl, metadata || null);
      const upstream = getUpstreamStmt.get(name);
      if (upstream) {
        broadcastUpstreamState(name);
        scheduleInspect(req, upstream);
      }
      return jsonResponse(200, { ok: true });
    }

    if (
      req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/disable$/.test(url.pathname)
    ) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      setEnabledStmt.run(0, name);
      broadcastRegistry({ type: "removed", name });
      return jsonResponse(200, { ok: true });
    }

    if (req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/remove$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      const upstream = getUpstreamStmt.get(name);
      if (!upstream) return jsonResponse(404, { error: "unknown upstream" });
      deleteUpstreamStmt.run(name);
      inspectionCache.delete(name);
      inspectionInFlight.delete(name);
      broadcastRegistry({ type: "removed", name });
      return jsonResponse(200, { ok: true });
    }

    if (
      req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/inspect$/.test(url.pathname)
    ) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      const upstream = getUpstreamStmt.get(name);
      if (!upstream) return jsonResponse(404, { error: "unknown upstream" });
      const inspected = await inspectWithTimeout(req, upstream);
      inspectionCache.set(name, { data: inspected, updatedAt: Date.now() });
      return jsonResponse(200, inspected);
    }

    if (req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/auth$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      const upstream = getUpstreamStmt.get(name);
      if (!upstream) return jsonResponse(404, { error: "unknown upstream" });
      try {
        const flow = await startOAuthFlow(req, upstream);
        return jsonResponse(200, {
          name,
          resource_metadata_url: flow.resourceMetadataUrl,
          authorization_url: flow.authorizationUrl,
        });
      } catch (error) {
        const message = String(error);
        if (
          message.includes("Missing OAuth client for")
          || message.includes("Authorization metadata fetch failed")
          || message.includes("Authorization metadata missing endpoints")
          || message.includes("OAuth resource metadata not found")
        ) {
          return jsonResponse(200, {
            name,
            resource_metadata_url: gatewayMetadataUrl(req, name),
            authorization_url: null,
            manual_token_required: true,
            manual_token_url: null,
            message:
              `${message} Interactive OAuth is unavailable for this upstream. Use the Store Token button to save a bearer token instead.`,
          });
        }
        return jsonResponse(500, { error: message });
      }
    }

    if (req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/secret$/.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      const upstream = getUpstreamStmt.get(name);
      if (!upstream) return jsonResponse(404, { error: "unknown upstream" });
      const body = (await req.json()) as Json;
      const token = String(body.token ?? "").trim();
      if (!token) return jsonResponse(400, { error: "token is required" });
      const saved = setSecretInKeychain(name, token);
      if (!saved.ok) return jsonResponse(500, { error: saved.error });
      broadcastUpstreamState(name);
      scheduleInspect(req, upstream);
      return jsonResponse(200, { ok: true });
    }

    if (
      req.method === "POST" && /^\/registry\/api\/upstreams\/[^/]+\/disconnect$/.test(url.pathname)
    ) {
      const name = decodeURIComponent(url.pathname.split("/")[4] || "");
      const upstream = getUpstreamStmt.get(name);
      if (!upstream) return jsonResponse(404, { error: "unknown upstream" });
      const cleared = clearSecretFromKeychain(name);
      if (!cleared.ok) return jsonResponse(500, { error: cleared.error });
      broadcastUpstreamState(name);
      scheduleInspect(req, upstream);
      return jsonResponse(200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      const upstreamName = url.searchParams.get("upstream");
      const upstream = upstreamName
        ? getUpstreamStmt.get(upstreamName)
        : listEnabledUpstreams().find((u) => Boolean(u.oauth_metadata_url));
      if (!upstream) return plainResponse(404, "Not found");
      const metadata = await fetchOAuthMetadataForUpstream(upstream);
      if (!metadata) return plainResponse(404, "Not found");
      metadata.resource = `${gatewayBase(req)}/mcp`;
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(req);
    }

    return plainResponse(404, "Not found");
  },
  websocket: {
    open(ws) {
      registrySockets.add(ws);
      const initialState = ws.data.initialState;
      if (initialState) {
        ws.send(JSON.stringify({ type: "state", upstreams: initialState }));
      }
    },
    close(ws) {
      registrySockets.delete(ws);
    },
    message() {
      // No-op: server push only.
    },
  },
};

if (tlsCertPath && tlsKeyPath) {
  const cert = await Bun.file(tlsCertPath).text();
  const key = await Bun.file(tlsKeyPath).text();
  serveOptions.tls = { cert, key };
}

const server = Bun.serve(serveOptions);

console.log(`Gateway listening on :${server.port}`);
