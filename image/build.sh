#!/usr/bin/env bash
# Gondolin Agent Image Build Script
#
# Builds a Gondolin VM image containing:
#   - sandbox-agent (Rust binary, cross-compiled for aarch64)
#   - dink-adapter (TypeScript bundle)
#   - AI agent CLIs (claude-code, codex, opencode, amp)
#   - node-pty (native module for TerminalService)
#   - Base Alpine Linux with Node.js, git, bash, etc.
#
# Prerequisites:
#   - Zig toolchain (for guest binaries: sandboxd, sandboxfs, sandboxssh)
#   - Rust toolchain with aarch64-unknown-linux-musl target (for sandbox-agent)
#   - Node.js + pnpm (for dink-adapter bundling)
#   - e2fsprogs (mke2fs for rootfs image creation)
#   - lz4, cpio, curl, python3 (for Alpine package installation)
#
# Usage:
#   ./build.sh                    # Build with defaults
#   ARCH=x86_64 ./build.sh       # Build for x86_64
#   SKIP_AGENT_CLIS=1 ./build.sh # Skip npm AI agent CLIs (faster builds)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GONDOLIN_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
REPO_ROOT=$(cd "${GONDOLIN_ROOT}/../.." && pwd)
GUEST_DIR="${GONDOLIN_ROOT}/guest"
GUEST_IMAGE_DIR="${GUEST_DIR}/image"

# Use the base build script for Alpine rootfs creation
BASE_BUILD="${GUEST_IMAGE_DIR}/build.sh"

ARCH=${ARCH:-$(uname -m)}
if [[ "${ARCH}" == "arm64" ]]; then
    ARCH="aarch64"
fi

OUT_DIR=${OUT_DIR:-"${SCRIPT_DIR}/out"}
SKIP_AGENT_CLIS=${SKIP_AGENT_CLIS:-0}

echo "=== Gondolin Agent Image Build ==="
echo "Architecture: ${ARCH}"
echo "Output: ${OUT_DIR}"
echo ""

# --- Step 1: Build base Alpine rootfs with guest binaries ---

echo ">>> Step 1: Building base Alpine rootfs..."

# Add sandbox-agent-specific packages to the base build
# The base build.sh already includes: bash, nodejs, npm, git, curl, etc.
# We add FUSE support and exclude openssh
ROOTFS_PACKAGES="${ROOTFS_PACKAGES:-linux-virt rng-tools bash ca-certificates curl nodejs npm uv python3 fuse}" \
OUT_DIR="${OUT_DIR}" \
    bash "${BASE_BUILD}"

ROOTFS_DIR="${OUT_DIR}/rootfs"

echo ">>> Base rootfs built"

# --- Step 2: Cross-compile sandbox-agent (if binary not provided) ---

SANDBOX_AGENT_BIN="${SANDBOX_AGENT_BIN:-}"

if [[ -z "${SANDBOX_AGENT_BIN}" ]]; then
    SANDBOX_AGENT_SERVER="${REPO_ROOT}/packages/sandbox-agent/server"
    if [[ -d "${SANDBOX_AGENT_SERVER}" ]]; then
        echo ">>> Step 2: Cross-compiling sandbox-agent for ${ARCH}..."

        RUST_TARGET=""
        case "${ARCH}" in
            aarch64) RUST_TARGET="aarch64-unknown-linux-musl" ;;
            x86_64)  RUST_TARGET="x86_64-unknown-linux-musl" ;;
            *)       echo "ERROR: Unsupported arch ${ARCH} for sandbox-agent" >&2; exit 1 ;;
        esac

        (cd "${SANDBOX_AGENT_SERVER}" && \
            cargo build --release --target "${RUST_TARGET}" 2>&1) || {
            echo "WARNING: sandbox-agent cross-compilation failed."
            echo "  You can provide a pre-built binary via SANDBOX_AGENT_BIN env var."
            echo "  Continuing without sandbox-agent..."
        }

        BUILT_BIN="${SANDBOX_AGENT_SERVER}/target/${RUST_TARGET}/release/sandbox-agent"
        if [[ -f "${BUILT_BIN}" ]]; then
            SANDBOX_AGENT_BIN="${BUILT_BIN}"
        fi
    else
        echo ">>> Step 2: sandbox-agent server not found at ${SANDBOX_AGENT_SERVER}, skipping"
    fi
