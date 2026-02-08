import path from "node:path";

import type { VM } from "./vm";
import type {
  AgentFSLike,
  AgentFSStatsLike,
} from "./vfs/agentfs-provider";
import type { CowOverlayFS } from "./vfs/cow-overlay";

// ---------------------------------------------------------------------------
// Proto types (imported from contracts, defined locally to avoid dink-sdk dep)
// ---------------------------------------------------------------------------

export interface ExecCommandRequest {
  command: string;
  cwd: string;
  env: Record<string, unknown>;
  timeoutMs: number;
}

export interface ExecCommandResponse {
  result: { exitCode: number; stdout: string; stderr: string };
}

export interface ReadFileRequest {
  path: string;
  encoding: string;
  offset: number;
  length: number;
}

export interface ReadFileResponse {
  content: string;
  info: FileInfoProto;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  encoding: string;
  createDirs: boolean;
  mode: number;
}

export interface WriteFileResponse {
  info: FileInfoProto;
}

export interface DeleteFileRequest {
  path: string;
  recursive: boolean;
}

export interface DeleteFileResponse {
  deleted: boolean;
}

export interface ListFilesRequest {
  path: string;
  recursive: boolean;
  pattern: string;
  includeHidden: boolean;
}

export interface ListFilesResponse {
  files: FileInfoProto[];
}

