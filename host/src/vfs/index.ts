export {
  create,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
} from "./node";
export type { VirtualFileHandle } from "./node";

export { SandboxVfsProvider } from "./provider";
export type { VfsHooks, VfsHookContext } from "./provider";
export { ReadonlyProvider } from "./readonly";
export { ReadonlyVirtualProvider } from "./readonly-virtual";
export {
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  normalizeVfsPath,
  VirtualDirent,
  createVirtualDirStats,
  formatVirtualEntries,
} from "./utils";
export { FsRpcClient, RpcFsBackend, RpcFileHandle } from "./rpc";
export { FsRpcService, type FsRpcMetrics, MAX_RPC_DATA } from "./rpc-service";
export {
  AgentFSProvider,
  initializeWorkspace,
} from "./agentfs-provider";
export type {
  AgentFSLike,
  AgentFSStatsLike,
  AgentFSFileHandleLike,
  AgentFSDirEntryLike,
  AgentFSChangeHooks,
  WorkspaceInitOptions,
} from "./agentfs-provider";
export { CowOverlayFS } from "./cow-overlay";
export type { OverlayChange, OverlayEntry } from "./cow-overlay";
