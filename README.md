# Unified MCP Stack (OrbStack Optimized)

This project provides a secure, unified Model Context Protocol (MCP) stack with a host-run lightweight aggregation gateway and an Nginx proxy in Docker.

## Architecture

The stack includes these primary services:

1. **Unified Nginx Proxy**: Acts as a central gateway. It routes traffic based on the URL path.
2. **Context7 MCP Server**: Provides documentation and code context.
3. **GitHub MCP Server**: Provides GitHub tools over MCP with OAuth support.
4. **E2B MCP Server**: Exposes E2B tools through a lightweight HTTP adapter.
5. **Lightweight MCP Aggregation Gateway (host)**: Exposes a single `/mcp` endpoint and aggregates tools from downstream MCP servers. It runs on the host by default so fnox keychain storage works naturally.

## Key Features

- **Zero Port Exposure**: All port numbers are abstracted into the `.env` file for maximum security and flexibility.
- **Dynamic Configuration**: Uses `nginx.conf.template` to automatically inject environment variables at startup.
- **Zero Docker Socket Dependency**: The proxy does not require `/var/run/docker.sock`, significantly improving security.
- **Unified Access**: A single MCP endpoint (`/mcp`) exposes tools from multiple downstream servers.
- **Registry UI**: A local UI at `/registry` to discover upstream MCPs, inspect tools/resources/prompts, and trigger auth challenges.
- **Hardened Security**:
  - Containers run with `read_only: true` filesystems.
  - Capabilities are dropped (`cap_drop: ALL`).
  - No privilege escalation allowed (`no-new-privileges: true`).
  - Internal servers are not exposed to the host/internet; only the Proxy is reachable.

## Getting Started

### Prerequisites

- [OrbStack](https://orbstack.dev/) (or Docker Desktop)
- [mise](https://mise.jdx.dev/) + `mise install` (installs `bun` and `fnox`)

### Secret handling

- Do not put secrets in `.env`.
- Store secrets in fnox keychain and run components with `fnox exec ...`.
- The provided mise tasks already do this.

### Installation

1. **Start MCP containers + proxy:**
   ```bash
   mise run stack-up
   ```

   This starts Context7, GitHub MCP, E2B, and Nginx proxy using `fnox exec`.

2. **Start the gateway on host (default):**
   ```bash
   mise run gateway-local
   ```

   Keep this running in a separate terminal.

   The stack ships with sensible non-secret defaults in `.env`.
   Add secrets to fnox as needed (`CONTEXT7_API_KEY`, `E2B_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`).

3. **Verify the services:**
   ```bash
   docker compose ps
   ```

### Host Gateway Mode (default)

If you want cross-platform keychain-backed secret storage via fnox, run the gateway locally:

```bash
fnox exec --if-missing warn -- env \
  SECRET_BACKEND="fnox" \
  MCP_UPSTREAMS="context7=http://127.0.0.1:8047/mcp,github=http://127.0.0.1:8048/mcp,e2b=http://127.0.0.1:8050/mcp" \
  GATEWAY_DB_PATH="./gateway/gateway.db" \
  bun gateway/server.ts
```

This exposes:

- `http://localhost:8090/mcp`
- `http://localhost:8090/registry`

`SECRET_BACKEND=fnox` is the default and stores tokens in keychain via fnox.
If needed, set `SECRET_BACKEND=sqlite` to store tokens in SQLite instead.

## Connecting to Clients

### Zed

Zed is already configured to use the following endpoints:

- **Context7**: `http://localhost:${GATEWAY_PORT}/context7/mcp`
- **GitHub**: `http://localhost:${GATEWAY_PORT}/github/mcp`
- **E2B**: `http://localhost:${GATEWAY_PORT}/e2b/mcp`
- **Unified Gateway (recommended, proxied)**: `http://localhost:${GATEWAY_PORT}/mcp`
- **Unified Gateway (local mode)**: `http://localhost:8090/mcp`
- **Registry UI**: `http://localhost:${GATEWAY_PORT}/registry`

When using the unified gateway endpoint, tools are namespaced as `<server>__<tool>` (for example `context7__resolve-library-id`).
From the Registry UI, you can add additional HTTP MCP servers (for example Linear at `https://mcp.linear.app/mcp`).
Gateway upstream state is persisted in SQLite. Secret storage defaults to fnox keychain (`SECRET_BACKEND=fnox`).

For providers that do not support dynamic OAuth client registration, set OAuth app credentials in `.env` before using the UI auth button:

- `<UPSTREAM_NAME>_OAUTH_CLIENT_ID`
- `<UPSTREAM_NAME>_OAUTH_CLIENT_SECRET` (if required by the provider)

`<UPSTREAM_NAME>` is the uppercased upstream name from the registry UI with non-alphanumeric characters replaced by `_`.

You can verify these settings in your Zed `settings.json` file (`cmd+,`).

## Configuration Files

- **`docker-compose.yml`**: The main orchestration file. Uses environment variables for all network settings.
- **`nginx.conf.template`**: The routing template that dynamically configures the proxy.
- **`gateway/server.ts`**: Lightweight MCP aggregation service used by `/mcp` and `/registry`.
- **`mise.toml`**: Includes `stack-up`, `stack-down`, and `gateway-local` tasks for the host-first workflow.
- **`e2b/http-adapter.js`**: HTTP adapter that bridges `mcp/e2b` (stdio) to `/mcp`.
- **`.env`**: **The only place** where secrets, URLs, and port numbers are stored.
- **`.env.example`**: Starter defaults for local setup.

## Troubleshooting

- **Port Busy**: If the `${GATEWAY_PORT}` is already in use, simply change it in the `.env` file and restart.
- **Configuration Sync**: If you change ports in `.env`, run `mise run stack-up` to regenerate the proxy configuration.
