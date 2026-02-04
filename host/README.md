# Gondolin Host Controller

This package contains the host-side CLI and WebSocket controller for the sandbox
VM.

## Current state

- QEMU is launched with a **virtio-serial** control channel and a **virtio-net** device wired to a host socket backend.
- A WebSocket server exposes an exec API (stdin/pty + streaming stdout/stderr) that the CLI and `VM` client use.
- The host runs a **TypeScript network stack** (`NetworkStack`) that implements Ethernet framing, ARP, IPv4, ICMP, DHCP, TCP, and UDP.
- TCP flows are classified; only HTTP and TLS are accepted (CONNECT is rejected). Other TCP traffic is dropped.
- HTTP/HTTPS requests are terminated on the host and bridged via `fetch` (undici) with optional request/response hooks and DNS-rebind-safe allowlist checks.
- TLS MITM is implemented: a local CA + per-host leaf certs are generated under `var/mitm` and used to re-encrypt TLS.
- UDP forwarding is limited to DNS (port 53). The guest still points at `8.8.8.8` by default.
- A WS test (`pnpm run test:ws`) exercises guest HTTP/HTTPS fetches against icanhazip.com.
- The `VM` client exposes hookable VFS mounts (defaults to a `MemoryProvider` at `/`) for filesystem policy experiments.

## What is *not* implemented yet
- SandboxPolicy allow/deny rules are defined but not enforced for DNS/HTTP/TLS.
- Generic TCP/UDP passthrough (beyond HTTP/TLS + DNS) is not supported.

## Networking approach

