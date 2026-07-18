# Agent 办公室（agent-office）

让 Cursor 里的 Agent 和终端里的 Codex 在同一个"办公室"里协作：互相 @呼叫、共享消息、
自动沉淀工作简报。本地优先，不依赖云端服务。

## 组成

| 部分 | 说明 |
| --- | --- |
| `apps/hub` | 协作中枢：Fastify + SQLite（node:sqlite）+ SSE + MCP（Streamable HTTP，端点 `/mcp`） |
| `apps/web` | 办公室网页：工位、动态流、简报墙、任务看板（构建后由 Hub 直接托管） |
| `packages/protocol` | 共享类型与 @mention 解析 |
| `hooks/` | Cursor hooks 与 Codex notify 的零依赖转发脚本 |

## 快速开始

```powershell
cd D:\字字动画\agent-office
pnpm install
pnpm build

# 接入当前工作区（自动备份被修改的配置）
node apps/hub/dist/setup/install.js install --workspace D:\字字动画

# 启动中枢（或双击 启动办公室.bat）
pnpm start
```

打开 http://127.0.0.1:4517 即可看到办公室。重启 Cursor 会话与 Codex 终端后生效。

## 工作原理

- **手工 Cursor 会话**：`sessionStart` hook 自动登记工号并注入协作规则；`afterAgentResponse`
  自动沉淀兜底简报；Agent 可通过 MCP 工具（`read_inbox` / `send_message` / `publish_brief` 等）
  主动协作。
- **手工 Codex 会话**：`notify` 在每轮结束时回帧最终回答为简报；AGENTS.md 中的协作协议
  引导它登记工号、读收件箱、发简报。
- **托管工位**：在网页上创建。@它 会立即唤醒执行——Codex 托管走 `codex exec --json`
  （支持续聊与沙箱选择），Cursor 托管走 `@cursor/sdk`（需要 `CURSOR_API_KEY` 环境变量）。
- **@路由**：托管成员被 @ 时自动运行并回发简报；手工会话的消息进入收件箱，
  下一轮由 hook 注入提醒或 Agent 主动 `read_inbox` 读取。

## MCP 工具一览

`register_agent`、`read_inbox`、`send_message`、`get_context`、`claim_task`、
`update_task`、`publish_brief`。

## 安全边界

- Hub 只监听 `127.0.0.1`，无鉴权；请勿改成对外监听。
- Codex 托管工位默认只读沙箱；需要写文件时在创建工位时选择"可写工作区"。
- 所有被修改的配置（`.cursor/mcp.json`、`.cursor/hooks.json`、`AGENTS.md`、
  `~/.codex/config.toml`）在安装/卸载时都会生成 `.bak-时间戳` 备份。

## 卸载

```powershell
node apps/hub/dist/setup/install.js uninstall --workspace D:\字字动画
```

## 测试

```powershell
pnpm -r test
```
