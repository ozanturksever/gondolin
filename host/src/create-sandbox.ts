import crypto from "node:crypto";

import { VM, type VMOptions } from "./vm";
import type { AgentFSLike } from "./vfs/agentfs-provider";
import { AgentToolsEdge } from "./agent-tools-edge";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentType = "claude-code" | "codex" | "opencode" | "amp" | string;

export interface CreateSandboxOptions {
  workspaceId: string;
  agentType?: AgentType;
  gitRepo?: { url: string; branch?: string };
  files?: Record<string, string>;
  resourceLimits?: { memoryMB?: number; cpuCores?: number };
  dinkUrl?: string;
  dinkApiKey?: string;
  vm?: VMOptions;
  agentfs?: AgentFSLike;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly workspaceId: string;
  readonly agentType: string;

  exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<Array<{ path: string; name: string; size: number; type: string }>>;
  diff(): Promise<string>;
  status(): Promise<SandboxStatus>;
  close(): Promise<void>;
}

export type SandboxStatus = "creating" | "running" | "stopping" | "stopped" | "error";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SandboxHandleImpl implements SandboxHandle {
  readonly sandboxId: string;
  readonly workspaceId: string;
  readonly agentType: string;

  private _status: SandboxStatus = "creating";
  private readonly vm: VM;
  private readonly agentfs: AgentFSLike;
  private readonly tools: AgentToolsEdge;

  constructor(
    sandboxId: string,
    workspaceId: string,
    agentType: string,
    vm: VM,
    agentfs: AgentFSLike,
    tools: AgentToolsEdge,
  ) {
    this.sandboxId = sandboxId;
    this.workspaceId = workspaceId;
    this.agentType = agentType;
    this.vm = vm;
    this.agentfs = agentfs;
    this.tools = tools;
  }

  setStatus(status: SandboxStatus) {
    this._status = status;
  }

  async exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<SandboxExecResult> {
    const result = await this.tools.ExecCommand({
      command: cmd,
      cwd: opts?.cwd ?? "",
      env: {},
      timeoutMs: opts?.timeout ?? 60_000,
    });
    return {
      exitCode: result.result.exitCode,
      stdout: result.result.stdout,
      stderr: result.result.stderr,
    };
  }

  async readFile(path: string): Promise<string> {
    const result = await this.tools.ReadFile({
      path,
      encoding: "utf8",
      offset: 0,
      length: 0,
    });
    return result.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.tools.WriteFile({
      path,
      content,
      encoding: "utf8",
      createDirs: true,
      mode: 0o644,
    });
  }

  async listFiles(path?: string): Promise<Array<{ path: string; name: string; size: number; type: string }>> {
    const result = await this.tools.ListFiles({
      path: path ?? "/",
      recursive: false,
      pattern: "",
      includeHidden: false,
    });
    return result.files.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      type: f.type === 2 ? "directory" : f.type === 3 ? "symlink" : "file",
    }));
  }

  async diff(): Promise<string> {
    const result = await this.tools.ExportPatch({ basePath: "", paths: [] });
    return result.patch.content;
  }

  async status(): Promise<SandboxStatus> {
    return this._status;
  }

  async close(): Promise<void> {
    this._status = "stopping";
    try {
      await this.vm.close();
    } finally {
      this._status = "stopped";
    }
  }
}

/**
 * Create an agent sandbox — the high-level SDK entry point.
 *
 * Boots a Gondolin VM, sets up the AgentFS workspace, and returns
 * a `SandboxHandle` for interacting with the sandbox.
 */
