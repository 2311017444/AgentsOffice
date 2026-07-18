import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@agent-office/protocol";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { createManagedDispatcher } from "../src/domain/runners.js";
import { OfficeStore } from "../src/domain/store.js";
import type { OfficeConfig } from "../src/config.js";

const testConfig: OfficeConfig = {
  port: 4517,
  dataDir: ":memory:",
  cursorModel: "composer-2.5",
  codexTurnTimeoutMs: 1000,
};

function makeOffice() {
  const store = new OfficeStore(":memory:");
  return new OfficeService(store, new OfficeBus());
}

describe("终端直连输入", () => {
  it("原样透传提示词，结果回传群里但不发简报，终端留痕", async () => {
    const office = makeOffice();
    const prompts: string[] = [];
    const dispatch = createManagedDispatcher(office, testConfig, {
      "codex-managed": vi.fn(async (_a: AgentCard, prompt: string) => {
        prompts.push(prompt);
        return { text: "已按要求调整", usage: 321 };
      }),
    });
    office.setManagedDispatcher(dispatch);
    const agent = office.store.registerAgent({ name: "codex-研发", kind: "codex-managed" });

    const result = office.directInput(agent.id, "把 sandbox 切成 workspace-write 再自检一次");
    expect(result.ok).toBe(true);

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    // 关键：不套办公室提示词模板，老板敲什么就发什么
    expect(prompts[0]).toBe("把 sandbox 切成 workspace-write 再自检一次");
    expect(prompts[0]).not.toContain("简报");

    await vi.waitFor(() =>
      expect(
        office.terminals.get(agent.id).some((l) => l.text.includes("直连执行完成")),
      ).toBe(true),
    );
    // 输入行以 ❯ 提示符留痕
    expect(office.terminals.get(agent.id).some((l) => l.text.startsWith("❯ "))).toBe(true);
    // 结果以【直连回复】回传到群里，但不发简报
    const replies = office.store.listMessages().filter((m) => m.fromName === "codex-研发");
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("【直连回复】已按要求调整");
    expect(office.store.listBriefs()).toHaveLength(0);
    // token 照常入账，状态恢复
    expect(office.store.todayTokens(agent.id)).toBe(321);
    expect(office.store.getAgentById(agent.id)!.status).toBe("online");
  });

  it("codex-cli 带 threadId 也能直连（按 kind 前缀路由到 codex runner）", async () => {
    const office = makeOffice();
    const runner = vi.fn(async () => ({ text: "续聊成功" }));
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, { "codex-managed": runner }),
    );
    const agent = office.store.registerAgent({
      name: "codex-主力",
      kind: "codex-cli",
      meta: { threadId: "t-9" },
    });

    expect(office.directInput(agent.id, "继续刚才的事").ok).toBe(true);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(runner.mock.calls[0][1]).toBe("继续刚才的事");
  });

  it("claude-cli 带 sessionId 直连走 claude runner", async () => {
    const office = makeOffice();
    const claudeRunner = vi.fn(async () => ({ text: "ok" }));
    const cursorRunner = vi.fn(async () => ({ text: "不该被调用" }));
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "claude-managed": claudeRunner,
        "cursor-managed": cursorRunner,
      }),
    );
    const agent = office.store.registerAgent({
      name: "claude-git库管理",
      kind: "claude-cli",
      meta: { sessionId: "s-9" },
    });

    expect(office.directInput(agent.id, "查一下仓库状态").ok).toBe(true);
    await vi.waitFor(() => expect(claudeRunner).toHaveBeenCalledTimes(1));
    expect(cursorRunner).not.toHaveBeenCalled();
  });

  it("不合格的成员与空输入被拒绝", () => {
    const office = makeOffice();
    office.setManagedDispatcher(createManagedDispatcher(office, testConfig, {}));

    const cursor = office.store.registerAgent({ name: "cursor-x", kind: "cursor-ide" });
    expect(office.directInput(cursor.id, "喂").ok).toBe(false);

    const bare = office.store.registerAgent({ name: "codex-裸", kind: "codex-cli" });
    const bareResult = office.directInput(bare.id, "喂");
    expect(bareResult.ok).toBe(false);
    expect(bareResult.error).toContain("续聊凭证");

    const managed = office.store.registerAgent({ name: "codex-m", kind: "codex-managed" });
    expect(office.directInput(managed.id, "   ").ok).toBe(false);
    expect(office.directInput("no-such-id", "喂").ok).toBe(false);
  });

  it("直连失败不动收件箱，错误留在终端", async () => {
    const office = makeOffice();
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "codex-managed": async () => {
          throw new Error("boom-direct");
        },
      }),
    );
    const agent = office.store.registerAgent({ name: "codex-y", kind: "codex-managed" });
    office.directInput(agent.id, "干个活");

    await vi.waitFor(() =>
      expect(
        office.terminals.get(agent.id).some((l) => l.kind === "error" && l.text.includes("boom-direct")),
      ).toBe(true),
    );
    expect(office.store.getAgentById(agent.id)!.status).toBe("online");
  });
});
