/**
 * ConvexFileSync — Phase 4 Track A.
 *
 * Syncs file changes from AgentFS (on host) to Convex (cloud) so the browser
 * can reactively display file state via Convex subscriptions.
 *
 * Uses AgentFSChangeHooks from Phase 2B to detect changes, debounces writes,
 * and batches updates into Convex mutations.
 */

import path from "node:path";

import type { AgentFSLike, AgentFSChangeHooks, AgentFSStatsLike } from "./vfs/agentfs-provider";

// ---------------------------------------------------------------------------
// Injectable Convex sync client interface (for testability)
// ---------------------------------------------------------------------------

export interface FileSyncUpdate {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  content: string | null;
  contentAvailable: boolean;
  mimeType: string | null;
  updatedAt: number;
}

export interface FileSyncDeletion {
  path: string;
  deletedAt: number;
}

export interface FileSyncEvent {
  path: string;
  event: "created" | "modified" | "deleted" | "renamed";
  source: "agent" | "user";
  timestamp: number;
  oldPath?: string;
}

export interface ConvexSyncClient {
  syncFiles(workspaceId: string, updates: FileSyncUpdate[]): Promise<void>;
  deleteFiles(workspaceId: string, deletions: FileSyncDeletion[]): Promise<void>;
  recordEvents(workspaceId: string, events: FileSyncEvent[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sync stats
// ---------------------------------------------------------------------------

export interface SyncStats {
  pendingFiles: number;
  lastSyncTime: number;
  totalSynced: number;
  totalErrors: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConvexFileSyncOptions {
  debounceMs?: number;
  maxInlineSize?: number;
  batchSize?: number;
  onSyncError?: (error: Error, paths: string[]) => void;
  onProgress?: (synced: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
};

function getMimeType(filePath: string): string | null {
  const ext = path.posix.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// ConvexFileSync
// ---------------------------------------------------------------------------

export class ConvexFileSync {
  private readonly agentfs: AgentFSLike;
  private readonly client: ConvexSyncClient;
  private readonly workspaceId: string;
  private readonly debounceMs: number;
  private readonly maxInlineSize: number;
  private readonly batchSize: number;
  private readonly onSyncError?: (error: Error, paths: string[]) => void;
  private readonly onProgress?: (synced: number, total: number) => void;

  private dirtyPaths = new Set<string>();
  private deletedPaths = new Set<string>();
  private pendingEvents: FileSyncEvent[] = [];

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private running = false;

  private _lastSyncTime = 0;
  private _totalSynced = 0;
  private _totalErrors = 0;

  constructor(
    agentfs: AgentFSLike,
    client: ConvexSyncClient,
    workspaceId: string,
    options?: ConvexFileSyncOptions,
  ) {
    this.agentfs = agentfs;
    this.client = client;
    this.workspaceId = workspaceId;
    this.debounceMs = options?.debounceMs ?? 300;
    this.maxInlineSize = options?.maxInlineSize ?? 1_048_576; // 1MB
    this.batchSize = options?.batchSize ?? 100;
    this.onSyncError = options?.onSyncError;
    this.onProgress = options?.onProgress;
  }

  /**
   * Returns AgentFSChangeHooks that feed the dirty set.
   * Pass these to AgentFSProvider or initializeWorkspace.
   */
  getHooks(): AgentFSChangeHooks {
    return {
      onWrite: (filePath: string) => {
        this.markDirty(filePath, "modified");
      },
      onDelete: (filePath: string) => {
        this.markDeleted(filePath);
      },
      onRename: (oldPath: string, newPath: string) => {
        this.markRenamed(oldPath, newPath);
      },
      onMkdir: (dirPath: string) => {
        this.markDirty(dirPath, "created");
      },
    };
  }

  start(): void {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flush();
  }

  async syncNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flush();
  }

  getStats(): SyncStats {
    return {
      pendingFiles: this.dirtyPaths.size + this.deletedPaths.size,
      lastSyncTime: this._lastSyncTime,
      totalSynced: this._totalSynced,
      totalErrors: this._totalErrors,
    };
  }

  /**
   * Initial sync: walk full AgentFS tree and sync to Convex.
   */
  async initialSync(): Promise<void> {
    const allPaths: Array<{ path: string; type: "file" | "directory" }> = [];
    await this.walkTree("/", allPaths);

    const total = allPaths.length;
    let synced = 0;

    for (let i = 0; i < allPaths.length; i += this.batchSize) {
      const batch = allPaths.slice(i, i + this.batchSize);
      const updates: FileSyncUpdate[] = [];
      const events: FileSyncEvent[] = [];

      for (const entry of batch) {
        try {
          const update = await this.buildUpdate(entry.path, entry.type);
          if (update) {
            updates.push(update);
            events.push({
              path: entry.path,
              event: "created",
              source: "agent",
              timestamp: Date.now(),
            });
          }
        } catch {
          // Skip files that can't be read (race condition)
        }
      }

      if (updates.length > 0) {
        await this.client.syncFiles(this.workspaceId, updates);
        this._totalSynced += updates.length;
      }
      if (events.length > 0) {
        await this.client.recordEvents(this.workspaceId, events);
      }

      synced += batch.length;
      this.onProgress?.(synced, total);
    }

    this._lastSyncTime = Date.now();
  }

  // ---- internal -----------------------------------------------------------

  private markDirty(filePath: string, event: "created" | "modified"): void {
    this.dirtyPaths.add(filePath);
    this.deletedPaths.delete(filePath);
    this.pendingEvents.push({
      path: filePath,
      event,
      source: "agent",
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  private markDeleted(filePath: string): void {
    this.dirtyPaths.delete(filePath);
    this.deletedPaths.add(filePath);
    this.pendingEvents.push({
      path: filePath,
      event: "deleted",
      source: "agent",
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  private markRenamed(oldPath: string, newPath: string): void {
    this.dirtyPaths.delete(oldPath);
    this.deletedPaths.add(oldPath);
    this.dirtyPaths.add(newPath);
    this.pendingEvents.push({
      path: newPath,
      event: "renamed",
      source: "agent",
      timestamp: Date.now(),
      oldPath,
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.running) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush().catch((err) => {
        this.onSyncError?.(err instanceof Error ? err : new Error(String(err)), []);
      });
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.syncing) return;
    if (this.dirtyPaths.size === 0 && this.deletedPaths.size === 0 && this.pendingEvents.length === 0) {
      return;
    }

    this.syncing = true;
    try {
      // Snapshot and clear
      const dirty = new Set(this.dirtyPaths);
      const deleted = new Set(this.deletedPaths);
      const events = [...this.pendingEvents];
      this.dirtyPaths.clear();
      this.deletedPaths.clear();
      this.pendingEvents = [];

      // Process dirty files in batches
      const dirtyArr = [...dirty];
      for (let i = 0; i < dirtyArr.length; i += this.batchSize) {
        const batch = dirtyArr.slice(i, i + this.batchSize);
        const updates: FileSyncUpdate[] = [];
        const failedPaths: string[] = [];

        for (const filePath of batch) {
          try {
            const stats = await this.agentfs.stat(filePath);
            const fileType = stats.isDirectory() ? "directory" : "file";
            const update = await this.buildUpdate(filePath, fileType, stats);
            if (update) updates.push(update);
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
              // File was deleted between hook and sync — add to deleted set
              deleted.add(filePath);
            } else {
              failedPaths.push(filePath);
              this._totalErrors++;
              this.onSyncError?.(
                err instanceof Error ? err : new Error(String(err)),
                [filePath],
              );
            }
          }
        }

        if (updates.length > 0) {
          try {
            await this.client.syncFiles(this.workspaceId, updates);
            this._totalSynced += updates.length;
          } catch (err) {
            this._totalErrors += updates.length;
            this.onSyncError?.(
              err instanceof Error ? err : new Error(String(err)),
              updates.map((u) => u.path),
            );
          }
        }
      }

      // Process deletions
      if (deleted.size > 0) {
        const deletions: FileSyncDeletion[] = [...deleted].map((p) => ({
          path: p,
          deletedAt: Date.now(),
        }));
        try {
          await this.client.deleteFiles(this.workspaceId, deletions);
          this._totalSynced += deletions.length;
        } catch (err) {
          this._totalErrors += deletions.length;
          this.onSyncError?.(
            err instanceof Error ? err : new Error(String(err)),
            [...deleted],
          );
        }
      }

      // Record events
      if (events.length > 0) {
        try {
          await this.client.recordEvents(this.workspaceId, events);
        } catch {
          // Event recording failure is non-critical
        }
      }

      this._lastSyncTime = Date.now();
    } finally {
      this.syncing = false;
    }
  }

  private async buildUpdate(
    filePath: string,
    fileType: "file" | "directory",
    existingStats?: AgentFSStatsLike,
  ): Promise<FileSyncUpdate | null> {
    const name = path.posix.basename(filePath) || "/";
    const now = Date.now();

    if (fileType === "directory") {
      return {
        path: filePath,
        name,
        type: "directory",
        size: 0,
        content: null,
        contentAvailable: true,
        mimeType: null,
        updatedAt: now,
      };
    }

    const stats = existingStats ?? await this.agentfs.stat(filePath);
    const size = stats.size;

    if (size > this.maxInlineSize) {
      return {
        path: filePath,
        name,
        type: "file",
        size,
        content: null,
        contentAvailable: false,
        mimeType: getMimeType(filePath),
        updatedAt: now,
      };
    }

    const rawContent = await this.agentfs.readFile(filePath, "utf8");
    const content = typeof rawContent === "string" ? rawContent : rawContent.toString("utf8");

    return {
      path: filePath,
      name,
      type: "file",
      size,
      content,
      contentAvailable: true,
      mimeType: getMimeType(filePath),
      updatedAt: now,
    };
  }

  private async walkTree(
    dirPath: string,
    result: Array<{ path: string; type: "file" | "directory" }>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await this.agentfs.readdir(dirPath);
    } catch {
      return;
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue; // Skip hidden files during initial sync
      const childPath = dirPath === "/" ? `/${name}` : `${dirPath}/${name}`;
      try {
        const stats = await this.agentfs.stat(childPath);
        if (stats.isDirectory()) {
          result.push({ path: childPath, type: "directory" });
          await this.walkTree(childPath, result);
        } else {
          result.push({ path: childPath, type: "file" });
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }
}
