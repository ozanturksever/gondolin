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
export { FsRpcClient, RpcFsBackend, RpcFileHandle } from "./rpc";
export { FsRpcService, type FsRpcMetrics, MAX_RPC_DATA } from "./rpc-service";
