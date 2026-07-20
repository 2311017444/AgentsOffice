import { describe, expect, it } from "vitest";
import { ShellTerminalManager } from "../src/domain/shellterm.js";

const IS_WIN = process.platform === "win32";

describe("应用内终端（ConPTY）", () => {
  it.runIf(IS_WIN)("创建 PowerShell 会话：能执行命令、回放缓冲、关闭回收", async () => {
    const mgr = new ShellTerminalManager();
    const created = await mgr.create({ shell: "powershell", cols: 90, rows: 24 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.info.id;
    expect(created.info.alive).toBe(true);
    expect(created.info.shell).toBe("powershell.exe");

    let live = "";
    const detach = mgr.attach(
      id,
      (chunk) => {
        live += chunk;
      },
      () => {},
    );
    expect(detach).not.toBeNull();

    mgr.write(id, "echo pty-roundtrip\r");
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (live.includes("pty-roundtrip")) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`没等到回显：${live.slice(-500)}`));
      }, 8000);
    });
    detach!();

    // 新客户端 attach 时应回放缓冲
    let replay = "";
    const detach2 = mgr.attach(
      id,
      (chunk) => {
        replay += chunk;
      },
      () => {},
    );
    expect(replay).toContain("pty-roundtrip");
    detach2!();

    expect(mgr.resize(id, 120, 30)).toBe(true);
    expect(mgr.resize(id, 1, 1)).toBe(false); // 过小拒绝

    expect(mgr.close(id)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  }, 20_000);

  it("不存在的会话：写入/attach/close 都安全返回", () => {
    const mgr = new ShellTerminalManager();
    expect(mgr.write("nope", "x")).toBe(false);
    expect(mgr.attach("nope", () => {}, () => {})).toBeNull();
    expect(mgr.close("nope")).toBe(false);
    expect(mgr.resize("nope", 80, 24)).toBe(false);
  });
});
