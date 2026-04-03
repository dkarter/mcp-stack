type Json = Record<string, unknown>

const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT ?? "20") * 1000
const upstreamsRaw =
  process.env.MCP_UPSTREAMS ??
  "context7=http://context7:8000/mcp,github=http://github:8082/mcp"
const metadataSource =
  process.env.MCP_OAUTH_METADATA_SOURCE ??
  "http://github:8082/.well-known/oauth-protected-resource/mcp"
const port = Number(process.env.PORT ?? "8090")

function parseUpstreams(raw: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const name = trimmed.slice(0, eq).trim()
    const url = trimmed.slice(eq + 1).trim()
    if (name && url) output[name] = url
  }
  return output
}

const upstreams = parseUpstreams(upstreamsRaw)
const sessions = new Map<string, Map<string, string>>()

function gatewayBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1"
  const proto = req.headers.get("x-forwarded-proto") ?? "http"
  return `${proto}://${host}`
}

function rewriteWwwAuthenticate(value: string, req: Request): string {
  const marker = 'resource_metadata="'
  const start = value.indexOf(marker)
  if (start === -1) return value
  const valueStart = start + marker.length
  const end = value.indexOf('"', valueStart)
  if (end === -1) return value
  const replacement = `${gatewayBase(req)}/.well-known/oauth-protected-resource/mcp`
  return `${value.slice(0, valueStart)}${replacement}${value.slice(end)}`
}

function firstSsePayload(text: string): Json {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const raw = line.slice(5).trim()
    if (!raw) continue
    return JSON.parse(raw) as Json
  }
  throw new Error("No SSE data payload found")
}

