import { SandboxAgentHttp, waitForHealth } from "./sandbox-agent.js";
import { AgentServiceImpl } from "./agent-service.js";
import { EventStreamImpl } from "./event-stream.js";
import { TerminalServiceImpl } from "./terminal-service.js";
import type { PtySpawnFn } from "./types.js";

export { AgentServiceImpl } from "./agent-service.js";
export { EventStreamImpl } from "./event-stream.js";
export { TerminalServiceImpl } from "./terminal-service.js";
export { SandboxAgentHttp, waitForHealth } from "./sandbox-agent.js";
export type { SandboxAgent } from "./sandbox-agent.js";
export * from "./types.js";

// ---------------------------------------------------------------------------
// Entry point — only runs when executed as a script (not when imported)
// ---------------------------------------------------------------------------

const DINKD_URL = process.env.DINKD_URL ?? "nats://78.47.49.84:4222";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "default";
const AGENT_TYPE = process.env.AGENT_TYPE ?? "claude";
const SANDBOX_AGENT_URL = process.env.SANDBOX_AGENT_URL ?? "http://localhost:2468";
const HEALTH_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  console.log(`[dink-adapter] starting (workspace=${WORKSPACE_ID}, agent=${AGENT_TYPE})`);
  console.log(`[dink-adapter] dinkd=${DINKD_URL}, sandbox-agent=${SANDBOX_AGENT_URL}`);

  // 1. Wait for sandbox-agent health
  console.log("[dink-adapter] waiting for sandbox-agent health...");
  await waitForHealth(SANDBOX_AGENT_URL, globalThis.fetch.bind(globalThis), HEALTH_TIMEOUT_MS);
  console.log("[dink-adapter] sandbox-agent is healthy");

  // 2. Create service implementations
  const httpClient = new SandboxAgentHttp(SANDBOX_AGENT_URL, globalThis.fetch.bind(globalThis));
  const agentService = new AgentServiceImpl(httpClient);
  const eventStream = new EventStreamImpl(httpClient);

  // node-pty is loaded dynamically since it's a native module
  let spawnPty: PtySpawnFn;
  try {
    const nodePty = await import("node-pty");
    spawnPty = nodePty.spawn;
  } catch (err) {
    console.warn("[dink-adapter] node-pty not available, terminal service disabled:", err);
    spawnPty = () => {
      throw new Error("node-pty is not available");
    };
  }
  const terminalService = new TerminalServiceImpl(spawnPty);

  // 3. Connect to Dink and register services
  //    NOTE: @fatagnus/dink-sdk must be installed for this to work.
  //    When running in the VM image, this dependency is pre-installed.
  const { EdgeClient } = await import("@fatagnus/dink-sdk");
  const { AgentServiceHandler } = await import(
    "../../../contracts/generated/ts/agentservice.handler.js"
  );
  const { AgentEventStreamServiceHandler } = await import(
    "../../../contracts/generated/ts/agenteventstreamservice.handler.js"
  );
  const { TerminalServiceHandler } = await import(
    "../../../contracts/generated/ts/terminalservice.handler.js"
  );

  const edge = new EdgeClient({
    url: DINKD_URL,
    labels: {
      workspaceId: WORKSPACE_ID,
      role: "vm",
      agentType: AGENT_TYPE,
    },
  });

  edge.registerService(new AgentServiceHandler(agentService));
  edge.registerService(new AgentEventStreamServiceHandler(eventStream));
  edge.registerService(new TerminalServiceHandler(terminalService));

  await edge.connect();
  console.log("[dink-adapter] connected to dinkd, services registered");

  // 4. Graceful shutdown
  const shutdown = async () => {
    console.log("[dink-adapter] shutting down...");
    terminalService.shutdown();
    try {
      await edge.disconnect();
    } catch {
      // best effort
    }
    console.log("[dink-adapter] shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

// Only run main when this file is the entry point
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (isMainModule) {
  main().catch((err) => {
    console.error("[dink-adapter] fatal:", err);
    process.exit(1);
  });
}
