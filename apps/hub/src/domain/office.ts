import {
  parseMentions,
  type AgentCard,
  type BriefInput,
  type TaskStatus,
} from "@agent-office/protocol";
import type { OfficeBus } from "./bus.js";
import type { OfficeStore } from "./store.js";
import { truncate } from "../util.js";

export type ManagedDispatcher = (
  agent: AgentCard,
  message: { fromName: string; text: string; taskId?: string | null },
) => void;

export const USER_AGENT_NAME = "老板";

/**
 * 办公室领域服务：统一消息路由、任务与简报入口。
 * MCP 工具、REST API、hooks 摄入全部经由这里，保证行为一致。
 */
export class OfficeService {
  private managedDispatcher: ManagedDispatcher | null = null;

  constructor(
    readonly store: OfficeStore,
    readonly bus: OfficeBus,
  ) {
    // 确保人类用户席位存在
    if (!store.getAgentByName(USER_AGENT_NAME)) {
      store.registerAgent({ name: USER_AGENT_NAME, kind: "user", status: "online" });
    }
  }

  setManagedDispatcher(dispatcher: ManagedDispatcher): void {
    this.managedDispatcher = dispatcher;
  }

  private emit(type: string, payload?: unknown): void {
    this.bus.publish({ type, payload });
  }

  event(input: { type: string; agentId?: string | null; text?: string | null }): void {
    const event = this.store.insertEvent(input);
    this.emit("event", event);
  }

  // ---------- 消息 ----------

  /**
   * 发送消息并路由 @提及。
   * 托管 Agent 立即调度执行；手工会话进入收件箱等待下一轮读取。
   */
  sendMessage(input: {
    fromName: string;
    text: string;
    taskId?: string | null;
  }): {
    messageId: string;
    routed: Array<{ name: string; mode: "managed" | "inbox" }>;
    unmatched: boolean;
  } {
    const sender =
      this.store.getAgentByName(input.fromName) ??
      this.store.registerAgent({ name: input.fromName, kind: "user" });
    const roster = this.store.listAgents();
    const rosterNames = roster.map((a) => a.name);
    const { targets, all } = parseMentions(input.text, rosterNames);

    const targetAgents = new Map<string, AgentCard>();
    for (const name of targets) {
      const agent = this.store.getAgentByName(name);
      if (agent && agent.id !== sender.id) targetAgents.set(agent.id, agent);
    }
    if (all) {
      for (const agent of roster) {
        if (agent.id !== sender.id && agent.kind !== "user") {
          targetAgents.set(agent.id, agent);
        }
      }
    }

    const messageId = this.store.createMessage({
      fromAgentId: sender.id,
      text: input.text,
      mentionAgentIds: [...targetAgents.keys()],
      taskId: input.taskId ?? null,
    });

    const routed: Array<{ name: string; mode: "managed" | "inbox" }> = [];
    for (const agent of targetAgents.values()) {
      const isManaged = agent.kind === "codex-managed" || agent.kind === "cursor-managed";
      if (isManaged && this.managedDispatcher) {
        routed.push({ name: agent.name, mode: "managed" });
        this.managedDispatcher(agent, {
          fromName: sender.name,
          text: input.text,
          taskId: input.taskId ?? null,
        });
      } else {
        routed.push({ name: agent.name, mode: "inbox" });
      }
    }

    this.emit("message", { messageId });
    if (targetAgents.size > 0) {
      this.event({
        type: "route",
        agentId: sender.id,
        text: `@ ${[...targetAgents.values()].map((a) => a.name).join("、")}`,
      });
    }
    const hasMentionSyntax = /@[\p{L}\p{N}_./-]+/u.test(input.text);
    return { messageId, routed, unmatched: targetAgents.size === 0 && hasMentionSyntax };
  }

