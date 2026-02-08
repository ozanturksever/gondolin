export enum AgentType {
  AGENT_TYPE_UNSPECIFIED = 0,
  AGENT_TYPE_CLAUDE = 1,
  AGENT_TYPE_CODEX = 2,
  AGENT_TYPE_OPENCODE = 3,
  AGENT_TYPE_AMP = 4,
  AGENT_TYPE_CODEBUFF = 5,
  AGENT_TYPE_MOCK = 6,
  AGENT_TYPE_CUSTOM = 7,
}

export enum PermissionMode {
  PERMISSION_MODE_UNSPECIFIED = 0,
  PERMISSION_MODE_AUTO = 1,
  PERMISSION_MODE_ASK = 2,
  PERMISSION_MODE_PLAN = 3,
}

export enum SessionStatus {
  SESSION_STATUS_UNSPECIFIED = 0,
  SESSION_STATUS_STARTING = 1,
  SESSION_STATUS_RUNNING = 2,
  SESSION_STATUS_COMPLETED = 3,
  SESSION_STATUS_FAILED = 4,
}

export enum EventType {
  EVENT_TYPE_UNSPECIFIED = 0,
  EVENT_TYPE_SESSION_STARTED = 1,
  EVENT_TYPE_SESSION_ENDED = 2,
  EVENT_TYPE_ITEM = 3,
  EVENT_TYPE_ITEM_DELTA = 4,
  EVENT_TYPE_QUESTION = 5,
  EVENT_TYPE_PERMISSION = 6,
  EVENT_TYPE_ERROR = 7,
}

export interface UniversalEvent {
  id: number;
  timestamp: Date;
  sessionId: string;
  agent: string;
  type: EventType;
  data: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  agent: AgentType;
  status: SessionStatus;
  createdAt: Date;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// AgentService request/response types
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  sessionId: string;
  agent: AgentType;
  agentMode: string;
  permissionMode: PermissionMode;
  model: string;
  workingDirectory: string;
  env: Record<string, unknown>;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
  createdAt: Date;
}

export interface SendMessageRequest {
  sessionId: string;
  content: string;
  workingDirectory: string;
  model: string;
  options: Record<string, unknown>;
}

export interface SendMessageResponse {
  accepted: boolean;
}

export interface TerminateSessionRequest {
  sessionId: string;
}

export interface TerminateSessionResponse {
  terminated: boolean;
}

export interface ListSessionsRequest {}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
}

export interface GetEventsRequest {
  sessionId: string;
  offset: number;
  limit: number;
}

export interface GetEventsResponse {
  events: UniversalEvent[];
  total: number;
}

export interface ReplyQuestionRequest {
  sessionId: string;
  questionId: string;
  answers: string[];
}

export interface ReplyQuestionResponse {
  accepted: boolean;
}

export interface ReplyPermissionRequest {
  sessionId: string;
  permissionId: string;
  reply: string;
}

export interface ReplyPermissionResponse {
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// AgentEventStreamService request/response types
// ---------------------------------------------------------------------------

export interface StreamEventsRequest {
  sessionId: string;
  fromId: number;
}

export interface StreamEventsResponse {
  event: UniversalEvent;
}

// ---------------------------------------------------------------------------
// TerminalService request/response types
// ---------------------------------------------------------------------------

export interface OpenRequest {
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
  env: Record<string, unknown>;
}

export interface OpenResponse {
  streamId: string;
}

export interface InputRequest {
  streamId: string;
  data: Uint8Array;
}

export interface InputResponse {}

export interface ResizeRequest {
  streamId: string;
  cols: number;
  rows: number;
}

export interface ResizeResponse {}

export interface StreamOutputRequest {
  streamId: string;
}

export interface StreamOutputResponse {
  streamId: string;
  data: Uint8Array;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Handler server interfaces (matching generated handlers)
// ---------------------------------------------------------------------------

export interface AgentServiceServer {
  CreateSession(req: CreateSessionRequest): Promise<CreateSessionResponse>;
  SendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  TerminateSession(req: TerminateSessionRequest): Promise<TerminateSessionResponse>;
  ListSessions(req: ListSessionsRequest): Promise<ListSessionsResponse>;
  GetEvents(req: GetEventsRequest): Promise<GetEventsResponse>;
  ReplyQuestion(req: ReplyQuestionRequest): Promise<ReplyQuestionResponse>;
  ReplyPermission(req: ReplyPermissionRequest): Promise<ReplyPermissionResponse>;
}

export interface StreamSender<T> {
  send(msg: T): Promise<void>;
}

export interface AgentEventStreamServiceServer {
  StreamEvents(req: StreamEventsRequest, stream: StreamSender<StreamEventsResponse>): Promise<void>;
}

export interface TerminalServiceServer {
  Open(req: OpenRequest): Promise<OpenResponse>;
  Input(req: InputRequest): Promise<InputResponse>;
  Resize(req: ResizeRequest): Promise<ResizeResponse>;
  StreamOutput(req: StreamOutputRequest, stream: StreamSender<StreamOutputResponse>): Promise<void>;
}

// ---------------------------------------------------------------------------
// PTY abstraction (matching node-pty IPty interface)
// ---------------------------------------------------------------------------

export interface IDisposable {
  dispose(): void;
}

export interface IPty {
  pid: number;
  onData: (callback: (data: string) => void) => IDisposable;
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawnFn = (
  file: string,
  args: string[],
  options: { cols: number; rows: number; cwd: string; env: Record<string, string> },
) => IPty;
