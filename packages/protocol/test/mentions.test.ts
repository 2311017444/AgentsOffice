import { describe, expect, it } from "vitest";
import { parseMentions } from "../src/index.js";

const roster = ["codex-a1b2", "cursor-x9y8", "小明", "老板", "web-助手"];

describe("parseMentions", () => {
  it("解析普通英文工号", () => {
    const r = parseMentions("@codex-a1b2 请帮我跑测试", roster);
    expect(r.targets).toEqual(["codex-a1b2"]);
    expect(r.all).toBe(false);
  });

  it("忽略大小写", () => {
    const r = parseMentions("@CODEX-A1B2 在吗", roster);
    expect(r.targets).toEqual(["codex-a1b2"]);
  });

  it("名字后紧跟标点", () => {
    const r = parseMentions("@cursor-x9y8,看一下简报", roster);
    expect(r.targets).toEqual(["cursor-x9y8"]);
  });

  it("中文名与正文连写时收缩匹配", () => {
    const r = parseMentions("@小明请看下这个接口", roster);
    expect(r.targets).toEqual(["小明"]);
  });

  it("@all 与中文别名", () => {
    expect(parseMentions("@all 开会了", roster).all).toBe(true);
    expect(parseMentions("@所有人 开会了", roster).all).toBe(true);
    expect(parseMentions("@全员注意", roster).all).toBe(true);
  });

  it("多个提及去重", () => {
    const r = parseMentions("@小明 @小明 @codex-a1b2", roster);
    expect(r.targets.sort()).toEqual(["codex-a1b2", "小明"].sort());
  });

  it("未知名字不产生目标", () => {
    const r = parseMentions("@不存在的人 你好", roster);
    expect(r.targets).toEqual([]);
    expect(r.all).toBe(false);
  });

  it("无 @ 时返回空", () => {
    const r = parseMentions("普通消息", roster);
    expect(r.targets).toEqual([]);
  });
});