Instead of attaching the VM to a real bridge/tap device, QEMU streams raw
Ethernet frames over a Unix socket into a TypeScript network stack.  That stack
decodes ARP/IP/TCP/UDP and deliberately only allows HTTP and TLS.  When an HTTP
flow is detected (or TLS that can be MITM'ed), the host intercepts the request
in JavaScript and replays it via `fetch`.  This gives a single, portable control
point for policy enforcement, logging, and request/response hooks without
granting the guest arbitrary socket access or requiring privileged host network
setup.

## Filesystem hooks

`VM` can expose hookable VFS mounts (defaults to `MemoryProvider` at `/`). Pass
mounts and optional hooks via `vfs` (or set `vfs: null` to disable) and access
the provider with `getVfs()`:

```ts
import { VM } from "./src/vm";
import { MemoryProvider } from "./src/vfs";

const vm = new VM({
  vfs: {
    mounts: { "/": new MemoryProvider() },
    hooks: {
      before: (ctx) => console.log("before", ctx.op, ctx.path),
      after: (ctx) => console.log("after", ctx.op, ctx.path),
    },
  },
});

const vfs = vm.getVfs();
```

Use `fuseMount` in the `vfs` options to change the guest mount point (defaults to `/data`).

## Running bash

Launch an interactive bash session in the VM:

```bash
pnpm run bash
```

Programmatically via the `VM` class:

```ts
import { VM } from "./src/vm";

const vm = new VM();
await vm.shell(); // opens interactive bash, attached to stdin/stdout
await vm.close();
```

## HTTP hooks

Use `createHttpHooks` to configure network access with host allowlists and secret
injection. Secrets are replaced in outgoing request headers only when sent to
their allowed hosts:

```ts
import { VM } from "./src/vm";
import { createHttpHooks } from "./src/http-hooks";

const { httpHooks, env } = createHttpHooks({
  // Only allow requests to these hosts (wildcards supported)
  allowedHosts: ["api.example.com", "*.github.com"],

  // Secrets are injected into request headers for matching hosts
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
    API_KEY: {
      hosts: ["api.example.com"],
      value: "sk-secret-key",
    },
  },

  // Block requests to internal/private IP ranges (default: true)
  blockInternalRanges: true,

  // Optional: custom request/response hooks
  onRequest: async (request) => {
    console.log("request:", request.method, request.url);
    return request;
  },
  onResponse: async (request, response) => {
    console.log("response:", response.status);
    return response;
  },
});

// The `env` object contains placeholder values for secrets.
// Pass them to exec so guest code can use $GITHUB_TOKEN etc.
// The actual secret is injected on the host when the request matches.
const vm = new VM({ httpHooks, env });

await vm.exec("curl -H 'Authorization: Bearer $GITHUB_TOKEN' https://api.github.com/user");

await vm.close();
```

The secret placeholders prevent the real credentials from ever being visible
inside the guest. The host intercepts HTTP requests and replaces the
placeholder with the actual secret only if the target host matches.

## Exploration Bash

The `gondolin bash` command provides a quick way to explore the sandbox with
configurable filesystem mounts and network access. This is useful for testing,
debugging, and interactive exploration.

### Basic Usage

```bash
# Start a basic bash session with default memory-backed VFS
pnpm run bash

# Or via the CLI directly
npx tsx bin/gondolin.ts bash
```

### Mounting Host Directories

Mount host directories into the sandbox using `--mount-hostfs`:

```bash
# Mount a host directory read-write
gondolin bash --mount-hostfs /home/user/project:/workspace

# Mount read-only (append :ro)
gondolin bash --mount-hostfs /data:/data:ro

# Multiple mounts
gondolin bash --mount-hostfs /src:/workspace --mount-hostfs /config:/etc/app:ro
```

The mount format follows Docker conventions: `HOST_PATH:GUEST_PATH[:ro]`

### Memory-backed Mounts

Create ephemeral memory-backed filesystems at specific paths using `--mount-memfs`:

```bash
# Create a memory-backed /tmp
gondolin bash --mount-memfs /tmp

# Combine with host mounts
gondolin bash --mount-hostfs /data:/data:ro --mount-memfs /tmp --mount-memfs /scratch
```

### Network Access

Control which hosts the sandbox can reach with `--allow-host`:

```bash
# Allow access to specific hosts
gondolin bash --allow-host api.github.com --allow-host httpbin.org

# Wildcards are supported
gondolin bash --allow-host "*.example.com"
```

### Secret Injection

Inject secrets that are only sent to specific hosts using `--host-secret`:

```bash
# Read secret from environment variable $GITHUB_TOKEN
gondolin bash --allow-host api.github.com --host-secret GITHUB_TOKEN@api.github.com

# Explicit secret value
gondolin bash --host-secret API_KEY@api.example.com=sk-secret-key

# Multiple hosts for one secret
gondolin bash --host-secret TOKEN@api.example.com,staging.example.com
```

The secret format is: `NAME@HOST[,HOST...][=VALUE]`
- If `=VALUE` is omitted, the value is read from the environment variable `$NAME`
- The secret is injected into HTTP headers only when requests match the specified hosts
- The actual secret value never enters the guest; only a placeholder is visible

### Combined Example

```bash
# Full development setup:
# - Mount project directory read-write
# - Mount dependencies read-only  
# - Ephemeral temp directory
# - Allow GitHub API with token from environment
gondolin bash \
  --mount-hostfs ~/project:/workspace \
  --mount-hostfs ~/.npm:/root/.npm:ro \
  --mount-memfs /tmp \
  --allow-host api.github.com \
  --host-secret GITHUB_TOKEN@api.github.com
```

### Using with exec

The same options work with `gondolin exec` for non-interactive commands:

```bash
# Run a command with mounted filesystem
gondolin exec --mount-hostfs /src:/workspace -- ls -la /workspace

# Build with network access
gondolin exec \
  --mount-hostfs ~/project:/workspace \
  --allow-host registry.npmjs.org \
  -- sh -c "cd /workspace && npm install"
```

## Useful commands
- `pnpm run dev:ws -- --net-debug` to start the WS server with network debug logging.
- `GONDOLIN_DEBUG=net pnpm run dev:ws` to enable the same logging via env (comma separated).
- `pnpm run test:ws` to run the guest HTTP/HTTPS fetch test via WS.
- `pnpm run bash` to launch a quick interactive Bash session against the VM.
