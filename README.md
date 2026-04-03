# Unified MCP Stack (OrbStack Optimized)

This project provides a fully containerized, secure, and unified Model Context Protocol (MCP) stack using **Nginx as a high-performance proxy**. It is specifically optimized to run on **macOS Apple Silicon** using **OrbStack**, avoiding common issues with Docker socket dependencies.

## Architecture

The stack consists of four primary services running in isolated Docker containers:

1. **Unified Nginx Proxy**: Acts as a central gateway. It routes traffic based on the URL path.
2. **Context7 MCP Server**: Provides documentation and code context.
3. **GitHub MCP Server**: Provides GitHub tools over MCP with OAuth support.
4. **Lightweight MCP Aggregation Gateway**: Exposes a single `/mcp` endpoint and aggregates tools from downstream MCP servers.

## Key Features

- **Zero Port Exposure**: All port numbers are abstracted into the `.env` file for maximum security and flexibility.
- **Dynamic Configuration**: Uses `nginx.conf.template` to automatically inject environment variables at startup.
- **Zero Docker Socket Dependency**: The proxy does not require `/var/run/docker.sock`, significantly improving security.
- **Unified Access**: A single MCP endpoint (`/mcp`) exposes tools from multiple downstream servers.
- **Hardened Security**:
  - Containers run with `read_only: true` filesystems.
  - Capabilities are dropped (`cap_drop: ALL`).
  - No privilege escalation allowed (`no-new-privileges: true`).
  - Internal servers are not exposed to the host/internet; only the Proxy is reachable.

## Getting Started

### Prerequisites

- [OrbStack](https://orbstack.dev/) (or Docker Desktop)
- An Olares instance for SearXNG (configured in `.env`)

### Installation

1. **Start the stack:**
   ```bash
   docker-compose up -d
   ```

   The stack now ships with sensible defaults in `.env`, so no configuration is required for local startup.
   Only set `CONTEXT7_API_KEY` if your Context7 provider requires one.
   GitHub MCP is configured for OAuth by default; keep `GITHUB_PERSONAL_ACCESS_TOKEN` empty unless you explicitly want PAT mode.

2. **Verify the services:**
   ```bash
   docker-compose ps
   ```

## Connecting to Clients

### Zed

Zed is already configured to use the following endpoints:

- **Context7**: `http://localhost:${GATEWAY_PORT}/context7/mcp`
- **GitHub**: `http://localhost:${GATEWAY_PORT}/github/mcp`
- **Unified Gateway (recommended)**: `http://localhost:${GATEWAY_PORT}/mcp`

When using the unified gateway endpoint, tools are namespaced as `<server>__<tool>` (for example `context7__resolve-library-id`).
GitHub-backed tool calls use OAuth challenge flow; your MCP client should prompt once and then reuse the token.

You can verify these settings in your Zed `settings.json` file (`cmd+,`).

## Configuration Files

- **`docker-compose.yml`**: The main orchestration file. Uses environment variables for all network settings.
- **`nginx.conf.template`**: The routing template that dynamically configures the proxy.
- **`gateway/server.ts`**: Lightweight MCP aggregation service used by `/mcp`.
- **`.env`**: **The only place** where secrets, URLs, and port numbers are stored.
- **`.env.example`**: Starter defaults for local setup.

## Troubleshooting

- **Port Busy**: If the `${GATEWAY_PORT}` is already in use, simply change it in the `.env` file and restart.
- **Configuration Sync**: If you change ports in `.env`, run `docker-compose up -d` to regenerate the proxy configuration.
