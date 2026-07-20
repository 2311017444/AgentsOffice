import { describe, expect, it } from "vitest";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { OfficeStore } from "../src/domain/store.js";
import { handleClaudeHook, handleCodexNotify } from "../src/integrations/ingest.js";

function makeOffice() {
  return new OfficeService(new OfficeStore(":memory:"), new OfficeBus());
}

describe("终端工位：开终端即入驻，会话回帧自动收养", () => {
  it("codex：占位登记 online，notify 绑定线程且不产生重复员工", () => {
    const office = makeOffice();
    const placeholder = office.registerTerminalAgent({
      cli: "codex",
      cwd: "D:\\proj",
      title: "codex-画布",
    });
    expect(placeholder.name).toBe("codex-画布");
    expect(placeholder.status).toBe("online");
    expect((placeholder.meta as { awaitingSession?: string }).awaitingSession).toBe("codex");

    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "th-123",
      cwd: "D:/proj",
      "last-assistant-message": "第一轮完成",
    });

    const agents = office.store.listAgents().filter((a) => a.kind === "codex-cli");
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(placeholder.id);
    expect((agents[0].meta as { threadId?: string }).threadId).toBe("th-123");
    expect((agents[0].meta as { awaitingSession?: string }).awaitingSession).toBeUndefined();

    // 第二轮 notify 仍是同一位员工
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "th-123",
      cwd: "D:/proj",
      "last-assistant-message": "第二轮完成",
    });
    expect(office.store.listAgents().filter((a) => a.kind === "codex-cli")).toHaveLength(1);
  });

  it("codex：多个占位工位按目录优先匹配", () => {
    const office = makeOffice();
    const a = office.registerTerminalAgent({ cli: "codex", cwd: "D:\\alpha" });
    const b = office.registerTerminalAgent({ cli: "codex", cwd: "D:\\beta" });
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "th-beta",
      cwd: "d:/beta/",
      "last-assistant-message": "ok",
    });
    expect(
      (office.store.getAgentById(b.id)!.meta as { threadId?: string }).threadId,
    ).toBe("th-beta");
    expect(
      (office.store.getAgentById(a.id)!.meta as { awaitingSession?: string }).awaitingSession,
    ).toBe("codex");
  });

  it("没有占位工位时保持原行为：notify 新建 codex-xxxx", () => {
    const office = makeOffice();
    handleCodexNotify(office, {
      type: "agent-turn-complete",
      "thread-id": "th-solo",
      cwd: "D:/x",
      "last-assistant-message": "ok",
    });
    const agents = office.store.listAgents().filter((a) => a.kind === "codex-cli");
    expect(agents).toHaveLength(1);
    expect(agents[0].name.startsWith("codex-")).toBe(true);
  });

  it("claude：SessionStart 即收养占位工位", () => {
    const office = makeOffice();
    const placeholder = office.registerTerminalAgent({
      cli: "claude",
      cwd: "D:\\proj",
      title: "claude-架构",
    });
    handleClaudeHook(office, {
      hook_event_name: "SessionStart",
      session_id: "sess-9",
      cwd: "D:/proj",
    });
    const agents = office.store.listAgents().filter((a) => a.kind === "claude-cli");
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(placeholder.id);
    expect((agents[0].meta as { sessionId?: string }).sessionId).toBe("sess-9");
  });

  it("同名异类避让：占位名不吞掉既有托管员工", () => {
    const office = makeOffice();
    office.store.registerAgent({ name: "codex-主力", kind: "codex-managed" });
    const placeholder = office.registerTerminalAgent({
      cli: "codex",
      cwd: "D:\\p",
      title: "codex-主力",
    });
    expect(placeholder.kind).toBe("codex-cli");
    expect(placeholder.name).not.toBe("codex-主力");
    expect(office.store.getAgentByName("codex-主力")!.kind).toBe("codex-managed");
  });
});
