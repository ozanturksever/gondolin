# Gondolin Documentation

This directory contains additional documentation for Gondolin.

## Guides

- [CLI](./cli.md): Run interactive shells and commands inside a micro-VM
- [SDK (TypeScript) reference](./sdk.md): how to use the JavaScript SDK
- [SSH](./ssh.md): enable SSH access to the guest with safe defaults
- [Debug logging](./debug.md): documents the debug logging facility
- [Custom images](./custom-images.md): how to build custom guest images (kernel/initramfs/rootfs) and configure packages/init scripts

## Architecture

- [Security design](./security.md): Threat model, guarantees, and safe operating envelope
- [Network stack](./network.md): how networking works (HTTP/TLS mediation, policy enforcement, DNS)
- [QEMU](./qemu.md): how Gondolin runs QEMU and how this stays consistent on macOS and Linux

## Other references

- [Host README (quick start)](../host/README.md)