export interface SearchCodebaseRequest {
  pattern: string;
  path: string;
  filePattern: string;
  caseSensitive: boolean;
  maxResults: number;
  contextLines: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchCodebaseResponse {
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface RunTestsRequest {
  path: string;
  pattern: string;
  env: Record<string, unknown>;
  timeoutMs: number;
}

export interface RunTestsResponse {
  result: { exitCode: number; stdout: string; stderr: string };
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface InstallPackageRequest {
  packageName: string;
  version: string;
  dev: boolean;
  packageManager: string;
}

export interface InstallPackageResponse {
  result: { exitCode: number; stdout: string; stderr: string };
  installedVersion: string;
}

export interface ExportPatchRequest {
  basePath: string;
  paths: string[];
}

export interface ExportPatchResponse {
  patch: {
    content: string;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    changes: Array<{ path: string; type: string; diff: string }>;
  };
}

interface FileInfoProto {
  path: string;
  name: string;
  size: number;
  type: number;
  mode: number;
  modifiedAt: Date;
  createdAt: Date;
}

// FileType enum values matching proto
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMLINK = 3;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgentToolsEdgeOptions {
  defaultTimeoutMs?: number;
  workspacePath?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function statsToFileInfo(fsPath: string, stats: AgentFSStatsLike): FileInfoProto {
  let fileType = FILE_TYPE_FILE;
  if (stats.isDirectory()) fileType = FILE_TYPE_DIRECTORY;
  else if (stats.isSymbolicLink()) fileType = FILE_TYPE_SYMLINK;

  return {
    path: fsPath,
    name: path.posix.basename(fsPath),
    size: stats.size,
    type: fileType,
    mode: stats.mode,
    modifiedAt: new Date(stats.mtime * 1000),
    createdAt: new Date(stats.ctime * 1000),
  };
}

function envRecordToArray(env: Record<string, unknown>): string[] {
  return Object.entries(env)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${String(v)}`);
}

export class AgentToolsEdge {
  private readonly defaultTimeoutMs: number;
  private readonly workspacePath: string;

  constructor(
    private readonly vm: VM,
    private readonly agentfs: AgentFSLike,
    options?: AgentToolsEdgeOptions,
  ) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 60_000;
    this.workspacePath = options?.workspacePath ?? "/workspace";
  }

  async ExecCommand(req: ExecCommandRequest): Promise<ExecCommandResponse> {
    const timeoutMs = req.timeoutMs || this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const env: Record<string, string> = {};
      if (req.env) {
        for (const [k, v] of Object.entries(req.env)) {
          if (v != null) env[k] = String(v);
        }
      }

      const result = await this.vm.exec(req.command, {
        cwd: req.cwd || this.workspacePath,
        env: Object.keys(env).length > 0 ? env : undefined,
        signal: controller.signal,
      });

      return {
        result: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async ReadFile(req: ReadFileRequest): Promise<ReadFileResponse> {
    const fsPath = req.path;
    const encoding = (req.encoding || "utf8") as BufferEncoding;
    const stats = await this.agentfs.stat(fsPath);
    let content: string;

    if (req.offset || req.length) {
      const buf = await this.agentfs.readFile(fsPath) as Buffer;
      const offset = req.offset || 0;
      const length = req.length || (buf.length - offset);
      content = buf.subarray(offset, offset + length).toString(encoding);
    } else {
      const raw = await this.agentfs.readFile(fsPath, encoding);
      content = typeof raw === "string" ? raw : raw.toString(encoding);
    }

    return {
      content,
      info: statsToFileInfo(fsPath, stats),
    };
  }

  async WriteFile(req: WriteFileRequest): Promise<WriteFileResponse> {
    const fsPath = req.path;

    if (req.createDirs) {
      const dir = path.posix.dirname(fsPath);
      if (dir !== "/" && dir !== ".") {
        await this.mkdirRecursive(dir);
      }
    }

    const encoding = (req.encoding || "utf8") as BufferEncoding;
    await this.agentfs.writeFile(fsPath, req.content, { encoding });

    const stats = await this.agentfs.stat(fsPath);
    return { info: statsToFileInfo(fsPath, stats) };
  }

  async DeleteFile(req: DeleteFileRequest): Promise<DeleteFileResponse> {
    try {
      const stats = await this.agentfs.stat(req.path);
      if (stats.isDirectory()) {
        if (req.recursive && this.agentfs.rm) {
          await this.agentfs.rm(req.path, { recursive: true, force: true });
        } else {
          await this.agentfs.rmdir(req.path);
        }
      } else {
        await this.agentfs.unlink(req.path);
      }
      return { deleted: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { deleted: false };
      throw err;
    }
  }

  async ListFiles(req: ListFilesRequest): Promise<ListFilesResponse> {
    const basePath = req.path || "/";
    const files: FileInfoProto[] = [];

    if (req.recursive) {
      await this.walkDir(basePath, files, req.includeHidden, req.pattern);
    } else {
      const entries = await this.agentfs.readdir(basePath);
      for (const name of entries) {
        if (!req.includeHidden && name.startsWith(".")) continue;
        if (req.pattern && !this.matchGlob(name, req.pattern)) continue;
        const childPath = basePath === "/" ? `/${name}` : `${basePath}/${name}`;
        const stats = await this.agentfs.stat(childPath);
        files.push(statsToFileInfo(childPath, stats));
      }
    }

    return { files };
  }

  async SearchCodebase(req: SearchCodebaseRequest): Promise<SearchCodebaseResponse> {
    const args: string[] = ["rg", "--json"];
    if (!req.caseSensitive) args.push("-i");
    if (req.maxResults) args.push("--max-count", String(req.maxResults));
    if (req.contextLines) {
      args.push("-C", String(req.contextLines));
    }
    if (req.filePattern) args.push("-g", req.filePattern);
    args.push("--", req.pattern);
    args.push(req.path || this.workspacePath);

    const result = await this.vm.exec(args.join(" "), {
      cwd: this.workspacePath,
    });

    const matches: SearchMatch[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "match") {
          const data = entry.data;
          matches.push({
            path: data.path?.text ?? "",
            line: data.line_number ?? 0,
            column: data.submatches?.[0]?.start ?? 0,
            text: data.lines?.text?.trimEnd() ?? "",
            contextBefore: [],
            contextAfter: [],
          });
        }
      } catch {
        // skip malformed JSON lines
      }
    }

    return {
      matches,
      totalMatches: matches.length,
      truncated: req.maxResults > 0 && matches.length >= req.maxResults,
    };
  }

  async RunTests(req: RunTestsRequest): Promise<RunTestsResponse> {
    const timeoutMs = req.timeoutMs || this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const command = req.pattern
        ? `cd ${req.path || this.workspacePath} && npm test -- ${req.pattern}`
        : `cd ${req.path || this.workspacePath} && npm test`;

      const env = req.env ? envRecordToArray(req.env) : undefined;

      const result = await this.vm.exec(command, {
        cwd: req.path || this.workspacePath,
        env,
        signal: controller.signal,
      });

      return {
        result: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        total: 0,
        passed: result.exitCode === 0 ? 1 : 0,
        failed: result.exitCode !== 0 ? 1 : 0,
        skipped: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async InstallPackage(req: InstallPackageRequest): Promise<InstallPackageResponse> {
    const pm = req.packageManager || "npm";
    const pkg = req.version ? `${req.packageName}@${req.version}` : req.packageName;
    const devFlag = req.dev ? (pm === "yarn" ? "--dev" : "--save-dev") : "";
    const command = `${pm} install ${devFlag} ${pkg}`.trim();

    const result = await this.vm.exec(command, {
      cwd: this.workspacePath,
    });

    return {
      result: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      installedVersion: req.version || "",
    };
  }

  async ExportPatch(req: ExportPatchRequest): Promise<ExportPatchResponse> {
    const fs = this.agentfs as AgentFSLike & { diff?: () => Promise<string>; listChanges?: () => Array<{ path: string; type: string }> };

    if (typeof fs.diff === "function") {
      const patchContent = await fs.diff();
      const changes = typeof fs.listChanges === "function" ? fs.listChanges() : [];

      const linesAdded = (patchContent.match(/^\+[^+]/gm) || []).length;
      const linesRemoved = (patchContent.match(/^-[^-]/gm) || []).length;

      return {
        patch: {
          content: patchContent,
          filesChanged: changes.length,
          linesAdded,
          linesRemoved,
          changes: changes.map((c) => ({
            path: c.path,
            type: c.type,
            diff: "",
          })),
        },
      };
    }

    // Fallback: try git diff in the VM
    const basePath = req.basePath || this.workspacePath;
    const result = await this.vm.exec(`cd ${basePath} && git diff`, {
      cwd: basePath,
    });

    const linesAdded = (result.stdout.match(/^\+[^+]/gm) || []).length;
    const linesRemoved = (result.stdout.match(/^-[^-]/gm) || []).length;

    return {
      patch: {
        content: result.stdout,
        filesChanged: 0,
        linesAdded,
        linesRemoved,
        changes: [],
      },
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async mkdirRecursive(dirPath: string): Promise<void> {
    const parts = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      try {
        await this.agentfs.stat(current);
      } catch {
        await this.agentfs.mkdir(current);
      }
    }
  }

  private async walkDir(
    dirPath: string,
    result: FileInfoProto[],
    includeHidden: boolean,
    pattern: string,
  ): Promise<void> {
    const entries = await this.agentfs.readdir(dirPath);
    for (const name of entries) {
      if (!includeHidden && name.startsWith(".")) continue;
      const childPath = dirPath === "/" ? `/${name}` : `${dirPath}/${name}`;
      const stats = await this.agentfs.stat(childPath);
      if (!pattern || this.matchGlob(name, pattern)) {
        result.push(statsToFileInfo(childPath, stats));
      }
      if (stats.isDirectory()) {
        await this.walkDir(childPath, result, includeHidden, pattern);
      }
    }
  }

  private matchGlob(name: string, pattern: string): boolean {
    if (!pattern) return true;
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    return regex.test(name);
  }
}