fi

if [[ -n "${SANDBOX_AGENT_BIN}" && -f "${SANDBOX_AGENT_BIN}" ]]; then
    echo ">>> Installing sandbox-agent binary..."
    install -m 0755 "${SANDBOX_AGENT_BIN}" "${ROOTFS_DIR}/usr/bin/sandbox-agent"
else
    echo ">>> WARNING: sandbox-agent binary not available — image will not have agent support"
fi

# --- Step 3: Bundle dink-adapter ---

DINK_ADAPTER_DIR="${GONDOLIN_ROOT}/guest/dink-adapter"
DINK_ADAPTER_BUNDLE="${DINK_ADAPTER_BUNDLE:-}"

if [[ -z "${DINK_ADAPTER_BUNDLE}" && -d "${DINK_ADAPTER_DIR}" ]]; then
    echo ">>> Step 3: Bundling dink-adapter..."

    if [[ -f "${DINK_ADAPTER_DIR}/package.json" ]]; then
        (cd "${DINK_ADAPTER_DIR}" && pnpm install --frozen-lockfile 2>/dev/null || npm install 2>/dev/null || true)

        # Bundle with esbuild or tsup
        if command -v esbuild >/dev/null 2>&1; then
            esbuild "${DINK_ADAPTER_DIR}/index.ts" \
                --bundle \
                --platform=node \
                --format=esm \
                --outfile="${OUT_DIR}/dink-adapter.mjs" \
                --external:node-pty 2>&1
            DINK_ADAPTER_BUNDLE="${OUT_DIR}/dink-adapter.mjs"
        else
            echo "WARNING: esbuild not found, skipping dink-adapter bundle"
        fi
    else
        echo ">>> dink-adapter package.json not found, skipping bundle"
    fi
fi

if [[ -n "${DINK_ADAPTER_BUNDLE}" && -f "${DINK_ADAPTER_BUNDLE}" ]]; then
    echo ">>> Installing dink-adapter bundle..."
    mkdir -p "${ROOTFS_DIR}/opt/dink-adapter"
    install -m 0644 "${DINK_ADAPTER_BUNDLE}" "${ROOTFS_DIR}/opt/dink-adapter/index.mjs"
else
    echo ">>> WARNING: dink-adapter bundle not available — skipping"
fi

# --- Step 4: Install node-pty native module ---

echo ">>> Step 4: Installing node-pty for TerminalService..."
if [[ -d "${ROOTFS_DIR}/opt/dink-adapter" ]]; then
    mkdir -p "${ROOTFS_DIR}/opt/dink-adapter/node_modules"
    # node-pty requires native compilation for target arch
    # In cross-compilation scenarios, this would use prebuild or cross-compile
    echo ">>> NOTE: node-pty native module must be compiled for target arch (${ARCH})"
    echo ">>> For development, node-pty will be installed at runtime inside the VM"
fi

# --- Step 5: Install AI agent CLIs ---

if [[ "${SKIP_AGENT_CLIS}" -eq 0 ]]; then
    echo ">>> Step 5: Installing AI agent CLIs..."

    # Install global npm packages into the rootfs
    # These will be available as commands inside the VM
    AGENT_CLIS=(
        "@anthropic-ai/claude-code"
        # "codex"    # Add when stable
        # "opencode" # Add when stable
        # "amp"      # Add when stable
    )

    for cli in "${AGENT_CLIS[@]}"; do
        echo "    Installing ${cli}..."
        # Use npm with --prefix to install into rootfs
        npm install --global --prefix "${ROOTFS_DIR}/usr" "${cli}" 2>/dev/null || {
            echo "    WARNING: Failed to install ${cli}, skipping"
        }
    done
else
    echo ">>> Step 5: Skipping AI agent CLIs (SKIP_AGENT_CLIS=1)"
fi

# --- Step 6: Install guest-init.sh ---

echo ">>> Step 6: Installing guest-init.sh..."
install -m 0755 "${SCRIPT_DIR}/guest-init.sh" "${ROOTFS_DIR}/opt/guest-init.sh"

# --- Step 7: Remove excluded packages ---