async function upstreamRequest(args: {
  req: Request
  upstreamUrl: string
  payload: Json
  sessionId?: string
}): Promise<{
  status: number
  headers: Headers
  body: Json | string
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs)

  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  })

  const auth = args.req.headers.get("authorization")
  if (auth) headers.set("authorization", auth)
  if (args.sessionId) headers.set("mcp-session-id", args.sessionId)

  try {
    const response = await fetch(args.upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(args.payload),
      signal: controller.signal,
    })

    const text = await response.text()
    const ctype = response.headers.get("content-type") ?? ""

    if (!response.ok) {
      const outHeaders = new Headers(response.headers)
      const challenge = outHeaders.get("www-authenticate")
      if (challenge) {
        outHeaders.set("www-authenticate", rewriteWwwAuthenticate(challenge, args.req))
      }
      return { status: response.status, headers: outHeaders, body: text }
    }

    if (ctype.includes("text/event-stream")) {
      return {
        status: response.status,
        headers: response.headers,
        body: firstSsePayload(text),
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: JSON.parse(text) as Json,
    }
  } catch (error) {
    return {
      status: 502,
      headers: new Headers(),
      body: `upstream unreachable: ${String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function sseResponse(payload: Json, sessionId?: string): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
  })
  if (sessionId) headers.set("mcp-session-id", sessionId)
  return new Response(body, { status: 200, headers })
}

function plainResponse(status: number, body: string, headers?: Headers): Response {
  const out = new Headers({ "content-type": "text/plain; charset=utf-8" })
  if (headers) {
    for (const [k, v] of headers.entries()) {
      const lower = k.toLowerCase()
      if (["content-type", "content-length", "connection"].includes(lower)) continue
      out.set(k, v)
    }
  }
  return new Response(body, { status, headers: out })
}

async function ensureUpstreamInitialized(args: {
  req: Request
  gatewaySessionId: string
  upstreamName: string
  initParams: Json
}): Promise<{ ok: true } | { ok: false; response: Response }> {
  const map = sessions.get(args.gatewaySessionId)
  if (!map) {
    return { ok: false, response: plainResponse(400, "missing or invalid Mcp-Session-Id") }
  }
  if (map.has(args.upstreamName)) return { ok: true }

  const initResult = await upstreamRequest({
    req: args.req,
    upstreamUrl: upstreams[args.upstreamName],
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: args.initParams,
    },
  })

  if (initResult.status !== 200) {
    return {
      ok: false,
      response: plainResponse(
        initResult.status,
        typeof initResult.body === "string"
          ? initResult.body
          : JSON.stringify(initResult.body),
        initResult.headers,
      ),
    }
  }

  const sid = initResult.headers.get("mcp-session-id")
  if (sid) map.set(args.upstreamName, sid)

  return { ok: true }
}

async function handleMcp(req: Request): Promise<Response> {
  let rpc: Json
  try {
    rpc = (await req.json()) as Json
  } catch {
    return plainResponse(400, "bad request")
  }

  const method = String(rpc.method ?? "")
  const reqId = rpc.id

  if (method === "initialize") {
    const sessionId = crypto.randomUUID().replaceAll("-", "")
    sessions.set(sessionId, new Map())
    return sseResponse(
      {
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Lightweight MCP Gateway", version: "0.1.0" },
        },
      },
      sessionId,
    )
  }

  const gatewaySession = req.headers.get("mcp-session-id") ?? ""
  if (!sessions.has(gatewaySession)) {
    return plainResponse(400, "missing or invalid Mcp-Session-Id")
  }

  if (method === "tools/list") {
    const allTools: Json[] = []

    for (const [upstreamName, upstreamUrl] of Object.entries(upstreams)) {
      const init = await ensureUpstreamInitialized({
        req,
        gatewaySessionId: gatewaySession,
        upstreamName,
        initParams: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "gateway", version: "0.1.0" },
        },
      })
      if (!init.ok) return init.response

      const upstreamSession = sessions.get(gatewaySession)?.get(upstreamName)
      const result = await upstreamRequest({
        req,
        upstreamUrl,
        sessionId: upstreamSession,
        payload: {
          jsonrpc: "2.0",
          id: reqId,
          method: "tools/list",
          params: (rpc.params as Json | undefined) ?? {},
        },
      })

      if (result.status !== 200) {
        return plainResponse(
          result.status,
          typeof result.body === "string" ? result.body : JSON.stringify(result.body),
          result.headers,
        )
      }

      const tools = (((result.body as Json).result as Json | undefined)?.tools as
        | Json[]
        | undefined) ?? []

      for (const tool of tools) {
        const name = String(tool.name ?? "tool")
        allTools.push({ ...tool, name: `${upstreamName}__${name}` })
      }
    }

    return sseResponse({ jsonrpc: "2.0", id: reqId, result: { tools: allTools } })
  }

  if (method === "tools/call") {
    const params = (rpc.params as Json | undefined) ?? {}
    const fullName = String(params.name ?? "")
    const sep = fullName.indexOf("__")

    if (sep === -1) {
      return sseResponse({
        jsonrpc: "2.0",
        id: reqId,
        error: {
          code: -32602,
          message: "tool name must be namespaced as <server>__<tool>",
        },
      })
    }

    const upstreamName = fullName.slice(0, sep)
    const toolName = fullName.slice(sep + 2)
    const upstreamUrl = upstreams[upstreamName]
    if (!upstreamUrl) {
      return sseResponse({
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32601, message: `unknown upstream: ${upstreamName}` },
      })
    }

    const init = await ensureUpstreamInitialized({
      req,
      gatewaySessionId: gatewaySession,
      upstreamName,
      initParams: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gateway", version: "0.1.0" },
      },
    })
    if (!init.ok) return init.response

    const upstreamSession = sessions.get(gatewaySession)?.get(upstreamName)
    const result = await upstreamRequest({
      req,
      upstreamUrl,
      sessionId: upstreamSession,
      payload: {
        jsonrpc: "2.0",
        id: reqId,
        method: "tools/call",
        params: { ...params, name: toolName },
      },
    })

    if (result.status !== 200) {
      return plainResponse(
        result.status,
        typeof result.body === "string" ? result.body : JSON.stringify(result.body),
        result.headers,
      )
    }

    return sseResponse(result.body as Json)
  }

  return sseResponse({
    jsonrpc: "2.0",
    id: reqId,
    error: { code: -32601, message: `method not supported by gateway: ${method}` },
  })
}

const server = Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/health") {
      return plainResponse(200, "ok")
    }

    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      try {
        const response = await fetch(metadataSource)
        if (!response.ok) return plainResponse(404, "Not found")
        const data = (await response.json()) as Json
        data.resource = `${gatewayBase(req)}/mcp`
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        })
      } catch {
        return plainResponse(404, "Not found")
      }
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      return handleMcp(req)
    }

    return plainResponse(404, "Not found")
  },
})

console.log(`Gateway listening on :${server.port}`)
