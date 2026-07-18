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

describe("托管孪生去重", () => {
  it("托管 Codex 的 notify 不再登记重复员工", () => {
    const office = makeOffice();
    const managed = office.store.registerAgent({
      name: "codex-画布",
      kind: "codex-managed",
      meta: { threadId: "t-abc" },
    });

    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-abc",
      "last-assistant-message": "干完了",
    });

    const codexAgents = office.store.listAgents().filter((a) => a.kind === "codex-cli");
    expect(codexAgents).toHaveLength(0);
    expect(office.store.getAgentById(managed.id)!.status).toBe("online");
    // 没有产生重复简报（托管调度器自己会发）
    expect(office.store.listBriefs()).toHaveLength(0);
  });

  it("陌生 thread 的 notify 照常登记为手工会话", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "codex-画布",
      kind: "codex-managed",
      meta: { threadId: "t-abc" },
    });
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "t-other",
      "last-assistant-message": "我是真人终端",
    });
    expect(office.store.listAgents().filter((a) => a.kind === "codex-cli")).toHaveLength(1);
  });

  it("托管 Claude 的 hooks 不注入、不登记", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "claude-研发",
      kind: "claude-managed",
      meta: { sessionId: "s-abc" },
    });

    const out = handleClaudeHook(office, {
      hook_event_name: "SessionStart",
      session_id: "s-abc",
      cwd: "D:\\proj",
    });
    expect(out).toEqual({});
    expect(office.store.listAgents().filter((a) => a.kind === "claude-cli")).toHaveLength(0);
  });

  it("托管 Cursor 的 hooks 不登记重复员工", () => {
    const office = makeOffice();
    office.store.registerAgent({
      name: "cursor-研发",
      kind: "cursor-managed",
      meta: { cursorAgentId: "conv-1" },
    });
    const out = handleCursorHook(office, {
      hook_event_name: "sessionStart",
      conversation_id: "conv-1",
    });
    expect(out).toEqual({});
    expect(office.store.listAgents().filter((a) => a.kind === "cursor-ide")).toHaveLength(0);
  });
});

describe("闲置清扫", () => {
  it("超过阈值的手工会话标记离席，托管/在期会话不动", () => {
    const office = makeOffice();
    const stale = office.store.registerAgent({ name: "cursor-旧", kind: "cursor-ide" });
    const fresh = office.store.registerAgent({ name: "codex-新", kind: "codex-cli" });
    const managed = office.store.registerAgent({ name: "codex-托管", kind: "codex-managed" });
    // 手动把 stale 的 last_seen_at 拨回 1 小时前
    office.store.db
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(Date.now() - 3_600_000, stale.id);

    const swept = office.sweepIdleSessions(30 * 60_000);
    expect(swept).toBe(1);
    expect(office.store.getAgentById(stale.id)!.status).toBe("offline");
    expect(office.store.getAgentById(fresh.id)!.status).toBe("online");
    expect(office.store.getAgentById(managed.id)!.status).toBe("online");
    // 离席时间保持原样（未被 sweep 顶掉）
    expect(office.store.getAgentById(stale.id)!.lastSeenAt).toBeLessThan(
      Date.now() - 3_500_000,
    );
    // 再扫一遍不重复计数
    expect(office.sweepIdleSessions(30 * 60_000)).toBe(0);
  });
});