echo ">>> Step 7: Removing excluded packages (openssh, dropbear)..."
# Remove any SSH-related binaries that may have been pulled in as dependencies
rm -f "${ROOTFS_DIR}/usr/sbin/sshd" 2>/dev/null || true
rm -f "${ROOTFS_DIR}/usr/bin/ssh" 2>/dev/null || true
rm -f "${ROOTFS_DIR}/usr/bin/ssh-keygen" 2>/dev/null || true
rm -f "${ROOTFS_DIR}/usr/sbin/dropbear" 2>/dev/null || true
rm -rf "${ROOTFS_DIR}/etc/ssh" 2>/dev/null || true

# --- Step 8: Create workspace mount point ---

echo ">>> Step 8: Creating workspace mount point..."
mkdir -p "${ROOTFS_DIR}/workspace"

# --- Done ---

# --- Step 9: Rebuild rootfs image with all modifications ---

echo ">>> Step 9: Rebuilding rootfs ext4 image with all additions..."

# Locate mke2fs
MKFS_EXT4=""
if command -v mke2fs >/dev/null 2>&1; then
    MKFS_EXT4="mke2fs"
elif command -v mkfs.ext4 >/dev/null 2>&1; then
    MKFS_EXT4="mkfs.ext4"
elif [[ "$(uname -s)" == "Darwin" ]]; then
    for candidate in \
        /opt/homebrew/opt/e2fsprogs/sbin/mke2fs \
        /opt/homebrew/opt/e2fsprogs/bin/mke2fs \
        /usr/local/opt/e2fsprogs/sbin/mke2fs \
        /usr/local/opt/e2fsprogs/bin/mke2fs; do
        if [[ -x "${candidate}" ]]; then
            MKFS_EXT4="${candidate}"
            break
        fi
    done
fi

ROOTFS_IMAGE="${OUT_DIR}/rootfs.ext4"
ROOTFS_LABEL="gondolin-root"

if [[ -n "${MKFS_EXT4}" ]]; then
    size_kb=$(du -sk "${ROOTFS_DIR}" | awk '{print $1}')
    size_kb=$((size_kb + size_kb / 5 + 65536))
    size_mb=$(((size_kb + 1023) / 1024))

    "${MKFS_EXT4}" \
        -t ext4 \
        -d "${ROOTFS_DIR}" \
        -L "${ROOTFS_LABEL}" \
        -m 0 \
        -O ^has_journal \
        -E lazy_itable_init=0,lazy_journal_init=0 \
        -b 4096 \
        -F "${ROOTFS_IMAGE}" "${size_mb}M"
    echo ">>> rootfs image rebuilt: ${ROOTFS_IMAGE}"
else
    echo ">>> WARNING: mke2fs not found — rootfs image not rebuilt"
    echo ">>> Install e2fsprogs and rerun, or use the rootfs directory directly"
fi

echo ""
echo "=== Gondolin Agent Image Build Complete ==="
echo "Rootfs image: ${ROOTFS_IMAGE}"
echo "Initramfs:    ${OUT_DIR}/initramfs.cpio.lz4"
echo ""
echo "Contents:"
[[ -x "${ROOTFS_DIR}/usr/bin/sandbox-agent" ]] && echo "  ✓ sandbox-agent" || echo "  ✗ sandbox-agent (not available)"
[[ -f "${ROOTFS_DIR}/opt/dink-adapter/index.mjs" ]] && echo "  ✓ dink-adapter" || echo "  ✗ dink-adapter (not available)"
[[ -f "${ROOTFS_DIR}/opt/guest-init.sh" ]] && echo "  ✓ guest-init.sh" || echo "  ✗ guest-init.sh"
[[ -x "${ROOTFS_DIR}/usr/bin/node" ]] && echo "  ✓ Node.js" || echo "  ✗ Node.js"
[[ -x "${ROOTFS_DIR}/usr/bin/git" ]] && echo "  ✓ git" || echo "  ✗ git"
[[ -x "${ROOTFS_DIR}/usr/bin/bash" ]] && echo "  ✓ bash" || echo "  ✗ bash"
[[ ! -x "${ROOTFS_DIR}/usr/sbin/sshd" ]] && echo "  ✓ no sshd" || echo "  ✗ sshd found (should be removed!)"