  readInbox(agentName: string): {
    agent: AgentCard;
    messages: Array<{ messageId: string; fromName: string; text: string; taskId: string | null; createdAt: number }>;
  } | null {
    const agent = this.store.getAgentByName(agentName);
    if (!agent) return null;
    const messages = this.store.pendingMessagesFor(agent.id);
    this.store.markDeliveriesRead(agent.id);
    this.store.setAgentStatus(agent.id, "online");
    if (messages.length > 0) this.emit("inbox-read", { agent: agent.name });
    return { agent, messages };
  }

  // ---------- 简报 ----------

  publishBrief(input: {
    agentName: string;
    kind: "manual" | "auto";
    source: string;
    brief: BriefInput;
    idempotencyKey?: string;
  }): { ok: boolean; duplicated: boolean } {
    const agent = this.store.getAgentByName(input.agentName);
    if (!agent) return { ok: false, duplicated: false };
    const inserted = this.store.insertBrief({
      agentId: agent.id,
      kind: input.kind,
      source: input.source,
      brief: input.brief,
      idempotencyKey: input.idempotencyKey,
    });
    if (inserted) {
      this.emit("brief", inserted);
      this.event({
        type: "brief",
        agentId: agent.id,
        text: `发布简报：${truncate(input.brief.title, 60)}`,
      });
      return { ok: true, duplicated: false };
    }
    return { ok: true, duplicated: true };
  }

  // ---------- 任务 ----------

  createTask(input: {
    title: string;
    description?: string | null;
    createdBy?: string | null;
    assigneeName?: string | null;
  }) {
    const assignee = input.assigneeName
      ? this.store.getAgentByName(input.assigneeName)
      : null;
    const task = this.store.createTask({
      title: input.title,
      description: input.description,
      createdBy: input.createdBy,
      assigneeAgentId: assignee?.id ?? null,
    });
    this.emit("task", task);
    this.event({ type: "task", text: `新任务：${truncate(input.title, 60)}` });
    return task;
  }

  claimTask(agentName: string, taskId: string) {
    const agent = this.store.getAgentByName(agentName);
    const task = this.store.getTask(taskId);
    if (!agent || !task) return null;
    if (task.assigneeAgentId && task.assigneeAgentId !== agent.id && task.status !== "open") {
      return { conflict: true as const, task };
    }
    const updated = this.store.updateTask(taskId, {
      status: "claimed",
      assigneeAgentId: agent.id,
    });
    this.emit("task", updated);
    this.event({ type: "task", agentId: agent.id, text: `认领任务：${task.title}` });
    return { conflict: false as const, task: updated };
  }

  updateTask(input: {
    taskId: string;
    status?: TaskStatus;
    assigneeName?: string | null;
    byAgentName?: string;
    note?: string;
  }) {
    const task = this.store.getTask(input.taskId);
    if (!task) return null;
    let assigneeAgentId: string | null | undefined = undefined;
    if (input.assigneeName !== undefined) {
      assigneeAgentId = input.assigneeName
        ? (this.store.getAgentByName(input.assigneeName)?.id ?? null)
        : null;
    }
    const updated = this.store.updateTask(input.taskId, {
      status: input.status,
      assigneeAgentId,
    });
    this.emit("task", updated);
    const by = input.byAgentName ? this.store.getAgentByName(input.byAgentName) : null;
    this.event({
      type: "task",
      agentId: by?.id ?? null,
      text: `任务「${truncate(task.title, 40)}」→ ${input.status ?? task.status}${input.note ? `：${truncate(input.note, 80)}` : ""}`,
    });
    return updated;
  }

  // ---------- 上下文 ----------

  getContext(limitBriefs = 10) {
    return {
      roster: this.store.listAgents().map((a) => ({
        name: a.name,
        kind: a.kind,
        status: a.status,
        workspace: a.workspace,
      })),
      openTasks: this.store.listTasks().filter((t) => t.status !== "done" && t.status !== "cancelled"),
      briefs: this.store.listBriefs(limitBriefs),
    };
  }
}
