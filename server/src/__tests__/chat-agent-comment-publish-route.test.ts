// Fork only (MAG-498): the agent path of the explicit comment publish route.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  createDb,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import {
  CHAT_AGENT_PUBLISHERS_ENV,
  chatChannelRoutes,
} from "../routes/chat-channels.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported
  ? describe.sequential
  : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("agent comment publication route (MAG-498)", () => {
  let db!: TestDb;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const previousPublishers = process.env[CHAT_AGENT_PUBLISHERS_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mag498-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    if (previousPublishers === undefined)
      delete process.env[CHAT_AGENT_PUBLISHERS_ENV];
    else process.env[CHAT_AGENT_PUBLISHERS_ENV] = previousPublishers;
  });

  async function seed() {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `MAG-498 ${companyId.slice(0, 8)}`,
      issuePrefix: `M${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [assigneeId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Leonard" : "Other",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, name: "Telegram", type: "chat" })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name: "Telegram",
        transport: "chat_sdk",
        connectionPurpose: "channel",
        authKind: "api_key",
        uid: `telegram-${companyId}`,
      })
      .returning();
    const [endpoint] = await db
      .insert(chatEndpoints)
      .values({
        companyId,
        connectionId: connection!.id,
        provider: "telegram",
        publicId: `pub-${companyId}`,
        assignedAgentId: assigneeId,
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Bound task",
        status: "in_progress",
        assigneeAgentId: assigneeId,
      })
      .returning();
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        companyId,
        endpointId: endpoint!.id,
        issueId: issue!.id,
        externalConversationId: "telegram:1",
        externalThreadId: "telegram:1",
        externalLabel: "Oliver",
        isDirectMessage: true,
        state: "active",
      })
      .returning();
    const [own, others] = await db
      .insert(issueComments)
      .values([
        { companyId, issueId: issue!.id, authorAgentId: assigneeId, body: "1. Ship it? Y/N" },
        { companyId, issueId: issue!.id, authorAgentId: otherAgentId, body: "not mine" },
      ])
      .returning();
    return {
      issueId: issue!.id,
      companyId,
      assigneeId,
      otherAgentId,
      endpointId: endpoint!.id,
      conversationId: conversation!.id,
      ownCommentId: own!.id,
      othersCommentId: others!.id,
    };
  }

  function appFor(
    companyId: string,
    agentId: string,
    publishComment: ReturnType<typeof vi.fn>,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId, companyId, source: "agent_key" } as never;
      next();
    });
    app.use(
      "/api",
      chatChannelRoutes(db, {
        heartbeat: { wakeup: async () => undefined },
        service: { publishComment } as unknown as ChatChannelService,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const path = (f: { endpointId: string; conversationId: string }) =>
    `/api/chat-endpoints/${f.endpointId}/conversations/${f.conversationId}/publications`;

  it("publishes the assignee's own comment when the assignee is allow-listed", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = ` ${f.assigneeId} ,`;
    const publishComment = vi.fn(async () => ({ id: "pub-1", state: "published" }));
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(201);
    expect(publishComment).toHaveBeenCalledWith(
      f.endpointId,
      f.conversationId,
      f.ownCommentId,
    );
  });

  it("stays board-only when the agent is not allow-listed", async () => {
    const f = await seed();
    delete process.env[CHAT_AGENT_PUBLISHERS_ENV];
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses free-text bodies from agents", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ body: "hello", idempotencyKey: "mag498-free-text-key" });
    expect(res.status).toBe(403);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses an allow-listed agent that is not the task's assignee", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = `${f.assigneeId},${f.otherAgentId}`;
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.otherAgentId, publishComment))
      .post(path(f))
      .send({ commentId: f.othersCommentId });
    expect(res.status).toBe(403);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses a comment the agent did not author", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.othersCommentId });
    expect(res.status).toBe(403);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses a closed conversation, where a reply would not reach the task", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, f.conversationId));
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(409);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses a different company's agent", async () => {
    const f = await seed();
    const g = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = g.assigneeId;
    const publishComment = vi.fn();
    const res = await request(appFor(g.companyId, g.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(403);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("returns an existing publication instead of sending the comment twice", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    const [issueRow] = await db
      .select({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(eq(issueComments.id, f.ownCommentId));
    await db.insert(chatPublications).values({
      companyId: f.companyId,
      endpointId: f.endpointId,
      conversationId: f.conversationId,
      issueId: issueRow!.issueId,
      commentId: f.ownCommentId,
      idempotencyKey: `comment:${f.ownCommentId}:${f.endpointId}`,
      payload: { classification: "external", source: "agent_comment", text: "x" },
      state: "published",
    });
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(path(f))
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(200);
    expect(res.body.commentId).toBe(f.ownCommentId);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("publishes by task to the newest live conversation", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, f.conversationId));
    const [fresh] = await db
      .insert(chatConversations)
      .values({
        companyId: f.companyId,
        endpointId: f.endpointId,
        issueId: f.issueId,
        externalConversationId: "telegram:1",
        externalThreadId: "telegram:1",
        externalLabel: "Oliver",
        isDirectMessage: true,
        state: "active",
        sessionGeneration: 2,
      })
      .returning();
    const publishComment = vi.fn(async () => ({ id: "pub-2", state: "published" }));
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(`/api/issues/${f.issueId}/chat-publications`)
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(201);
    expect(publishComment).toHaveBeenCalledTimes(1);
    expect(publishComment).toHaveBeenCalledWith(f.endpointId, fresh!.id, f.ownCommentId);
  });

  it("refuses by task when the task has no live conversation", async () => {
    const f = await seed();
    process.env[CHAT_AGENT_PUBLISHERS_ENV] = f.assigneeId;
    await db
      .update(chatConversations)
      .set({ state: "completed" })
      .where(eq(chatConversations.id, f.conversationId));
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(`/api/issues/${f.issueId}/chat-publications`)
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(409);
    expect(publishComment).not.toHaveBeenCalled();
  });

  it("refuses by task for an agent that is not allow-listed", async () => {
    const f = await seed();
    delete process.env[CHAT_AGENT_PUBLISHERS_ENV];
    const publishComment = vi.fn();
    const res = await request(appFor(f.companyId, f.assigneeId, publishComment))
      .post(`/api/issues/${f.issueId}/chat-publications`)
      .send({ commentId: f.ownCommentId });
    expect(res.status).toBe(403);
    expect(publishComment).not.toHaveBeenCalled();
  });
});
