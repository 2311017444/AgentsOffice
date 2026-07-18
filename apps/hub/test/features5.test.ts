import { describe, expect, it } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import {
  handleClaudeHook,
  handleCodexNotify,
  handleCursorHook,
} from "../src/integrations/ingest.js";

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("对话历史", () => {
  it("Cursor 会话的提问与回复经 hooks 同步进对话历史", () => {
    const office = makeOffice();
    handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-1",
      workspace_roots: ["D:\\proj"],
    });
    handleCursorHook(office, {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conv-1",
      prompt: "帮我修复登录页的空指针",
    });
    handleCursorHook(office, {
      hook_event_name: "afterAgentResponse",
      conversation_id: "conv-1",
      text: "已修复，补充了空值兜底并通过测试。",
    });

    const agent = office.store.listAgents().find((a) => a.kind === "cursor-ide")!;
    const lines = office.store.listHistory(agent.id);
    expect(lines.map((l) => l.kind)).toEqual(["prompt", "final"]);
    expect(lines[0].text).toContain("空指针");
    expect(lines[1].text).toContain("已修复");
  });

  it("Claude 提问与最终回复、Codex 最终回复也会落历史", () => {
    const office = makeOffice();
    handleClaudeHook(office, {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-1",
      prompt: "总结一下超分 API 的现状",
    });
    const claude = office.store.listAgents().find((a) => a.kind === "claude-cli")!;
    expect(office.store.listHistory(claude.id)[0]).toMatchObject({
      kind: "prompt",
    });

    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-9",
      "turn-id": "turn-1",
      "last-assistant-message": "已完成超分 API 巡检。",
    });
    const codex = office.store.listAgents().find((a) => a.kind === "codex-cli")!;
    const lines = office.store.listHistory(codex.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("final");
    expect(lines[0].text).toContain("巡检");
  });

  it("托管终端行自动落库为历史，SSE 广播 history 事件", () => {
    const bus = new OfficeBus();
    const historyEvents: unknown[] = [];
    bus.subscribe((e) => {
      if ((e as { type: string }).type === "history") historyEvents.push(e);
    });
    const office = new OfficeService(new OfficeStore(":memory:"), bus);
    const agent = office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });

    office.terminals.push(agent.id, "→ 老板：跑下测试", "cmd");
    office.terminals.push(agent.id, "$ npm test\n42 passed", "out");

    const lines = office.store.listHistory(agent.id);
    expect(lines.map((l) => l.kind)).toEqual(["cmd", "out", "out"]);
    expect(historyEvents.length).toBe(3);
  });

  it("since 增量拉取与 2000 条滚动上限", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "a1", kind: "codex-cli" });
    office.store.appendHistory(agent.id, "prompt", "第一条");
    const mid = office.store.listHistory(agent.id)[0].at;
    office.store.appendHistory(agent.id, "final", "第二条");
    const incremental = office.store.listHistory(agent.id, { since: mid });
    expect(incremental.every((l) => l.at > mid)).toBe(true);

    // 空文本不落库
    office.recordHistory(agent.id, "prompt", "   ");
    expect(office.store.listHistory(agent.id).some((l) => !l.text.trim())).toBe(false);
  });

  it("删除员工时对话历史一并清除", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-x", kind: "codex-managed" });
    office.store.appendHistory(agent.id, "cmd", "干活");
    expect(office.store.listHistory(agent.id)).toHaveLength(1);
    office.deleteAgent(agent.id);
    expect(office.store.listHistory(agent.id)).toHaveLength(0);
  });
});
