import assert from "node:assert/strict";
import test from "node:test";

import { AgentServiceImpl } from "../src/agent-service.js";
import type { SandboxAgent } from "../src/sandbox-agent.js";
import { AgentType, PermissionMode, SessionStatus } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock SandboxAgent that records calls and returns canned responses
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: "post" | "get";
  path: string;
  body?: unknown;
}

function createMockAgent(
  handler: (method: string, path: string, body?: unknown) => unknown,
): { agent: SandboxAgent; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const agent: SandboxAgent = {
    async post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "post", path, body });
      return handler("post", path, body) as T;
    },
    async get<T>(path: string): Promise<T> {
      calls.push({ method: "get", path });
      return handler("get", path) as T;
    },
    async sseStream() {
      throw new Error("not used in agent-service tests");
    },
  };
  return { agent, calls };
}

// ---------------------------------------------------------------------------
// A-TEST-4: CreateSession proxies correctly
// ---------------------------------------------------------------------------

test("CreateSession → POST /v1/sessions/:id", async () => {
  const { agent, calls } = createMockAgent(() => ({
    sessionId: "s1",
    status: SessionStatus.SESSION_STATUS_RUNNING,
    createdAt: new Date().toISOString(),
  }));

  const svc = new AgentServiceImpl(agent);
  const resp = await svc.CreateSession({
    sessionId: "s1",
    agent: AgentType.AGENT_TYPE_CLAUDE,
    agentMode: "code",
    permissionMode: PermissionMode.PERMISSION_MODE_AUTO,
    model: "claude-4",
    workingDirectory: "/workspace",
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "post");
  assert.equal(calls[0].path, "/v1/sessions/s1");
  assert.equal((calls[0].body as Record<string, unknown>).agent, AgentType.AGENT_TYPE_CLAUDE);
  assert.equal((calls[0].body as Record<string, unknown>).model, "claude-4");
  assert.equal(resp.sessionId, "s1");
});

// ---------------------------------------------------------------------------
// A-TEST-5: SendMessage proxies correctly
// ---------------------------------------------------------------------------

test("SendMessage → POST /v1/sessions/:id/messages", async () => {
  const { agent, calls } = createMockAgent(() => ({ accepted: true }));
  const svc = new AgentServiceImpl(agent);

  const resp = await svc.SendMessage({
    sessionId: "s1",
    content: "hello world",
    workingDirectory: "/workspace",
    model: "claude-4",
    options: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/sessions/s1/messages");
  assert.equal((calls[0].body as Record<string, unknown>).content, "hello world");
  assert.equal(resp.accepted, true);
});

// ---------------------------------------------------------------------------
// TerminateSession
// ---------------------------------------------------------------------------

test("TerminateSession → POST /v1/sessions/:id/terminate", async () => {
  const { agent, calls } = createMockAgent(() => ({ terminated: true }));
  const svc = new AgentServiceImpl(agent);

  const resp = await svc.TerminateSession({ sessionId: "s1" });

  assert.equal(calls[0].method, "post");
  assert.equal(calls[0].path, "/v1/sessions/s1/terminate");
  assert.equal(resp.terminated, true);
});

// ---------------------------------------------------------------------------
// A-TEST-6: ListSessions
// ---------------------------------------------------------------------------

test("ListSessions → GET /v1/sessions", async () => {
  const { agent, calls } = createMockAgent(() => ({
    sessions: [{ sessionId: "s1", status: SessionStatus.SESSION_STATUS_RUNNING }],
  }));
  const svc = new AgentServiceImpl(agent);

  const resp = await svc.ListSessions({});

  assert.equal(calls[0].method, "get");
  assert.equal(calls[0].path, "/v1/sessions");
  assert.equal(resp.sessions.length, 1);
  assert.equal(resp.sessions[0].sessionId, "s1");
});

// ---------------------------------------------------------------------------
// GetEvents
// ---------------------------------------------------------------------------

test("GetEvents → GET /v1/sessions/:id/events?offset=&limit=", async () => {
  const { agent, calls } = createMockAgent(() => ({ events: [], total: 0 }));
  const svc = new AgentServiceImpl(agent);

  await svc.GetEvents({ sessionId: "s1", offset: 5, limit: 10 });

  assert.equal(calls[0].method, "get");
  assert.ok(calls[0].path.includes("/v1/sessions/s1/events?"));
  assert.ok(calls[0].path.includes("offset=5"));
  assert.ok(calls[0].path.includes("limit=10"));
});

// ---------------------------------------------------------------------------
// ReplyQuestion
// ---------------------------------------------------------------------------

test("ReplyQuestion → POST /v1/sessions/:id/questions/:qid/reply", async () => {
  const { agent, calls } = createMockAgent(() => ({ accepted: true }));
  const svc = new AgentServiceImpl(agent);

  await svc.ReplyQuestion({
    sessionId: "s1",
    questionId: "q42",
    answers: ["yes"],
  });

  assert.equal(calls[0].path, "/v1/sessions/s1/questions/q42/reply");
  assert.deepEqual((calls[0].body as Record<string, unknown>).answers, ["yes"]);
});

// ---------------------------------------------------------------------------
// ReplyPermission
// ---------------------------------------------------------------------------

test("ReplyPermission → POST /v1/sessions/:id/permissions/:pid/reply", async () => {
  const { agent, calls } = createMockAgent(() => ({ accepted: true }));
  const svc = new AgentServiceImpl(agent);

  await svc.ReplyPermission({
    sessionId: "s1",
    permissionId: "p7",
    reply: "allow",
  });

  assert.equal(calls[0].path, "/v1/sessions/s1/permissions/p7/reply");
  assert.equal((calls[0].body as Record<string, unknown>).reply, "allow");
});

// ---------------------------------------------------------------------------
// A-TEST-12: Error propagation
// ---------------------------------------------------------------------------

test("error from sandbox-agent propagates", async () => {
  const { agent } = createMockAgent(() => {
    throw Object.assign(new Error("sandbox-agent POST /v1/sessions/s1: 503 "), {
      status: 503,
    });
  });
  const svc = new AgentServiceImpl(agent);

  await assert.rejects(
    () => svc.CreateSession({
      sessionId: "s1",
      agent: AgentType.AGENT_TYPE_CLAUDE,
      agentMode: "code",
      permissionMode: PermissionMode.PERMISSION_MODE_AUTO,
      model: "claude-4",
      workingDirectory: "/workspace",
      env: {},
    }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 503);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// URL-encodes special characters in session IDs
// ---------------------------------------------------------------------------

test("special characters in IDs are URL-encoded", async () => {
  const { agent, calls } = createMockAgent(() => ({ terminated: true }));
  const svc = new AgentServiceImpl(agent);

  await svc.TerminateSession({ sessionId: "session/with spaces" });

  assert.equal(calls[0].path, "/v1/sessions/session%2Fwith%20spaces/terminate");
});
