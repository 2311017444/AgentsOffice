import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@agent-office/protocol";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import { handleCodexNotify, handleCursorHook } from "../src/integrations/ingest.js";
import { createManagedDispatcher, RunQueue } from "../src/domain/runners.js";
import type { OfficeConfig } from "../src/config.js";

const testConfig: OfficeConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
};

function makeOffice() {
  const store = new OfficeStore(":memory:");
  const bus = new OfficeBus();
  return new OfficeService(store, bus);
}

describe("OfficeService 消息路由", () => {
  let office: OfficeService;

  beforeEach(() => {
    office = makeOffice();
  });

  it("@手工会话 → 入箱等待，read_inbox 后标记已读", () => {
    office.store.registerAgent({ name: "codex-abc123", kind: "codex-cli" });
    const result = office.sendMessage({ fromName: "老板", text: "@codex-abc123 看下日志" });
    expect(result.routed).toEqual([{ name: "codex-abc123", mode: "inbox" }]);

    const inbox = office.readInbox("codex-abc123");
    expect(inbox?.messages).toHaveLength(1);
    expect(inbox?.messages[0].fromName).toBe("老板");

    const again = office.readInbox("codex-abc123");
    expect(again?.messages).toHaveLength(0);
  });

  it("@托管 Agent → 调用托管调度器", () => {
    const dispatched: string[] = [];
    office.setManagedDispatcher((agent) => dispatched.push(agent.name));
    office.store.registerAgent({ name: "codex-研发", kind: "codex-managed" });
    const result = office.sendMessage({ fromName: "老板", text: "@codex-研发 跑一下测试" });
    expect(result.routed).toEqual([{ name: "codex-研发", mode: "managed" }]);
    expect(dispatched).toEqual(["codex-研发"]);
  });

  it("@all 路由到除发送者外的全部非人类成员", () => {
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.store.registerAgent({ name: "a2", kind: "cursor-ide" });
    const result = office.sendMessage({ fromName: "老板", text: "@all 停一下手头工作" });
    expect(result.routed.map((r) => r.name).sort()).toEqual(["a1", "a2"]);
  });

  it("@ 无法匹配时提示 unmatched", () => {
    const result = office.sendMessage({ fromName: "老板", text: "@不存在 你好" });
    expect(result.unmatched).toBe(true);
  });

  it("Agent 互相 @ 也可以路由", () => {
    office.store.registerAgent({ name: "cursor-x1", kind: "cursor-ide" });
    office.store.registerAgent({ name: "codex-y2", kind: "codex-cli" });
    const result = office.sendMessage({ fromName: "cursor-x1", text: "@codex-y2 接口写完了" });
    expect(result.routed).toEqual([{ name: "codex-y2", mode: "inbox" }]);
  });
});

describe("简报", () => {
  it("幂等键去重", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    const brief = { title: "t", result: "r" };
    const first = office.publishBrief({
      agentName: "a1",
      kind: "auto",
      source: "codex-notify",
      brief,
      idempotencyKey: "k1",
    });
    const second = office.publishBrief({
      agentName: "a1",
      kind: "auto",
      source: "codex-notify",
      brief,
      idempotencyKey: "k1",
    });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(office.store.listBriefs()).toHaveLength(1);
  });

  it("未登记工号发简报返回 ok=false", () => {
    const office = makeOffice();
    const result = office.publishBrief({
      agentName: "ghost",
      kind: "manual",
      source: "mcp",
      brief: { title: "t", result: "r" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("任务", () => {
  it("认领冲突检测", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.store.registerAgent({ name: "a2", kind: "codex-cli" });
    const task = office.createTask({ title: "修复登录" });
    const first = office.claimTask("a1", task.id);
    expect(first?.conflict).toBe(false);
    const second = office.claimTask("a2", task.id);
    expect(second?.conflict).toBe(true);
  });
});

describe("Cursor hooks 摄入", () => {
  it("sessionStart 自动登记并注入工号", () => {
    const office = makeOffice();
    const out = handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-12345678",
      workspace_roots: ["D:\\字字动画"],
    });
    expect(out.additional_context).toContain("cursor-");
    const agents = office.store.listAgents().filter((a) => a.kind === "cursor-ide");
    expect(agents).toHaveLength(1);
    expect(agents[0].workspace).toBe("D:\\字字动画");
  });

  it("sessionStart 有未读消息时提示 read_inbox", () => {
    const office = makeOffice();
    // 先登记再发消息
    handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-a",
    });
    const agent = office.store.listAgents().find((a) => a.kind === "cursor-ide")!;
    office.sendMessage({ fromName: "老板", text: `@${agent.name} 开会` });
    const out = handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-a",
    });
    expect(out.additional_context).toContain("未读消息");
  });

  it("afterAgentResponse 落兜底简报且幂等", () => {
    const office = makeOffice();
    const payload = {
      hook_event_name: "afterAgentResponse",
      conversation_id: "conv-b",
      text: "我完成了接口改造，测试全部通过。",
    };
    handleCursorHook(office, payload);
    handleCursorHook(office, payload);
    expect(office.store.listBriefs()).toHaveLength(1);
    expect(office.store.listBriefs()[0].source).toBe("cursor-hook");
  });

  it("sessionEnd 置离线", () => {
    const office = makeOffice();
    handleCursorHook(office, { hook_event_name: "sessionStart", conversation_id: "conv-c" });
    handleCursorHook(office, { hook_event_name: "sessionEnd", conversation_id: "conv-c" });
    const agent = office.store.listAgents().find((a) => a.kind === "cursor-ide")!;
    expect(agent.status).toBe("offline");
  });
});

