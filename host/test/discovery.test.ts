import assert from "node:assert/strict";
import test from "node:test";

import {
  waitForVmEdge,
  waitForHostEdge,
  discoverWorkspaceEdges,
  buildHostLabels,
  buildVmLabels,
  type EdgeInfo,
  type DiscoverEdgesFn,
  type DiscoverEdgesOptions,
} from "../src/discovery";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeEdge(overrides: Partial<EdgeInfo> & { edgeId: string }): EdgeInfo {
  return {
    edgeId: overrides.edgeId,
    labels: overrides.labels ?? {},
    status: overrides.status ?? "online",
    lastSeen: overrides.lastSeen ?? new Date(),
  };
}

/**
 * Create a mock DiscoverEdgesFn that returns a fixed set of edges.
 * Optionally tracks calls for assertion.
 */
function createMockDiscover(edges: EdgeInfo[]): {
  discover: DiscoverEdgesFn;
  calls: DiscoverEdgesOptions[];
} {
  const calls: DiscoverEdgesOptions[] = [];
  const discover: DiscoverEdgesFn = async (options) => {
    calls.push(options);
    return edges;
  };
  return { discover, calls };
}

/**
 * Create a mock DiscoverEdgesFn that returns different results on
 * successive calls (for polling tests).
 */
function createSequencedDiscover(sequence: EdgeInfo[][]): {
  discover: DiscoverEdgesFn;
  calls: DiscoverEdgesOptions[];
} {
  const calls: DiscoverEdgesOptions[] = [];
  let callIndex = 0;
  const discover: DiscoverEdgesFn = async (options) => {
    calls.push(options);
    const result = sequence[callIndex] ?? sequence[sequence.length - 1];
    callIndex++;
    return result;
  };
  return { discover, calls };
}

// ---------------------------------------------------------------------------
// waitForVmEdge tests
// ---------------------------------------------------------------------------

test("waitForVmEdge resolves immediately when VM edge is present", async () => {
  const vmEdge = makeEdge({
    edgeId: "vm-1",
    labels: { workspaceId: "ws-1", role: "vm" },
    status: "online",
  });
  const { discover } = createMockDiscover([vmEdge]);

  const result = await waitForVmEdge(discover, "ws-1", 5000, 100);

  assert.equal(result.edgeId, "vm-1");
  assert.equal(result.labels.role, "vm");
  assert.equal(result.labels.workspaceId, "ws-1");
});

test("waitForVmEdge polls until VM edge appears", async () => {
  const vmEdge = makeEdge({
    edgeId: "vm-2",
    labels: { workspaceId: "ws-1", role: "vm" },
    status: "online",
  });

  // First two calls return empty, third call returns the edge
  const { discover, calls } = createSequencedDiscover([
    [],
    [],
    [vmEdge],
  ]);

  const result = await waitForVmEdge(discover, "ws-1", 5000, 10);

  assert.equal(result.edgeId, "vm-2");
  assert.ok(calls.length >= 3, `expected at least 3 calls, got ${calls.length}`);
});

test("waitForVmEdge times out when no matching edge appears", async () => {
  const { discover } = createMockDiscover([]);

  await assert.rejects(
    () => waitForVmEdge(discover, "ws-missing", 50, 10),
    (err: Error) => {
      assert.ok(err.message.includes("Timed out"));
      assert.ok(err.message.includes("ws-missing"));
      return true;
    },
  );
});

test("waitForVmEdge ignores offline VM edges", async () => {
  const offlineVm = makeEdge({
    edgeId: "vm-offline",
    labels: { workspaceId: "ws-1", role: "vm" },
    status: "offline",
  });
  const { discover } = createMockDiscover([offlineVm]);

  await assert.rejects(
    () => waitForVmEdge(discover, "ws-1", 50, 10),
    (err: Error) => err.message.includes("Timed out"),
  );
});

// ---------------------------------------------------------------------------
// waitForHostEdge tests
// ---------------------------------------------------------------------------

test("waitForHostEdge resolves immediately when host edge is present", async () => {
  const hostEdge = makeEdge({
    edgeId: "host-1",
    labels: { workspaceId: "ws-1", role: "host" },
    status: "online",
  });
  const { discover } = createMockDiscover([hostEdge]);

  const result = await waitForHostEdge(discover, "ws-1", 5000, 100);

  assert.equal(result.edgeId, "host-1");
  assert.equal(result.labels.role, "host");
});

test("waitForHostEdge times out when no matching edge appears", async () => {
  const { discover } = createMockDiscover([]);

  await assert.rejects(
    () => waitForHostEdge(discover, "ws-nope", 50, 10),
    (err: Error) => {
      assert.ok(err.message.includes("Timed out"));
      assert.ok(err.message.includes("host edge"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// discoverWorkspaceEdges tests
// ---------------------------------------------------------------------------

test("discoverWorkspaceEdges returns both host and vm edges", async () => {
  const hostEdge = makeEdge({
    edgeId: "host-1",
    labels: { workspaceId: "ws-1", role: "host" },
    status: "online",
  });
  const vmEdge = makeEdge({
    edgeId: "vm-1",
    labels: { workspaceId: "ws-1", role: "vm" },
    status: "online",
  });
  const { discover } = createMockDiscover([hostEdge, vmEdge]);

  const result = await discoverWorkspaceEdges(discover, "ws-1");

  assert.ok(result.host);
  assert.equal(result.host!.edgeId, "host-1");
  assert.ok(result.vm);
  assert.equal(result.vm!.edgeId, "vm-1");
});

test("discoverWorkspaceEdges returns nulls when no edges match", async () => {
  const { discover } = createMockDiscover([]);

  const result = await discoverWorkspaceEdges(discover, "ws-empty");

  assert.equal(result.host, null);
  assert.equal(result.vm, null);
});

test("discoverWorkspaceEdges ignores offline edges", async () => {
  const offlineHost = makeEdge({
    edgeId: "host-off",
    labels: { workspaceId: "ws-1", role: "host" },
    status: "offline",
  });
  const onlineVm = makeEdge({
    edgeId: "vm-on",
    labels: { workspaceId: "ws-1", role: "vm" },
    status: "online",
  });
  const { discover } = createMockDiscover([offlineHost, onlineVm]);

  const result = await discoverWorkspaceEdges(discover, "ws-1");

  assert.equal(result.host, null, "offline host should be excluded");
  assert.ok(result.vm);
  assert.equal(result.vm!.edgeId, "vm-on");
});

// ---------------------------------------------------------------------------
// buildHostLabels / buildVmLabels tests
// ---------------------------------------------------------------------------

test("buildHostLabels returns correct label map", () => {
  const labels = buildHostLabels("ws-123", "claude");

  assert.deepEqual(labels, {
    workspaceId: "ws-123",
    role: "host",
    agentType: "claude",
    status: "running",
  });
});

test("buildVmLabels returns correct label map", () => {
  const labels = buildVmLabels("ws-456", "codex");

  assert.deepEqual(labels, {
    workspaceId: "ws-456",
    role: "vm",
    agentType: "codex",
    status: "running",
  });
});

test("buildHostLabels and buildVmLabels differ only in role", () => {
  const host = buildHostLabels("ws-same", "agent-x");
  const vm = buildVmLabels("ws-same", "agent-x");

  assert.equal(host.role, "host");
  assert.equal(vm.role, "vm");
  assert.equal(host.workspaceId, vm.workspaceId);
  assert.equal(host.agentType, vm.agentType);
  assert.equal(host.status, vm.status);
});
