// ---------------------------------------------------------------------------
// Health & Discovery helpers
//
// All health is via Dink discovery — no custom health endpoints.
// These helpers wrap discoverEdges() calls and provide polling utilities.
// Actual Dink SDK calls are deferred until @fatagnus/dink-sdk is available.
// ---------------------------------------------------------------------------

export interface EdgeInfo {
  edgeId: string;
  labels: Record<string, string>;
  status: "online" | "offline";
  lastSeen: Date;
}

export interface DiscoverEdgesOptions {
  labels?: Record<string, string>;
}

export type DiscoverEdgesFn = (options: DiscoverEdgesOptions) => Promise<EdgeInfo[]>;

/**
 * Wait for a VM edge to appear in Dink discovery.
 *
 * Polls `discoverEdges` until an edge with the matching labels is found
 * or the timeout expires.
 */
export async function waitForVmEdge(
  discover: DiscoverEdgesFn,
  workspaceId: string,
  timeoutMs: number = 30_000,
  pollIntervalMs: number = 1_000,
): Promise<EdgeInfo> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const edges = await discover({
      labels: { workspaceId, role: "vm" },
    });

    const vmEdge = edges.find(
      (e) =>
        e.labels.workspaceId === workspaceId &&
        e.labels.role === "vm" &&
        e.status === "online",
    );

    if (vmEdge) return vmEdge;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for VM edge (workspaceId=${workspaceId}) after ${timeoutMs}ms`,
  );
}

/**
 * Wait for a host edge to appear in Dink discovery.
 */
export async function waitForHostEdge(
  discover: DiscoverEdgesFn,
  workspaceId: string,
  timeoutMs: number = 30_000,
  pollIntervalMs: number = 1_000,
): Promise<EdgeInfo> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const edges = await discover({
      labels: { workspaceId, role: "host" },
    });

    const hostEdge = edges.find(
      (e) =>
        e.labels.workspaceId === workspaceId &&
        e.labels.role === "host" &&
        e.status === "online",
    );

    if (hostEdge) return hostEdge;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for host edge (workspaceId=${workspaceId}) after ${timeoutMs}ms`,
  );
}

/**
 * Discover all edges for a workspace (both host and VM).
 */
export async function discoverWorkspaceEdges(
  discover: DiscoverEdgesFn,
  workspaceId: string,
): Promise<{ host: EdgeInfo | null; vm: EdgeInfo | null }> {
  const edges = await discover({
    labels: { workspaceId },
  });

  let host: EdgeInfo | null = null;
  let vm: EdgeInfo | null = null;

  for (const edge of edges) {
    if (edge.labels.role === "host" && edge.status === "online") {
      host = edge;
    }
    if (edge.labels.role === "vm" && edge.status === "online") {
      vm = edge;
    }
  }

  return { host, vm };
}

/**
 * Build edge labels for host registration.
 */
export function buildHostLabels(
  workspaceId: string,
  agentType: string,
): Record<string, string> {
  return {
    workspaceId,
    role: "host",
    agentType,
    status: "running",
  };
}

/**
 * Build edge labels for VM registration.
 */
export function buildVmLabels(
  workspaceId: string,
  agentType: string,
): Record<string, string> {
  return {
    workspaceId,
    role: "vm",
    agentType,
    status: "running",
  };
}
