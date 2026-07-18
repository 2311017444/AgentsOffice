import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OfficeConfig } from "../config.js";
import type { OfficeService } from "../domain/office.js";
import { USER_AGENT_NAME } from "../domain/office.js";
import { handleCodexNotify, handleCursorHook } from "../integrations/ingest.js";
import { createMcpServer } from "../mcp/tools.js";
import { cliExists } from "../util.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function createServer(
  office: OfficeService,
  config: OfficeConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // ---------- MCP（无状态 Streamable HTTP） ----------
  app.post("/mcp", async (request, reply) => {
    const server = createMcpServer(office);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const methodNotAllowed = (_req: unknown, reply: any) =>
    reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed（无状态模式）" },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ---------- Hooks / notify 摄入 ----------
  app.post("/ingest/cursor-hook", async (request) => {
    return handleCursorHook(office, (request.body ?? {}) as Record<string, any>);
  });
  app.post("/ingest/codex-notify", async (request) => {
    return handleCodexNotify(office, (request.body ?? {}) as Record<string, any>);
  });

  // ---------- REST API ----------
  app.get("/api/health", async () => ({
    ok: true,
    port: config.port,
    dataDir: config.dataDir,
    codexCli: await cliExists("codex"),
    cursorKey: Boolean(process.env.CURSOR_API_KEY),
  }));

  app.get("/api/state", async () => ({
    agents: office.store.listAgents(),
    messages: office.store.listMessages(80),
    tasks: office.store.listTasks(),
    briefs: office.store.listBriefs(40),
    events: office.store.listEvents(80),
  }));

  app.post("/api/messages", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; from?: string };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text 不能为空" });
    const result = office.sendMessage({
      fromName: body.from?.trim() || USER_AGENT_NAME,
      text: body.text.trim(),
    });
    return result;
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      description?: string;
      assignee?: string;
    };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title 不能为空" });
    return office.createTask({
      title: body.title.trim(),
      description: body.description ?? null,
      createdBy: USER_AGENT_NAME,
      assigneeName: body.assignee ?? null,
    });
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: any; assignee?: string | null };
    const task = office.updateTask({
      taskId: id,
      status: body.status,
      assigneeName: body.assignee,
      byAgentName: USER_AGENT_NAME,
    });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return task;
  });

  app.post("/api/agents/managed", async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: string;
      kind?: "codex" | "cursor";
      workspace?: string;
      sandbox?: "read-only" | "workspace-write";
    };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name 不能为空" });
    if (body.kind !== "codex" && body.kind !== "cursor") {
      return reply.code(400).send({ error: "kind 必须是 codex 或 cursor" });
    }
    if (office.store.getAgentByName(body.name.trim())) {
      return reply.code(409).send({ error: "该工号已存在" });
    }
    const agent = office.store.registerAgent({
      name: body.name.trim(),
      kind: body.kind === "codex" ? "codex-managed" : "cursor-managed",
      workspace: body.workspace?.trim() || null,
      meta: body.kind === "codex" ? { sandbox: body.sandbox ?? "read-only" } : {},
      status: "online",
    });
    office.event({ type: "join", agentId: agent.id, text: "托管工位创建" });
    return agent;
  });

  // ---------- SSE ----------
  app.get("/api/events", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: {}\n\n`);
    const unsubscribe = office.bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---------- 网页静态资源 ----------
  const webDist = join(HERE, "../../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/mcp")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
