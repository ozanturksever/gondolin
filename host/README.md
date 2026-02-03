# Host Controller

This package contains the host-side CLI and WebSocket controller for the sandbox VM.

## Current state
- QEMU is launched with a **virtio-serial** control channel and a **virtio-net** device wired to a host socket backend.
- The host runs a **TypeScript network stack** (`NetworkStack`) that implements Ethernet framing, ARP, IPv4, ICMP, DHCP, TCP, and UDP.
- All guest traffic flows through the host network stack. TCP/UDP are NATed via Node sockets.
- DNS is handled through the UDP path (guest currently uses `8.8.8.8`).
- A WS test (`pnpm run test:ws`) exercises guest HTTP/HTTPS fetches against icanhazip.com.

## What is *not* implemented yet
- TLS MITM / re-encryption (custom CA) is **not** implemented yet.
- Traffic policy / firewalling (HTTP/HTTPS-only allowlist) is **not** implemented yet.

## Useful commands
- `pnpm run dev:ws -- --net-debug` to start the WS server with network debug logging.
- `pnpm run test:ws` to run the guest HTTP/HTTPS fetch test via WS.

## Dependencies
- `ws`: required to expose the WebSocket exec API and stream stdout/stderr. The runtime footprint is acceptable for the host controller service.
- `@types/ws`: dev-only typings for TypeScript.