export async function createAgentSandbox(options: CreateSandboxOptions): Promise<SandboxHandle> {
  const sandboxId = crypto.randomUUID();
  const workspaceId = options.workspaceId;
  const agentType = options.agentType ?? "claude-code";

  // Build VM options
  const vmOptions: VMOptions = {
    ...options.vm,
    memory: options.resourceLimits?.memoryMB
      ? `${options.resourceLimits.memoryMB}M`
      : options.vm?.memory ?? "1G",
    cpus: options.resourceLimits?.cpuCores ?? options.vm?.cpus ?? 2,
  };

  // Create or use provided AgentFS
  let agentfs: AgentFSLike;
  if (options.agentfs) {
    agentfs = options.agentfs;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MemoryProvider } = require("./vfs") as typeof import("./vfs");
    const mem = new MemoryProvider();
    // Populate initial files if provided
    if (options.files) {
      for (const [filePath, content] of Object.entries(options.files)) {
        // Ensure parent dirs exist in MemoryProvider
        const parts = filePath.split("/").filter(Boolean);
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
          current += "/" + parts[i];
          try { mem.statSync(current); } catch { mem.mkdirSync(current); }
        }
        const fh = mem.openSync(filePath, "w");
        try { fh.writeFileSync(content); } finally { fh.closeSync(); }
      }
    }
    // Wrap MemoryProvider in an AgentFSLike adapter
    agentfs = createMemoryAgentFS(mem);
  }

  // Create VM
  const vm = await VM.create(vmOptions);

  // Build tools
  const tools = new AgentToolsEdge(vm, agentfs);

  const handle = new SandboxHandleImpl(
    sandboxId,
    workspaceId,
    agentType,
    vm,
    agentfs,
    tools,
  );

  // Boot the VM
  try {
    await vm.start();
    handle.setStatus("running");
  } catch (err) {
    handle.setStatus("error");
    throw err;
  }

  return handle;
}

// ---------------------------------------------------------------------------
// MemoryProvider → AgentFSLike adapter (for file-only sandboxes)
// ---------------------------------------------------------------------------

interface MemoryProviderLike {
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number; mode: number };
  readdirSync(path: string): string[];
  readFileSync(path: string, opts?: { encoding?: string }): Buffer | string;
  openSync(path: string, flags: string): {
    readFileSync(opts?: { encoding?: string }): Buffer | string;
    writeFileSync(data: string | Buffer): void;
    closeSync(): void;
  };
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  renameSync(old: string, newPath: string): void;
  rmdirSync?(path: string): void;
}

function createMemoryAgentFS(mem: MemoryProviderLike): AgentFSLike {
  const now = () => Math.floor(Date.now() / 1000);

  return {
    async stat(p: string) {
      const s = mem.statSync(p);
      return {
        ino: 0, mode: s.mode || 0o100644, nlink: 1, uid: 0, gid: 0, size: s.size || 0,
        atime: now(), mtime: now(), ctime: now(),
        isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => false,
      };
    },
    async lstat(p: string) { return this.stat(p); },
    async readFile(p: string, opts?: BufferEncoding | { encoding?: BufferEncoding }) {
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      if (encoding) {
        const fh = mem.openSync(p, "r");
        try { return fh.readFileSync({ encoding }) as string; } finally { fh.closeSync(); }
      }
      const fh = mem.openSync(p, "r");
      try { return fh.readFileSync() as Buffer; } finally { fh.closeSync(); }
    },
    async writeFile(p: string, data: string | Buffer) {
      const fh = mem.openSync(p, "w");
      try { fh.writeFileSync(data); } finally { fh.closeSync(); }
    },
    async readdir(p: string) { return mem.readdirSync(p); },
    async mkdir(p: string) { mem.mkdirSync(p); },
    async rmdir(p: string) { if (mem.rmdirSync) mem.rmdirSync(p); },
    async unlink(p: string) { mem.unlinkSync(p); },
    async rename(old: string, newP: string) { mem.renameSync(old, newP); },
    async access(p: string) { mem.statSync(p); },
    async open(p: string) {
      const content = mem.openSync(p, "r");
      const buf = content.readFileSync() as Buffer;
      content.closeSync();
      return {
        async pread(offset: number, size: number) {
          return Buffer.from(buf.subarray(offset, offset + size));
        },
        async pwrite() { throw new Error("read-only handle"); },
        async truncate() { throw new Error("read-only handle"); },
        async fsync() {},
        async fstat() {
          const s = mem.statSync(p);
          return {
            ino: 0, mode: s.mode || 0o100644, nlink: 1, uid: 0, gid: 0, size: buf.length,
            atime: now(), mtime: now(), ctime: now(),
            isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
          };
        },
      };
    },
  };
}