describe("Codex notify 摄入", () => {
  it("turn-complete 登记 Agent 并落简报，thread+turn 幂等", () => {
    const office = makeOffice();
    const payload = {
      type: "agent-turn-complete",
      "thread-id": "thr_123",
      "turn-id": "turn_1",
      cwd: "D:\\字字动画",
      "last-assistant-message": "补丁已经打好。",
    };
    handleCodexNotify(office, payload);
    handleCodexNotify(office, payload);
    const briefs = office.store.listBriefs();
    expect(briefs).toHaveLength(1);
    expect(briefs[0].source).toBe("codex-notify");
    const agent = office.store.listAgents().find((a) => a.kind === "codex-cli")!;
    expect(agent.meta.threadId).toBe("thr_123");
  });

  it("非 turn-complete 事件忽略", () => {
    const office = makeOffice();
    handleCodexNotify(office, { type: "something-else" });
    expect(office.store.listAgents().filter((a) => a.kind === "codex-cli")).toHaveLength(0);
  });
});

describe("托管调度", () => {
  it("同一 Agent 串行执行，完成后自动发简报并已读", async () => {
    const office = makeOffice();
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => (resolveFirst = r));

    const fakeRunner = vi.fn(async (agent: AgentCard, prompt: string) => {
      // 注意：第二轮的提示词会带上第一轮的简报上下文，须先判断“第二件事”
      const n = prompt.includes("第二件事") ? 2 : 1;
      order.push(`start:${n}`);
      if (n === 1) await firstGate;
      order.push(`end:${n}`);
      return { text: "完成了" };
    });

    const dispatch = createManagedDispatcher(office, testConfig, {
      "codex-managed": fakeRunner,
    });
    office.setManagedDispatcher(dispatch);
    const agent = office.store.registerAgent({ name: "codex-研发", kind: "codex-managed" });

    office.sendMessage({ fromName: "老板", text: "@codex-研发 第一件事" });
    office.sendMessage({ fromName: "老板", text: "@codex-研发 第二件事" });

    await vi.waitFor(() => expect(order).toContain("start:1"));
    expect(order).not.toContain("start:2");
    resolveFirst();
    await vi.waitFor(() => expect(order).toContain("end:2"));
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);

    await vi.waitFor(() => expect(office.store.listBriefs()).toHaveLength(2));
    expect(office.store.pendingCount(agent.id)).toBe(0);
    expect(office.store.getAgentById(agent.id)!.status).toBe("online");
  });

  it("运行失败记录事件且状态恢复", async () => {
    const office = makeOffice();
    const dispatch = createManagedDispatcher(office, testConfig, {
      "codex-managed": async () => {
        throw new Error("boom");
      },
    });
    office.setManagedDispatcher(dispatch);
    const agent = office.store.registerAgent({ name: "codex-x", kind: "codex-managed" });
    office.sendMessage({ fromName: "老板", text: "@codex-x 干活" });

    await vi.waitFor(() => {
      const events = office.store.listEvents();
      expect(events.some((e) => e.type === "run-error" && e.text?.includes("boom"))).toBe(true);
    });
    expect(office.store.getAgentById(agent.id)!.status).toBe("online");
  });
});

describe("RunQueue", () => {
  it("前序任务失败不阻塞后续", async () => {
    const queue = new RunQueue();
    const results: string[] = [];
    await queue
      .enqueue("k", async () => {
        throw new Error("fail");
      })
      .catch(() => results.push("caught"));
    await queue.enqueue("k", async () => {
      results.push("second");
    });
    expect(results).toEqual(["caught", "second"]);
  });
});
