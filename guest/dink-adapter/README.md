# @earendil-works/gondolin-dink-adapter

Dink edge sidecar for Gondolin VMs. Runs alongside `sandbox-agent` inside the VM and bridges it to the Dink mesh, exposing three services:

- **AgentService** — 7 unary RPCs proxied to `sandbox-agent` HTTP API
- **AgentEventStreamService** — SSE-to-Dink streaming bridge
- **TerminalService** — PTY terminal management via `node-pty`

## Architecture

```
┌─────────────── Gondolin VM ───────────────┐
│                                           │
│  sandbox-agent (:2468)                    │
│       ↑ HTTP/SSE                          │
│  dink-adapter                             │
│       ↓ NATS                              │
│                                           │
└──────────── outbound to dinkd ────────────┘
                  ↓
         external dinkd (NATS)
                  ↓
         host / browser clients
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DINKD_URL` | `nats://78.47.49.84:4222` | External dinkd NATS URL |
| `WORKSPACE_ID` | `default` | Workspace identifier for edge labels |
| `AGENT_TYPE` | `claude` | Agent type label |
| `SANDBOX_AGENT_URL` | `http://localhost:2468` | Local sandbox-agent URL |

## Development

```bash
pnpm install
pnpm test          # Run unit tests (no external deps needed)
pnpm build         # Bundle (requires @fatagnus/dink-sdk + node-pty)
pnpm typecheck     # TypeScript check
```

## Testing

Unit tests mock the `SandboxAgent` HTTP client and `node-pty` spawn function, so they run without any external dependencies:

```bash
pnpm test
```

Integration tests (A-TEST-1 through A-TEST-3) require a running dinkd and are run in the VM image.
