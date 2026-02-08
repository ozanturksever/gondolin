import type { SandboxAgent } from "./sandbox-agent.js";
import type {
  AgentServiceServer,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  SendMessageResponse,
  TerminateSessionRequest,
  TerminateSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  GetEventsRequest,
  GetEventsResponse,
  ReplyQuestionRequest,
  ReplyQuestionResponse,
  ReplyPermissionRequest,
  ReplyPermissionResponse,
} from "./types.js";

export class AgentServiceImpl implements AgentServiceServer {
  constructor(private readonly agent: SandboxAgent) {}

  async CreateSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.agent.post(`/v1/sessions/${encodeURIComponent(req.sessionId)}`, {
      agent: req.agent,
      agentMode: req.agentMode,
      permissionMode: req.permissionMode,
      model: req.model,
      workingDirectory: req.workingDirectory,
      env: req.env,
    });
  }

  async SendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    return this.agent.post(
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/messages`,
      {
        content: req.content,
        workingDirectory: req.workingDirectory,
        model: req.model,
        options: req.options,
      },
    );
  }

  async TerminateSession(req: TerminateSessionRequest): Promise<TerminateSessionResponse> {
    return this.agent.post(
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/terminate`,
    );
  }

  async ListSessions(_req: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.agent.get("/v1/sessions");
  }

  async GetEvents(req: GetEventsRequest): Promise<GetEventsResponse> {
    const params = new URLSearchParams({
      offset: String(req.offset),
      limit: String(req.limit),
    });
    return this.agent.get(
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/events?${params}`,
    );
  }

  async ReplyQuestion(req: ReplyQuestionRequest): Promise<ReplyQuestionResponse> {
    return this.agent.post(
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/questions/${encodeURIComponent(req.questionId)}/reply`,
      { answers: req.answers },
    );
  }

  async ReplyPermission(req: ReplyPermissionRequest): Promise<ReplyPermissionResponse> {
    return this.agent.post(
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/permissions/${encodeURIComponent(req.permissionId)}/reply`,
      { reply: req.reply },
    );
  }
}
