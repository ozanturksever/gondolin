# Gondolin Agent Image

The Gondolin agent image is a minimal Alpine Linux VM image designed for running AI coding agents in isolated sandboxes. It contains everything needed for secure, network-connected AI agent execution without SSH.

## Image Contents

| Component | Version | Description |
|-----------|---------|-------------|
| **Alpine Linux** | 3.23 | Base OS (minimal rootfs) |
| **sandbox-agent** | latest | Rust binary — AI agent orchestrator (HTTP :2468) |
| **dink-adapter** | latest | TypeScript sidecar — Dink edge registration + RPC proxy |
| **Node.js** | 20+ LTS | Runtime for dink-adapter and AI agent CLIs |
| **node-pty** | latest | Native PTY module for TerminalService |
| **claude-code** | latest | Anthropic Claude Code CLI agent |
| **git** | latest | Version control |
| **bash** | latest | Shell |
| **sandboxd** | latest | Zig binary — guest control daemon (virtio-serial RPC) |
| **sandboxfs** | latest | Zig binary — FUSE filesystem for host VFS mount |

### Explicitly Excluded

- **openssh / sshd** — Terminal access is via TerminalService over Dink streaming
- **SSH keys** — Not needed; no SSH daemon
- **Port forwarding tools** — dink-adapter connects outbound to external dinkd

## Build Prerequisites

- **Zig toolchain** — For guest binaries (sandboxd, sandboxfs, sandboxssh)
- **Rust toolchain** — With `aarch64-unknown-linux-musl` target for sandbox-agent cross-compilation
- **Node.js + pnpm** — For dink-adapter bundling
- **e2fsprogs** — `mke2fs` for creating ext4 rootfs images
  - macOS: `brew install e2fsprogs`
  - Linux: `apt install e2fsprogs` or `apk add e2fsprogs`
- **lz4** — For initramfs compression
- **cpio** — For initramfs archive creation
- **curl** — For downloading Alpine packages
- **python3** — For Alpine package resolution

## Build Commands

```bash
# Build with defaults (aarch64, all components)
cd packages/gondolin/image
./build.sh

# Build for x86_64
ARCH=x86_64 ./build.sh

# Fast build — skip AI agent CLI installation
SKIP_AGENT_CLIS=1 ./build.sh

# Use a pre-built sandbox-agent binary
SANDBOX_AGENT_BIN=/path/to/sandbox-agent ./build.sh

# Use a pre-bundled dink-adapter
DINK_ADAPTER_BUNDLE=/path/to/dink-adapter.mjs ./build.sh

# Custom output directory
OUT_DIR=/tmp/gondolin-build ./build.sh
```

### Build Output

```
packages/gondolin/image/out/
├── rootfs.ext4           # Root filesystem image
├── initramfs.cpio.lz4    # Initial ramdisk
└── rootfs/               # Unpacked rootfs (for inspection)
```

## Boot Sequence

The VM boots through three stages:

### 1. Initramfs (`initramfs-init`)
- Mounts proc, sys, devtmpfs
- Loads virtio_blk and ext4 kernel modules
- Mounts root filesystem from `/dev/vda`
- Optionally sets up overlayfs (for COW root)
- `switch_root` to real rootfs

### 2. Base Init (`guest/image/init`)
- Mounts tmpfs for /tmp, /root, /var
- Loads virtio_console, virtio_rng, virtio_net modules
- Configures networking (DHCP via udhcpc)
- Starts sandboxfs FUSE mount at `/workspace` (or configured path)
- Starts sandboxssh (legacy SSH helper)
- Starts sandboxd (guest control daemon)

### 3. Agent Init (`guest-init.sh`)
- **Start sandbox-agent** on `:2468`
- **Wait for health check** (`GET /v1/health`, timeout 30s)
- **Start dink-adapter** (connects to external dinkd at `nats://78.47.49.84:4222`)
- **Signal ready** (writes `/run/gondolin-agent.ready`)
- **Monitor processes** — if either exits, graceful shutdown of both

### Startup Timeline

```
t=0s     VM boot → initramfs
t=0.5s   switch_root → base init
t=1s     sandboxd + sandboxfs started
t=2s     sandbox-agent started
t=3-5s   sandbox-agent healthy
t=4-6s   dink-adapter connected to dinkd
t=5-7s   VM edge registered → host discovers via Dink → READY
```

## Network Requirements

The VM needs outbound network access to:

| Destination | Port | Protocol | Purpose |
|-------------|------|----------|---------|
| `78.47.49.84` | 4222 | NATS | dink-adapter → dinkd (edge registration, RPC) |
| `78.47.49.84` | 8222 | HTTP | dink-adapter → dinkd (HTTP API) |
| `api.anthropic.com` | 443 | HTTPS | Claude API calls |
| `api.openai.com` | 443 | HTTPS | OpenAI API calls |
| `*` | 443 | HTTPS | General internet (AI agent API calls) |

**No inbound ports** are needed. The dink-adapter connects outbound to the external dinkd server.

### Internal Services (localhost only)

| Service | Port | Protocol |
|---------|------|----------|
| sandbox-agent | 2468 | HTTP |

## Debugging

### Serial Console

The VM writes all init logs to the serial console (`/dev/console` or `/dev/ttyAMA0`). When running with Gondolin CLI:

```bash
# Run with debug output
gondolin bash --debug=all

# Run with specific debug flags
gondolin bash --debug=boot,net
```

### Checking Service Status

Inside the VM:

```bash
# Check if agent stack is ready
cat /run/gondolin-agent.ready

# Check sandbox-agent health
curl -s http://localhost:2468/v1/health

# Check running processes
ps aux | grep -E 'sandbox-agent|dink-adapter|sandboxd|sandboxfs'

# Check if sshd is NOT running (should not be)
ps aux | grep sshd
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| sandbox-agent health timeout | Binary missing or crash | Check `SANDBOX_AGENT_BIN` path, check console logs |
| dink-adapter won't connect | Network not configured | Ensure DHCP succeeded, check `ip addr` |
| sandboxfs not mounted | FUSE module not loaded | Check `lsmod | grep fuse`, `modprobe fuse` |
| No AI agent CLIs | `SKIP_AGENT_CLIS=1` or npm install failed | Rebuild without `SKIP_AGENT_CLIS` |

## Environment Variables

### Build-time

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCH` | auto-detect | Target architecture (`aarch64`, `x86_64`) |
| `OUT_DIR` | `./out` | Build output directory |
| `SKIP_AGENT_CLIS` | `0` | Skip npm AI agent CLI installation |
| `SANDBOX_AGENT_BIN` | (auto-build) | Path to pre-built sandbox-agent binary |
| `DINK_ADAPTER_BUNDLE` | (auto-bundle) | Path to pre-bundled dink-adapter |
| `EXTRA_PACKAGES` | (none) | Additional Alpine packages to install |

### Runtime (inside VM)

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_AGENT_BIN` | `/usr/bin/sandbox-agent` | Path to sandbox-agent binary |
| `SANDBOX_AGENT_PORT` | `2468` | sandbox-agent HTTP port |
| `DINK_ADAPTER_BIN` | `/opt/dink-adapter/index.mjs` | Path to dink-adapter bundle |
| `DINK_NATS_URL` | `nats://78.47.49.84:4222` | External dinkd NATS URL |
| `HEALTH_CHECK_TIMEOUT` | `30` | sandbox-agent health check timeout (seconds) |
