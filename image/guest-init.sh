#!/bin/bash
# Gondolin Agent Image — Guest Init Script
#
# This script runs inside the Gondolin VM after the base OS init completes.
# It starts the agent stack in order:
#   1. sandbox-agent on :2468 (AI agent orchestrator)
#   2. Wait for sandbox-agent health check
#   3. dink-adapter (Dink edge sidecar, connects to external dinkd)
#   4. Signal ready to host via Dink edge registration
#
# Graceful shutdown: SIGTERM → stop dink-adapter → stop sandbox-agent

set -eu

CONSOLE="/dev/console"
if [ ! -c "${CONSOLE}" ]; then
  if [ -c /dev/ttyAMA0 ]; then
    CONSOLE="/dev/ttyAMA0"
  elif [ -c /dev/ttyS0 ]; then
    CONSOLE="/dev/ttyS0"
  else
    CONSOLE=""
  fi
fi

log() {
  local ts=""
  ts=$(date '+%H:%M:%S' 2>/dev/null || echo "??:??:??")
  if [ -n "${CONSOLE}" ]; then
    printf "[gondolin %s] %s\n" "${ts}" "$*" > "${CONSOLE}" 2>/dev/null || \
      printf "[gondolin %s] %s\n" "${ts}" "$*"
  else
    printf "[gondolin %s] %s\n" "${ts}" "$*"
  fi
}

# --- Configuration ---

SANDBOX_AGENT_BIN="${SANDBOX_AGENT_BIN:-/usr/bin/sandbox-agent}"
SANDBOX_AGENT_PORT="${SANDBOX_AGENT_PORT:-2468}"
SANDBOX_AGENT_URL="http://localhost:${SANDBOX_AGENT_PORT}"

DINK_ADAPTER_BIN="${DINK_ADAPTER_BIN:-/opt/dink-adapter/index.mjs}"
DINK_NATS_URL="${DINK_NATS_URL:-nats://78.47.49.84:4222}"

HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-30}"
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-0.5}"

# PIDs for cleanup
SANDBOX_AGENT_PID=""
DINK_ADAPTER_PID=""

# --- Graceful Shutdown ---

cleanup() {
  log "shutting down..."

  if [ -n "${DINK_ADAPTER_PID}" ]; then
    log "stopping dink-adapter (PID ${DINK_ADAPTER_PID})"
    kill "${DINK_ADAPTER_PID}" 2>/dev/null || true
    wait "${DINK_ADAPTER_PID}" 2>/dev/null || true
    log "dink-adapter stopped"
  fi

  if [ -n "${SANDBOX_AGENT_PID}" ]; then
    log "stopping sandbox-agent (PID ${SANDBOX_AGENT_PID})"
    kill "${SANDBOX_AGENT_PID}" 2>/dev/null || true
    wait "${SANDBOX_AGENT_PID}" 2>/dev/null || true
    log "sandbox-agent stopped"
  fi

  log "shutdown complete"
}

trap cleanup TERM INT QUIT

# --- Step 1: Start sandbox-agent ---

if [ ! -x "${SANDBOX_AGENT_BIN}" ]; then
  log "ERROR: sandbox-agent binary not found at ${SANDBOX_AGENT_BIN}"
  exit 1
fi

log "starting sandbox-agent on :${SANDBOX_AGENT_PORT}"
"${SANDBOX_AGENT_BIN}" &
SANDBOX_AGENT_PID=$!
log "sandbox-agent started (PID ${SANDBOX_AGENT_PID})"

# --- Step 2: Wait for sandbox-agent health ---

log "waiting for sandbox-agent health check..."
elapsed=0
healthy=0

while [ "${elapsed}" -lt "${HEALTH_CHECK_TIMEOUT}" ]; do
  if curl -sf "${SANDBOX_AGENT_URL}/v1/health" > /dev/null 2>&1; then
    healthy=1
    break
  fi

  # Check if sandbox-agent is still running
  if ! kill -0 "${SANDBOX_AGENT_PID}" 2>/dev/null; then
    log "ERROR: sandbox-agent exited unexpectedly"
    exit 1
  fi

  sleep "${HEALTH_CHECK_INTERVAL}"
  elapsed=$((elapsed + 1))
done

if [ "${healthy}" -ne 1 ]; then
  log "ERROR: sandbox-agent health check timed out after ${HEALTH_CHECK_TIMEOUT}s"
  cleanup
  exit 1
fi

log "sandbox-agent healthy"

# --- Step 3: Start dink-adapter ---

if [ -f "${DINK_ADAPTER_BIN}" ]; then
  log "starting dink-adapter (NATS: ${DINK_NATS_URL})"
  DINK_NATS_URL="${DINK_NATS_URL}" \
  SANDBOX_AGENT_URL="${SANDBOX_AGENT_URL}" \
  node "${DINK_ADAPTER_BIN}" &
  DINK_ADAPTER_PID=$!
  log "dink-adapter started (PID ${DINK_ADAPTER_PID})"
else
  log "WARNING: dink-adapter not found at ${DINK_ADAPTER_BIN}, skipping"
fi

# --- Step 4: Signal ready ---

log "agent stack ready"
printf "ok\n" > /run/gondolin-agent.ready

# --- Wait for processes ---

# Monitor processes — if either exits, shut down the other
while true; do
  if ! kill -0 "${SANDBOX_AGENT_PID}" 2>/dev/null; then
    log "sandbox-agent exited, shutting down"
    break
  fi
  if [ -n "${DINK_ADAPTER_PID}" ] && ! kill -0 "${DINK_ADAPTER_PID}" 2>/dev/null; then
    log "dink-adapter exited, shutting down"
    break
  fi
  sleep 1
done

cleanup
