/// <reference lib="dom" />

import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type JsonRecord = Record<string, unknown>;

type RegistryTool = {
  name?: string;
};

type RegistryUpstream = {
  name: string;
  url: string;
  status: "ok" | "auth_required" | "error" | string;
  has_secret: boolean;
  tool_count: number;
  resource_count: number;
  prompt_count: number;
  tools?: RegistryTool[];
};

type RegistryWsMessage =
  | { type: "state"; upstreams: RegistryUpstream[] }
  | { type: "upstream"; upstream: RegistryUpstream }
  | { type: "removed"; name: string };

type CardProps = {
  upstream: RegistryUpstream;
  onRefresh: (name: string) => Promise<void>;
  onAuth: (name: string) => Promise<void>;
  onStore: (name: string) => Promise<void>;
  onDisconnect: (name: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
};

function Card({ upstream, onRefresh, onAuth, onStore, onDisconnect, onRemove }: CardProps) {
  const [showTools, setShowTools] = useState(false);

  const toolNames = useMemo(
    () =>
      (upstream.tools ?? [])
        .map((tool) => String(tool.name ?? "").trim())
        .filter(Boolean),
    [upstream.tools],
  );

  return (
    <div className="card">
      <div className="name">{upstream.name}</div>
      <div className="url">{upstream.url}</div>
      <div className="meta">
        <span className={`status ${upstream.status}`}>{upstream.status}</span>
        <span>tools: {upstream.tool_count}</span>
        <span>resources: {upstream.resource_count}</span>
        <span>prompts: {upstream.prompt_count}</span>
        <span>secret: {upstream.has_secret ? "stored" : "none"}</span>
      </div>

      <div className="tool-list">
        <button className="tool-toggle" onClick={() => setShowTools((open) => !open)}>
          {showTools ? "Hide Tools" : "Show Tools"} ({toolNames.length})
        </button>
        {showTools
          ? (
            toolNames.length > 0
              ? (
                <ul>
                  {toolNames.map((toolName) => <li key={toolName}>{toolName}</li>)}
                </ul>
              )
              : <div className="tiny">No tools discovered yet.</div>
          )
          : null}
      </div>

      <div className="actions">
        <button onClick={() => onRefresh(upstream.name)}>Refresh</button>
        <button onClick={() => onAuth(upstream.name)}>Authenticate</button>
        <button onClick={() => onStore(upstream.name)}>Store Token</button>
        <button onClick={() => onDisconnect(upstream.name)}>Disconnect</button>
        <button onClick={() => onRemove(upstream.name)}>Remove</button>
      </div>
    </div>
  );
}

function App() {
  const cacheKey = "mcp-registry-upstreams";
  const [upstreams, setUpstreams] = useState<RegistryUpstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [oauthMetadataUrl, setOauthMetadataUrl] = useState("");

  const applySnapshot = useCallback((next: RegistryUpstream[]) => {
    setUpstreams(next);
    localStorage.setItem(cacheKey, JSON.stringify(next));
  }, []);

  const upsertUpstream = useCallback((next: RegistryUpstream) => {
    setUpstreams((prev) => {
      const i = prev.findIndex((upstream) => upstream.name === next.name);
      if (i === -1) return [...prev, next];
      const updated = [...prev];
      updated[i] = next;
      return updated;
    });
  }, []);

  const readJson = useCallback(async (res: Response): Promise<JsonRecord> => {
    try {
      return (await res.json()) as JsonRecord;
    } catch {
      return {};
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/registry/api/state");
      const data = await readJson(res);
      const next = Array.isArray(data.upstreams) ? (data.upstreams as RegistryUpstream[]) : [];
      applySnapshot(next);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, readJson]);

  useEffect(() => {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed)) setUpstreams(parsed as RegistryUpstream[]);
      }
    } catch {
      // Ignore cache parse errors.
    }
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "success") {
      const upstreamName = params.get("upstream") || "upstream";
      setNotice(`Authenticated ${upstreamName}`);
      setNoticeError(false);
      window.history.replaceState({}, "", "/registry");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(cacheKey, JSON.stringify(upstreams));
  }, [upstreams]);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${proto}//${window.location.host}/registry/ws`);

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as RegistryWsMessage;
          if (message.type === "state" && Array.isArray(message.upstreams)) {
            applySnapshot(message.upstreams);
            setLoading(false);
            return;
          }
          if (message.type === "upstream" && message.upstream) {
            upsertUpstream(message.upstream);
            return;
          }
          if (message.type === "removed" && message.name) {
            setUpstreams((prev) => prev.filter((upstream) => upstream.name !== message.name));
          }
        } catch {
          // Ignore invalid websocket messages.
        }
      };

      socket.onclose = () => {
        if (closed) return;
        retryTimer = window.setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [applySnapshot, upsertUpstream]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, 30000);
    return () => window.clearInterval(id);
  }, [load]);

  const refresh = useCallback(async (upstreamName: string) => {
    await fetch(`/registry/api/upstreams/${encodeURIComponent(upstreamName)}/inspect`, {
      method: "POST",
    });
    await load();
    setNotice(`Refreshed ${upstreamName}`);
    setNoticeError(false);
  }, [load]);

  const authenticate = useCallback(async (upstreamName: string) => {
    const res = await fetch(`/registry/api/upstreams/${encodeURIComponent(upstreamName)}/auth`, {
      method: "POST",
    });
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(String(data.error ?? "Authentication request failed"));
      setNoticeError(true);
      return;
    }

    if (data.manual_token_required) {
      if (data.manual_token_url) {
        window.open(String(data.manual_token_url), "_blank", "noopener,noreferrer");
      }
      setNotice(
        String(
          data.message
            ?? `Interactive OAuth is unavailable for ${upstreamName}. Use Store Token to save a bearer token.`,
        ),
      );
      setNoticeError(false);
      return;
    }

    const target = String(data.authorization_url ?? data.resource_metadata_url ?? "");
    if (!target) {
      setNotice("No authentication URL available");
      setNoticeError(true);
      return;
    }

    window.open(target, "_blank", "noopener,noreferrer");
    setNotice(`Opened auth URL for ${upstreamName}`);
    setNoticeError(false);
  }, [readJson]);

  const storeToken = useCallback(async (upstreamName: string) => {
    const token = window.prompt(`Paste bearer token for ${upstreamName}`);
    if (!token) return;

    const res = await fetch(`/registry/api/upstreams/${encodeURIComponent(upstreamName)}/secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(String(data.error ?? "Failed to store token"));
      setNoticeError(true);
      return;
    }

    setUpstreams((prev) =>
      prev.map((upstream) =>
        upstream.name === upstreamName ? { ...upstream, has_secret: true } : upstream
      )
    );
    void load();
    setNotice(`Stored token for ${upstreamName}`);
    setNoticeError(false);
  }, [load, readJson]);

  const disconnect = useCallback(async (upstreamName: string) => {
    const confirmed = window.confirm(
      `Disconnect ${upstreamName}? This only removes the saved token. The upstream remains in the registry.`,
    );
    if (!confirmed) return;

    const res = await fetch(
      `/registry/api/upstreams/${encodeURIComponent(upstreamName)}/disconnect`,
      {
        method: "POST",
      },
    );
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(String(data.error ?? "Failed to disconnect"));
      setNoticeError(true);
      return;
    }

    setUpstreams((prev) =>
      prev.map((upstream) =>
        upstream.name === upstreamName ? { ...upstream, has_secret: false } : upstream
      )
    );
    void load();
    setNotice(`Disconnected ${upstreamName}. Upstream is still registered.`);
    setNoticeError(false);
  }, [load, readJson]);

  const removeUpstream = useCallback(async (upstreamName: string) => {
    const confirmed = window.confirm(
      `Remove ${upstreamName} from registry? This removes the upstream entry and any stored token.`,
    );
    if (!confirmed) return;

    const res = await fetch(`/registry/api/upstreams/${encodeURIComponent(upstreamName)}/remove`, {
      method: "POST",
    });
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(String(data.error ?? "Failed to remove upstream"));
      setNoticeError(true);
      return;
    }

    await load();
    setNotice(`Removed ${upstreamName} from registry`);
    setNoticeError(false);
  }, [load, readJson]);

  const addUpstream = useCallback(async () => {
    const res = await fetch("/registry/api/upstreams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        url,
        oauthMetadataUrl: oauthMetadataUrl || null,
      }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      setNotice(String(data.error ?? "Failed to add upstream"));
      setNoticeError(true);
      return;
    }

    setName("");
    setUrl("");
    setOauthMetadataUrl("");
    await load();
    setNotice("Added upstream");
    setNoticeError(false);
  }, [load, name, oauthMetadataUrl, readJson, url]);

  return (
    <div className="wrap">
      <h1>MCP Registry</h1>
      <div className="sub">
        Discover servers, inspect tools/resources/prompts, and trigger auth from one place.
      </div>

      <div className="panel">
        <div className="row">
          <div>
            <label>Name</label>
            <input
              value={name}
              placeholder="server-name"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div>
            <label>MCP URL</label>
            <input
              value={url}
              placeholder="https://example.com/mcp"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <div>
            <label>OAuth Metadata URL (optional)</label>
            <input
              value={oauthMetadataUrl}
              placeholder="https://example.com/.well-known/oauth-protected-resource/mcp"
              onChange={(event) => setOauthMetadataUrl(event.target.value)}
            />
          </div>

          <button className="primary" onClick={addUpstream}>Add Server</button>
        </div>
        <div className="tiny">
          Gateway state is in SQLite. Secret backend is configured by SECRET_BACKEND (fnox/sqlite).
        </div>
      </div>

      {notice ? <div className={noticeError ? "notice error" : "notice"}>{notice}</div> : null}

      <div className="grid">
        {loading && upstreams.length === 0
          ? <div className="tiny">Loading upstreams...</div>
          : null}
        {upstreams.map((upstream) => (
          <Card
            key={upstream.name}
            upstream={upstream}
            onRefresh={refresh}
            onAuth={authenticate}
            onStore={storeToken}
            onDisconnect={disconnect}
            onRemove={removeUpstream}
          />
        ))}
      </div>
    </div>
  );
}

const app = document.getElementById("app");
if (app) {
  createRoot(app).render(<App />);
}
