import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@agent-office/protocol";
import { buildManagedPrompt } from "@agent-office/protocol";
import { OfficeBus } from "../src/domain/bus.js";
import { OfficeService } from "../src/domain/office.js";
import { buildCodexExecArgs, createManagedDispatcher } from "../src/domain/runners.js";
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

function makeUploads(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "office-uploads-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { dir, file };
}

describe("图片输入", () => {
  it("消息附图落库并随收件箱返回", () => {
    const office = makeOffice();
    const agent = office.store.registerAgent({ name: "codex-画布", kind: "codex-cli" });
    office.sendMessage({
      fromName: "老板",
      text: "@codex-画布 看下这个报错截图",
      images: ["/files/shot.png"],
    });
    const msg = office.store.listMessages().at(-1)!;
    expect(msg.images).toEqual(["/files/shot.png"]);
    const pending = office.store.pendingMessagesFor(agent.id);
    expect(pending[0].images).toEqual(["/files/shot.png"]);
  });

  it("resolveImagePaths 只认 uploads 目录里真实存在的文件，且防路径穿越", () => {
    const office = makeOffice();
    const { dir } = makeUploads();
    // 未配置 uploads 目录时返回空
    expect(office.resolveImagePaths(["/files/shot.png"])).toEqual([]);
    office.uploadsDir = dir;
    expect(office.resolveImagePaths(["/files/shot.png"])).toEqual([join(dir, "shot.png")]);
    // 不存在的文件被过滤
    expect(office.resolveImagePaths(["/files/nope.png"])).toEqual([]);
    // 路径穿越：只取 basename
    expect(office.resolveImagePaths(["/files/../../etc/shot.png"])).toEqual([
      join(dir, "shot.png"),
    ]);
  });

  it("托管派发时把图片本地路径注入提示词；直连输入也附带", async () => {
    const office = makeOffice();
    const { dir, file } = makeUploads();
    office.uploadsDir = dir;
    const prompts: string[] = [];
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "codex-managed": vi.fn(async (_a: AgentCard, prompt: string) => {
          prompts.push(prompt);
          return { text: "看完了" };
        }),
      }),
    );
    const agent = office.store.registerAgent({ name: "codex-研发", kind: "codex-managed" });

    office.sendMessage({
      fromName: "老板",
      text: "@codex-研发 分析截图",
      images: ["/files/shot.png"],
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain(file);
    expect(prompts[0]).toContain("图片查看工具");
    // 终端留痕带附图数量
    expect(
      office.terminals.get(agent.id).some((l) => l.kind === "cmd" && l.text.includes("附图 1 张")),
    ).toBe(true);

    office.directInput(agent.id, "再看一遍这张图", ["/files/shot.png"]);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain("再看一遍这张图");
    expect(prompts[1]).toContain(file);
  });

  it("Codex 命令行附图走 -i 作为真视觉输入（新会话与 resume 均支持）", () => {
    const fresh = buildCodexExecArgs({}, "D:/proj", ["C:/up/a.png", "C:/up/b.png"]);
    expect(fresh.join(" ")).toContain("-i C:/up/a.png -i C:/up/b.png -");
    const resumed = buildCodexExecArgs({ threadId: "t1" }, null, ["C:/up/a.png"]);
    expect(resumed).toContain("resume");
    expect(resumed.join(" ")).toContain("-i C:/up/a.png -");
    // 无图不产生 -i
    expect(buildCodexExecArgs({}, null)).not.toContain("-i");
  });

  it("托管 runner 收到附图本地路径参数", async () => {
    const office = makeOffice();
    const { dir, file } = makeUploads();
    office.uploadsDir = dir;
    const seen: string[][] = [];
    office.setManagedDispatcher(
      createManagedDispatcher(office, testConfig, {
        "codex-managed": vi.fn(
          async (_a: AgentCard, _p: string, _io?: unknown, imgs?: string[]) => {
            seen.push(imgs ?? []);
            return { text: "ok" };
          },
        ),
      }),
    );
    office.store.registerAgent({ name: "codex-视觉", kind: "codex-managed" });
    office.sendMessage({
      fromName: "老板",
      text: "@codex-视觉 看图",
      images: ["/files/shot.png"],
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([file]);
  });

  it("buildManagedPrompt 无图时不出现附图段落", () => {
    const prompt = buildManagedPrompt({
      agentName: "a",
      senderName: "老板",
      text: "干活",
    });
    expect(prompt).not.toContain("附了");
  });

  it("重启恢复的补派消息携带附图", () => {
    const office = makeOffice();
    const { dir, file } = makeUploads();
    office.uploadsDir = dir;
    office.store.registerAgent({ name: "codex-a", kind: "codex-managed" });
    office.sendMessage({
      fromName: "老板",
      text: "@codex-a 处理截图",
      images: ["/files/shot.png"],
    });

    const dispatched: Array<{ images?: string[] }> = [];
    office.setManagedDispatcher((_a, m) => dispatched.push({ images: m.images }));
    expect(office.recoverPendingDispatches()).toBe(1);
    expect(dispatched[0].images).toEqual(["/files/shot.png"]);
    expect(office.resolveImagePaths(dispatched[0].images)).toEqual([file]);
  });
});
