import type { OfficeService } from "../domain/office.js";
import { sha1, shortId, truncate } from "../util.js";

/**
 * Cursor hooks 摄入。
 * 手工 IDE 会话由 sessionStart 自动登记为 cursor-xxxxxx，
 * afterAgentResponse 落为兜底简报，stop/sessionEnd 维护状态。
 * 返回值会原样作为 hook 脚本的 stdout（Cursor 的 hook 响应）。
 */
export function handleCursorHook(
  office: OfficeService,
  payload: Record<string, any>,
): Record<string, unknown> {
  const eventName = payload.hook_event_name as string | undefined;
  const conversationId = payload.conversation_id as string | undefined;
  if (!eventName) return {};
  if (!conversationId) return {};

  const workspace: string | null = Array.isArray(payload.workspace_roots)
    ? (payload.workspace_roots[0] ?? null)
    : null;
  const externalKey = `cursor:conv:${conversationId}`;
  const name = `cursor-${shortId(conversationId)}`;

  const agent = office.store.upsertAgentBySession(externalKey, {
    name,
    kind: "cursor-ide",
    workspace,
  });

  switch (eventName) {
    case "sessionStart": {
      office.event({ type: "join", agentId: agent.id, text: "Cursor 会话上线" });
      const pending = office.store.pendingCount(agent.id);
      const lines = [
        `[Agent Office] 本机运行着多 Agent 协作办公室（MCP 服务名 agent-office）。`,
        `你的工号是「${agent.name}」。协作约定：`,
        `1. 开始处理任务前调用 read_inbox(agent="${agent.name}") 查看 @你的消息；`,
        `2. 完成阶段性工作后调用 publish_brief 发布简报；`,
        `3. 需要其他成员协助时用 send_message 并 @对方工号（get_context 可查花名册）。`,
      ];
      if (pending > 0) lines.push(`注意：你有 ${pending} 条未读消息，请先 read_inbox。`);
      return { additional_context: lines.join("\n") };
    }
    case "beforeSubmitPrompt": {
      office.store.setAgentStatus(agent.id, "busy");
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      office.event({
        type: "prompt",
        agentId: agent.id,
        text: `收到新指令：${truncate(prompt.replaceAll(/\s+/g, " "), 120)}`,
      });
      return {};
    }
    case "afterAgentResponse": {
      const textContent = typeof payload.text === "string" ? payload.text : "";
      if (textContent.trim()) {
        office.publishBrief({
          agentName: agent.name,
          kind: "auto",
          source: "cursor-hook",
          brief: {
            title: `工作回帧：${truncate(textContent.replaceAll(/\s+/g, " "), 48)}`,
            result: textContent,
          },
          idempotencyKey: `cursor:${conversationId}:${sha1(textContent)}`,
        });
      }
      office.store.setAgentStatus(agent.id, "online");
      return {};
    }
    case "stop": {
      office.store.setAgentStatus(agent.id, "online");
      const status = payload.status as string | undefined;
      office.event({
        type: "stop",
        agentId: agent.id,
        text: `一轮工作结束（${status ?? "completed"}）`,
      });
      return {};
    }
    case "sessionEnd": {
      office.store.setAgentStatus(agent.id, "offline");
      office.event({ type: "leave", agentId: agent.id, text: "Cursor 会话下线" });
      return {};
    }
    default:
      return {};
  }
}

/**
 * Codex notify 摄入（agent-turn-complete）。
 * 手工 Codex 会话按 thread-id 登记为 codex-xxxxxx，最终回答落为兜底简报。
 * threadId 记入 meta，便于将来 @ 它时用 codex exec resume 续聊。
 */
export function handleCodexNotify(
  office: OfficeService,
  payload: Record<string, any>,
): { ok: boolean } {
  if (payload?.type !== "agent-turn-complete") return { ok: true };
  const threadId = (payload["thread-id"] ?? payload.thread_id) as string | undefined;
  if (!threadId) return { ok: true };
  const turnId = (payload["turn-id"] ?? payload.turn_id ?? "") as string;
  const cwd = (payload.cwd ?? null) as string | null;
  const lastMessage = (payload["last-assistant-message"] ??
    payload.last_assistant_message ??
    "") as string;

  const agent = office.store.upsertAgentBySession(`codex:thread:${threadId}`, {
    name: `codex-${shortId(threadId)}`,
    kind: "codex-cli",
    workspace: cwd,
    meta: { threadId },
  });
  office.store.setAgentStatus(agent.id, "online");

  if (lastMessage.trim()) {
    office.publishBrief({
      agentName: agent.name,
      kind: "auto",
      source: "codex-notify",
      brief: {
        title: `工作回帧：${truncate(lastMessage.replaceAll(/\s+/g, " "), 48)}`,
        result: lastMessage,
      },
      idempotencyKey: `codex:${threadId}:${turnId || sha1(lastMessage)}`,
    });
  }
  office.event({ type: "turn", agentId: agent.id, text: "Codex 完成一轮工作" });
  return { ok: true };
}
