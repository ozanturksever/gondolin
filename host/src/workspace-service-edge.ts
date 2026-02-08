import crypto from "node:crypto";

import type { VM, VMOptions } from "./vm";
import type { AgentFSLike } from "./vfs/agentfs-provider";
import { AgentToolsEdge, type AgentToolsEdgeOptions } from "./agent-tools-edge";

// ---------------------------------------------------------------------------
// Proto-compatible types (avoid dink-sdk dependency)
// ---------------------------------------------------------------------------

export interface CreateSandboxRequest {
  workspaceId: string;
  workloadId: string;
  config: {
    resources: { cpu: number; memoryMb: number; diskMb: number };
    agent: string;
    gitRepo: { url: string; branch: string; commit: string; subPath: string };
    environment: Record<string, unknown>;
    image: string;
    timeoutSeconds: number;
    networkEnabled: boolean;
    workingDirectory: string;
  };
}

export interface CreateSandboxResponse {
  sandboxId: string;
  status: number;
  createdAt: Date;
}

export interface DestroySandboxRequest {
  sandboxId: string;
  preserveAgentfs: boolean;
  extractChanges: boolean;
  force: boolean;
}

export interface DestroySandboxResponse {
  destroyed: boolean;
  changes: {
    content: string;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    changes: Array<{ path: string; type: string; diff: string }>;
  };
}

export interface GetStatusRequest {
  sandboxId: string;
}

export interface GetStatusResponse {
  sandboxId: string;
  workspaceId: string;
  workloadId: string;
  status: number;
  agent: string;
  resources: { cpu: number; memoryMb: number; diskMb: number };
  createdAt: Date;
  startedAt: Date;
  error: string;
  metrics: {
    cpuPercent: number;
    memoryUsageMb: number;
    diskUsageMb: number;
    networkBytesSent: number;
    networkBytesReceived: number;
    updatedAt: Date;
  };
}

export interface ListSandboxesRequest {
  workspaceId: string;
  activeOnly: boolean;
}

export interface ListSandboxesResponse {
  sandboxes: Array<{
    sandboxId: string;
    workspaceId: string;
    workloadId: string;
    status: number;
    agent: string;
    createdAt: Date;
    startedAt: Date;
  }>;
}

// SandboxStatus enum matching proto
const SANDBOX_STATUS = {
  PROVISIONING: 1,
  STARTING: 2,
  READY: 3,
  RUNNING: 4,
  STOPPING: 5,
  STOPPED: 6,
  FAILED: 7,
} as const;

// ---------------------------------------------------------------------------
// Internal sandbox record
// ---------------------------------------------------------------------------

