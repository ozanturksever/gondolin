import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceServiceEdge,
  type VMFactory,
  type AgentFSFactory,
  type CreateSandboxRequest,
  type SandboxRecord,
} from "../src/workspace-service-edge";
import type { VM, VMOptions } from "../src/vm";
import type { AgentFSLike, AgentFSStatsLike, AgentFSFileHandleLike } from "../src/vfs/agentfs-provider";

// ---------------------------------------------------------------------------
// Mock VM
// ---------------------------------------------------------------------------

class MockVM {
  started = false;
  closed = false;
  lastExecCommand: string | null = null;

  async start(): Promise<void> {
    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  exec(command: string, _options?: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.lastExecCommand = command;
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

// ---------------------------------------------------------------------------
// Mock AgentFS (minimal implementation satisfying AgentFSLike)
// ---------------------------------------------------------------------------

class MockAgentFS implements AgentFSLike {
  async stat(_path: string): Promise<AgentFSStatsLike> {
    return {
      ino: 1, mode: 0o100644, nlink: 1, uid: 0, gid: 0, size: 0,
      atime: 0, mtime: 0, ctime: 0,
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    };
  }
  async lstat(path: string): Promise<AgentFSStatsLike> { return this.stat(path); }
  async readFile(_path: string, _options?: unknown): Promise<Buffer | string> { return Buffer.alloc(0); }
  async writeFile(_path: string, _data: string | Buffer, _options?: unknown): Promise<void> {}
  async readdir(_path: string): Promise<string[]> { return []; }
  async mkdir(_path: string): Promise<void> {}
  async rmdir(_path: string): Promise<void> {}
  async unlink(_path: string): Promise<void> {}
  async rename(_oldPath: string, _newPath: string): Promise<void> {}
  async access(_path: string): Promise<void> {}
  async open(_path: string): Promise<AgentFSFileHandleLike> {
    throw new Error("not implemented");
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createMockVMFactory(): { factory: VMFactory; vms: MockVM[] } {
  const vms: MockVM[] = [];
  const factory: VMFactory = {
    async create(_options: VMOptions): Promise<VM> {
      const vm = new MockVM();
      vms.push(vm);
      return vm as unknown as VM;
    },
  };
  return { factory, vms };
}

function createMockAgentFSFactory(): { factory: AgentFSFactory; instances: MockAgentFS[] } {
  const instances: MockAgentFS[] = [];
  const factory: AgentFSFactory = {
    async create(_workspaceId: string, _config: CreateSandboxRequest["config"]): Promise<AgentFSLike> {
      const fs = new MockAgentFS();
      instances.push(fs);
      return fs;
    },
  };
  return { factory, instances };
}

function createService() {
  const vm = createMockVMFactory();
  const agentfs = createMockAgentFSFactory();
  const service = new WorkspaceServiceEdge({
    vmFactory: vm.factory,
    agentfsFactory: agentfs.factory,
  });
  return { service, vms: vm.vms, agentfsInstances: agentfs.instances };
}

function makeCreateRequest(overrides?: Partial<CreateSandboxRequest>): CreateSandboxRequest {
  return {
    workspaceId: overrides?.workspaceId ?? "ws-1",
    workloadId: overrides?.workloadId ?? "wl-1",
    config: overrides?.config ?? {
      resources: { cpu: 2, memoryMb: 1024, diskMb: 4096 },
      agent: "claude",
      gitRepo: { url: "https://github.com/test/repo", branch: "main", commit: "abc123", subPath: "" },
      environment: {},
      image: "alpine:latest",
      timeoutSeconds: 300,
      networkEnabled: true,
      workingDirectory: "/workspace",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("CreateSandbox returns a sandboxId and RUNNING status", async () => {
  const { service } = createService();
  const resp = await service.CreateSandbox(makeCreateRequest());

  assert.ok(resp.sandboxId, "sandboxId should be non-empty");
  assert.equal(resp.status, 4); // RUNNING = 4
  assert.ok(resp.createdAt instanceof Date);
});

test("CreateSandbox calls VM factory and starts the VM", async () => {
  const { service, vms } = createService();
  await service.CreateSandbox(makeCreateRequest());

  assert.equal(vms.length, 1, "one VM should have been created");
  assert.equal(vms[0].started, true, "VM should have been started");
});

test("CreateSandbox calls AgentFS factory", async () => {
  const { service, agentfsInstances } = createService();
  await service.CreateSandbox(makeCreateRequest());

  assert.equal(agentfsInstances.length, 1, "one AgentFS should have been created");
});

test("CreateSandbox sets status to FAILED when VM start throws", async () => {
  const agentfs = createMockAgentFSFactory();
  const failingVmFactory: VMFactory = {
    async create(): Promise<VM> {
      const vm = new MockVM();
      vm.start = async () => { throw new Error("boot failure"); };
      return vm as unknown as VM;
    },
  };
  const service = new WorkspaceServiceEdge({
    vmFactory: failingVmFactory,
    agentfsFactory: agentfs.factory,
  });

  await assert.rejects(
    () => service.CreateSandbox(makeCreateRequest()),
    (err: Error) => err.message === "boot failure",
  );

  // The sandbox should exist but be in FAILED state
  const list = await service.ListSandboxes({ workspaceId: "ws-1", activeOnly: false });
  assert.equal(list.sandboxes.length, 1);
  assert.equal(list.sandboxes[0].status, 7); // FAILED = 7
});

test("DestroySandbox stops the VM and returns destroyed=true", async () => {
  const { service, vms } = createService();
  const { sandboxId } = await service.CreateSandbox(makeCreateRequest());

  const resp = await service.DestroySandbox({
    sandboxId,
    preserveAgentfs: false,
    extractChanges: false,
    force: false,
  });

  assert.equal(resp.destroyed, true);
  assert.equal(vms[0].closed, true, "VM should have been closed");
});

test("DestroySandbox with non-existent id returns destroyed=false", async () => {
  const { service } = createService();
  const resp = await service.DestroySandbox({
    sandboxId: "does-not-exist",
    preserveAgentfs: false,
    extractChanges: false,
    force: false,
  });

  assert.equal(resp.destroyed, false);
});

test("GetStatus returns RUNNING for an active sandbox", async () => {
  const { service } = createService();
  const { sandboxId } = await service.CreateSandbox(makeCreateRequest());

  const status = await service.GetStatus({ sandboxId });

  assert.equal(status.sandboxId, sandboxId);
  assert.equal(status.workspaceId, "ws-1");
  assert.equal(status.workloadId, "wl-1");
  assert.equal(status.status, 4); // RUNNING
  assert.equal(status.agent, "claude");
  assert.equal(status.error, "");
});

test("GetStatus returns STOPPED with error for non-existent sandbox", async () => {
  const { service } = createService();
  const status = await service.GetStatus({ sandboxId: "missing-id" });

  assert.equal(status.sandboxId, "missing-id");
  assert.equal(status.status, 6); // STOPPED
  assert.equal(status.error, "sandbox not found");
  assert.equal(status.workspaceId, "");
});

test("ListSandboxes filters by workspaceId", async () => {
  const { service } = createService();
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-A" }));
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-B" }));
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-A" }));

  const listA = await service.ListSandboxes({ workspaceId: "ws-A", activeOnly: false });
  assert.equal(listA.sandboxes.length, 2);
  for (const sb of listA.sandboxes) {
    assert.equal(sb.workspaceId, "ws-A");
  }

  const listB = await service.ListSandboxes({ workspaceId: "ws-B", activeOnly: false });
  assert.equal(listB.sandboxes.length, 1);
  assert.equal(listB.sandboxes[0].workspaceId, "ws-B");
});

test("ListSandboxes filters by activeOnly", async () => {
  const { service } = createService();
  const { sandboxId: id1 } = await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-1" }));
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-1" }));

  // Destroy the first sandbox
  await service.DestroySandbox({
    sandboxId: id1,
    preserveAgentfs: true, // keep record so it shows up in non-active list
    extractChanges: false,
    force: false,
  });

  const activeOnly = await service.ListSandboxes({ workspaceId: "ws-1", activeOnly: true });
  assert.equal(activeOnly.sandboxes.length, 1);

  const all = await service.ListSandboxes({ workspaceId: "ws-1", activeOnly: false });
  assert.equal(all.sandboxes.length, 2);
});

test("getSandboxRecord returns the record for a known sandbox", async () => {
  const { service } = createService();
  const { sandboxId } = await service.CreateSandbox(makeCreateRequest());

  const record = service.getSandboxRecord(sandboxId);
  assert.ok(record);
  assert.equal(record!.sandboxId, sandboxId);
  assert.equal(record!.workspaceId, "ws-1");
});

test("getSandboxRecord returns undefined for unknown sandbox", () => {
  const { service } = createService();
  const record = service.getSandboxRecord("nope");
  assert.equal(record, undefined);
});

test("getSandboxByWorkspace returns running sandbox for workspace", async () => {
  const { service } = createService();
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-X" }));

  const record = service.getSandboxByWorkspace("ws-X");
  assert.ok(record);
  assert.equal(record!.workspaceId, "ws-X");
  assert.equal(record!.status, 4); // RUNNING
});

test("getSandboxByWorkspace returns undefined when no running sandbox", async () => {
  const { service } = createService();
  const { sandboxId } = await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-Y" }));

  // Destroy the sandbox
  await service.DestroySandbox({
    sandboxId,
    preserveAgentfs: true,
    extractChanges: false,
    force: false,
  });

  const record = service.getSandboxByWorkspace("ws-Y");
  assert.equal(record, undefined);
});

test("destroyAll cleans up all sandboxes", async () => {
  const { service, vms } = createService();
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-1" }));
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-2" }));
  await service.CreateSandbox(makeCreateRequest({ workspaceId: "ws-3" }));

  assert.equal(vms.length, 3);

  await service.destroyAll();

  // All VMs should be closed
  for (const vm of vms) {
    assert.equal(vm.closed, true);
  }

  // No sandboxes should remain (preserveAgentfs=false in destroyAll)
  const list = await service.ListSandboxes({ workspaceId: "", activeOnly: false });
  assert.equal(list.sandboxes.length, 0);
});

test("CreateSandbox uses config resources for VM options", async () => {
  let capturedOptions: VMOptions | null = null;
  const capturingVmFactory: VMFactory = {
    async create(options: VMOptions): Promise<VM> {
      capturedOptions = options;
      const vm = new MockVM();
      return vm as unknown as VM;
    },
  };
  const agentfs = createMockAgentFSFactory();
  const service = new WorkspaceServiceEdge({
    vmFactory: capturingVmFactory,
    agentfsFactory: agentfs.factory,
  });

  await service.CreateSandbox(makeCreateRequest({
    config: {
      resources: { cpu: 4, memoryMb: 2048, diskMb: 8192 },
      agent: "test-agent",
      gitRepo: { url: "", branch: "", commit: "", subPath: "" },
      environment: {},
      image: "",
      timeoutSeconds: 0,
      networkEnabled: false,
      workingDirectory: "",
    },
  }));

  assert.ok(capturedOptions);
  assert.equal(capturedOptions!.memory, "2048M");
  assert.equal(capturedOptions!.cpus, 4);
});