export interface SandboxRecord {
  sandboxId: string;
  workspaceId: string;
  workloadId: string;
  agent: string;
  status: number;
  vm: VM | null;
  agentfs: AgentFSLike | null;
  tools: AgentToolsEdge | null;
  createdAt: Date;
  startedAt: Date | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Factory for creating VMs (injectable for testing)
// ---------------------------------------------------------------------------

export interface VMFactory {
  create(options: VMOptions): Promise<VM>;
}

export interface AgentFSFactory {
  create(workspaceId: string, config: CreateSandboxRequest["config"]): Promise<AgentFSLike>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkspaceServiceEdgeOptions {
  vmFactory: VMFactory;
  agentfsFactory: AgentFSFactory;
  toolsOptions?: AgentToolsEdgeOptions;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class WorkspaceServiceEdge {
  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly vmFactory: VMFactory;
  private readonly agentfsFactory: AgentFSFactory;
  private readonly toolsOptions: AgentToolsEdgeOptions;

  constructor(options: WorkspaceServiceEdgeOptions) {
    this.vmFactory = options.vmFactory;
    this.agentfsFactory = options.agentfsFactory;
    this.toolsOptions = options.toolsOptions ?? {};
  }

  async CreateSandbox(req: CreateSandboxRequest): Promise<CreateSandboxResponse> {
    const sandboxId = crypto.randomUUID();
    const now = new Date();

    const record: SandboxRecord = {
      sandboxId,
      workspaceId: req.workspaceId,
      workloadId: req.workloadId,
      agent: req.config?.agent ?? "claude",
      status: SANDBOX_STATUS.PROVISIONING,
      vm: null,
      agentfs: null,
      tools: null,
      createdAt: now,
      startedAt: null,
      error: null,
    };

    this.sandboxes.set(sandboxId, record);

    try {
      const agentfs = await this.agentfsFactory.create(req.workspaceId, req.config);
      record.agentfs = agentfs;
      record.status = SANDBOX_STATUS.STARTING;

      const vmOptions: VMOptions = {
        memory: req.config?.resources?.memoryMb
          ? `${req.config.resources.memoryMb}M`
          : "1G",
        cpus: req.config?.resources?.cpu || 2,
      };

      const vm = await this.vmFactory.create(vmOptions);
      record.vm = vm;
      record.tools = new AgentToolsEdge(vm, agentfs, this.toolsOptions);

      await vm.start();

      record.status = SANDBOX_STATUS.RUNNING;
      record.startedAt = new Date();

      return {
        sandboxId,
        status: SANDBOX_STATUS.RUNNING,
        createdAt: now,
      };
    } catch (err) {
      record.status = SANDBOX_STATUS.FAILED;
      record.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async DestroySandbox(req: DestroySandboxRequest): Promise<DestroySandboxResponse> {
    const record = this.sandboxes.get(req.sandboxId);
    if (!record) {
      return {
        destroyed: false,
        changes: { content: "", filesChanged: 0, linesAdded: 0, linesRemoved: 0, changes: [] },
      };
    }

    record.status = SANDBOX_STATUS.STOPPING;

    let patchContent = "";
    if (req.extractChanges && record.tools) {
      try {
        const patchResult = await record.tools.ExportPatch({ basePath: "", paths: [] });
        patchContent = patchResult.patch.content;
      } catch {
        // best effort
      }
    }

    try {
      if (record.vm) {
        await record.vm.close();
      }
    } catch {
      // force cleanup
    }

    record.status = SANDBOX_STATUS.STOPPED;

    if (!req.preserveAgentfs) {
      this.sandboxes.delete(req.sandboxId);
    }

    return {
      destroyed: true,
      changes: {
        content: patchContent,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changes: [],
      },
    };
  }

  async GetStatus(req: GetStatusRequest): Promise<GetStatusResponse> {
    const record = this.sandboxes.get(req.sandboxId);
    if (!record) {
      return {
        sandboxId: req.sandboxId,
        workspaceId: "",
        workloadId: "",
        status: SANDBOX_STATUS.STOPPED,
        agent: "",
        resources: { cpu: 0, memoryMb: 0, diskMb: 0 },
        createdAt: new Date(0),
        startedAt: new Date(0),
        error: "sandbox not found",
        metrics: {
          cpuPercent: 0,
          memoryUsageMb: 0,
          diskUsageMb: 0,
          networkBytesSent: 0,
          networkBytesReceived: 0,
          updatedAt: new Date(),
        },
      };
    }

    return {
      sandboxId: record.sandboxId,
      workspaceId: record.workspaceId,
      workloadId: record.workloadId,
      status: record.status,
      agent: record.agent,
      resources: { cpu: 2, memoryMb: 1024, diskMb: 4096 },
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? new Date(0),
      error: record.error ?? "",
      metrics: {
        cpuPercent: 0,
        memoryUsageMb: 0,
        diskUsageMb: 0,
        networkBytesSent: 0,
        networkBytesReceived: 0,
        updatedAt: new Date(),
      },
    };
  }

  async ListSandboxes(req: ListSandboxesRequest): Promise<ListSandboxesResponse> {
    const results: ListSandboxesResponse["sandboxes"] = [];

    for (const record of this.sandboxes.values()) {
      if (req.workspaceId && record.workspaceId !== req.workspaceId) continue;
      if (req.activeOnly && record.status >= SANDBOX_STATUS.STOPPING) continue;

      results.push({
        sandboxId: record.sandboxId,
        workspaceId: record.workspaceId,
        workloadId: record.workloadId,
        status: record.status,
        agent: record.agent,
        createdAt: record.createdAt,
        startedAt: record.startedAt ?? new Date(0),
      });
    }

    return { sandboxes: results };
  }

  getSandboxRecord(sandboxId: string): SandboxRecord | undefined {
    return this.sandboxes.get(sandboxId);
  }

  getSandboxByWorkspace(workspaceId: string): SandboxRecord | undefined {
    for (const record of this.sandboxes.values()) {
      if (record.workspaceId === workspaceId && record.status === SANDBOX_STATUS.RUNNING) {
        return record;
      }
    }
    return undefined;
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.sandboxes.keys()];
    await Promise.allSettled(
      ids.map((id) =>
        this.DestroySandbox({ sandboxId: id, preserveAgentfs: false, extractChanges: false, force: true }),
      ),
    );
  }
}
