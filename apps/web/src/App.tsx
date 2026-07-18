import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AGENT_KIND_LABELS } from "@agent-office/protocol";
import type { AgentCard, OfficeBrief, OfficeTask } from "@agent-office/protocol";
import { api, type Health, type OfficeState } from "./api";

const STATUS_LABELS: Record<string, string> = {
  online: "在席",
  busy: "忙碌",
  offline: "离席",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  open: "待认领",
  claimed: "已认领",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
};

const SOURCE_LABELS: Record<string, string> = {
  mcp: "主动发布",
  "cursor-hook": "Cursor 回帧",
  "codex-notify": "Codex 回帧",
  "codex-managed": "托管执行",
  "cursor-managed": "托管执行",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function highlightMentions(text: string): React.ReactNode[] {
  const parts = text.split(/(@[\p{L}\p{N}_./-]+)/gu);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="mention">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

// ---------- 工位卡片 ----------

function AgentBadge({ agent, onMention }: { agent: AgentCard; onMention: (name: string) => void }) {
  return (
    <div className={`badge status-${agent.status}`}>
      <div className="badge-top">
        <span className="lamp" aria-label={STATUS_LABELS[agent.status]} />
        <span className="badge-name">{agent.name}</span>
        {(agent.pendingCount ?? 0) > 0 && (
          <span className="pending-pill" title="未读消息">
            {agent.pendingCount}
          </span>
        )}
      </div>
      <div className="badge-kind">{AGENT_KIND_LABELS[agent.kind] ?? agent.kind}</div>
      {agent.workspace && (
        <div className="badge-workspace" title={agent.workspace}>
          {agent.workspace.split(/[\\/]/).slice(-2).join("/")}
        </div>
      )}
      <div className="badge-footer">
        <span className="badge-seen">
          {agent.lastSeenAt ? timeAgo(agent.lastSeenAt) : "—"}
        </span>
        {agent.kind !== "user" && (
          <button className="ghost-btn" onClick={() => onMention(agent.name)}>
            @呼叫
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- 新建托管工位 ----------

function NewAgentForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"codex" | "cursor">("codex");
  const [workspace, setWorkspace] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("read-only");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="add-desk" onClick={() => setOpen(true)}>
        ＋ 新建托管工位
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.createManagedAgent({ name: name.trim(), kind, workspace: workspace.trim(), sandbox });
      setOpen(false);
      setName("");
      setWorkspace("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-agent-form">
      <input
        placeholder="工号（如 codex-研发）"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as "codex" | "cursor")}>
        <option value="codex">Codex 托管</option>
        <option value="cursor">Cursor 托管（需 API Key）</option>
      </select>
      <input
        placeholder="工作目录（如 D:\字字动画\画布）"
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
      />
      {kind === "codex" && (
        <select
          value={sandbox}
          onChange={(e) => setSandbox(e.target.value as "read-only" | "workspace-write")}
        >
          <option value="read-only">只读沙箱</option>
          <option value="workspace-write">可写工作区</option>
        </select>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="primary-btn" disabled={busy || !name.trim()} onClick={submit}>
          创建
        </button>
        <button className="ghost-btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------- 消息输入（@自动补全） ----------

function Composer({
  agents,
  prefill,
  onSent,
}: {
  agents: AgentCard[];
  prefill: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill) {
      setText((prev) => (prev.includes(prefill) ? prev : `${prefill} ${prev}`));
      inputRef.current?.focus();
    }
  }, [prefill]);

  const names = useMemo(
    () => agents.filter((a) => a.kind !== "user").map((a) => a.name),
    [agents],
  );

  const updateSuggestions = (value: string) => {
    const caretWord = value.slice(0, inputRef.current?.selectionStart ?? value.length);
    const match = caretWord.match(/@([\p{L}\p{N}_./-]*)$/u);
    if (!match) {
      setSuggestions([]);
      return;
    }
    const query = match[1].toLowerCase();
    const list = ["all", ...names].filter((n) => n.toLowerCase().startsWith(query)).slice(0, 6);
    setSuggestions(list);
    setSelected(0);
  };

  const applySuggestion = (name: string) => {
    const caret = inputRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\p{L}\p{N}_./-]*)$/u, `@${name} `);
    setText(before + text.slice(caret));
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const send = async () => {
    if (!text.trim()) return;
    try {
      const result = await api.sendMessage(text.trim());
      const managed = result.routed.filter((r) => r.mode === "managed").map((r) => r.name);
      const inbox = result.routed.filter((r) => r.mode === "inbox").map((r) => r.name);
      const parts: string[] = [];
      if (managed.length > 0) parts.push(`已唤醒：${managed.join("、")}`);
      if (inbox.length > 0) parts.push(`已入箱（下轮读取）：${inbox.join("、")}`);
      setHint(parts.join("；") || "已发送");
      setText("");
      onSent();
      setTimeout(() => setHint(""), 5000);
    } catch (e) {
      setHint(`发送失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(name);
              }}
            >
              @{name}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={inputRef}
        value={text}
        rows={2}
        placeholder="给办公室发消息，@工号 可呼叫成员（@all 全员）……"
        onChange={(e) => {
          setText(e.target.value);
          updateSuggestions(e.target.value);
        }}
        onKeyDown={(e) => {
          if (suggestions.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => (s + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              applySuggestion(suggestions[selected]);
              return;
            }
            if (e.key === "Escape") {
              setSuggestions([]);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-row">
        <span className="composer-hint">{hint || "Enter 发送，Shift+Enter 换行"}</span>
        <button className="primary-btn" onClick={() => void send()} disabled={!text.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}

// ---------- 简报卡片 ----------

function BriefCard({ brief }: { brief: OfficeBrief }) {
  const [expanded, setExpanded] = useState(false);
  const long = brief.result.length > 220;
  const fields: Array<[string, string | null]> = [
    ["进展", brief.progress],
    ["决策", brief.decisions],
    ["产物", brief.artifacts],
    ["阻塞", brief.blockers],
    ["下一步", brief.nextSteps],
  ];
  return (
    <article className={`brief-card ${brief.kind}`}>
      <div className="brief-stamp" aria-hidden>
        报
      </div>
      <header>
        <strong>{brief.agentName}</strong>
        <span className="brief-source">{SOURCE_LABELS[brief.source] ?? brief.source}</span>
        <time>{timeAgo(brief.createdAt)}</time>
      </header>
      <h4>{brief.title}</h4>
      <p className="brief-result">
        {long && !expanded ? `${brief.result.slice(0, 220)}…` : brief.result}
      </p>
      {long && (
        <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
      {fields.some(([, v]) => v) && (
        <dl className="brief-fields">
          {fields.map(
            ([label, value]) =>
              value && (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ),
          )}
        </dl>
      )}
    </article>
  );
}

// ---------- 任务面板 ----------

function TaskPanel({
  tasks,
  agents,
  onChanged,
}: {
  tasks: OfficeTask[];
  agents: AgentCard[];
  onChanged: () => void;
}) {
  const [title, setTitle] = useState("");
  const assignable = agents.filter((a) => a.kind !== "user");

  const create = async () => {
    if (!title.trim()) return;
    await api.createTask(title.trim(), "", null);
    setTitle("");
    onChanged();
  };

  return (
    <section className="panel">
      <h3>任务看板</h3>
      <div className="task-new">
        <input
          value={title}
          placeholder="新任务标题…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button className="primary-btn" onClick={() => void create()} disabled={!title.trim()}>
          创建
        </button>
      </div>
      <ul className="task-list">
        {tasks.length === 0 && <li className="empty">暂无任务，创建一个分派给成员吧。</li>}
        {tasks.map((task) => (
          <li key={task.id} className={`task task-${task.status}`}>
            <div className="task-main">
              <span className="task-title">{task.title}</span>
              <span className={`task-status s-${task.status}`}>
                {TASK_STATUS_LABELS[task.status]}
              </span>
            </div>
            <div className="task-meta">
              <select
                value={task.assigneeName ?? ""}
                onChange={(e) =>
                  api
                    .updateTask(task.id, { assignee: e.target.value || null })
                    .then(onChanged)
                }
              >
                <option value="">未分派</option>
                {assignable.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select
                value={task.status}
                onChange={(e) => api.updateTask(task.id, { status: e.target.value }).then(onChanged)}
              >
                {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- 主应用 ----------

export function App() {
  const [state, setState] = useState<OfficeState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [mentionPrefill, setMentionPrefill] = useState("");
  const [tab, setTab] = useState<"feed" | "briefs">("feed");
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      api.state().then(setState).catch(() => {});
    }, 300);
  }, []);

  useEffect(() => {
    api.state().then(setState).catch(() => {});
    api.health().then(setHealth).catch(() => {});
    const source = new EventSource("/api/events");
    source.onmessage = () => refresh();
    const healthTimer = window.setInterval(() => {
      api.health().then(setHealth).catch(() => setHealth(null));
    }, 30_000);
    return () => {
      source.close();
      window.clearInterval(healthTimer);
    };
  }, [refresh]);

  const feed = useMemo(() => {
    if (!state) return [];
    const items: Array<{ key: string; at: number; node: React.ReactNode }> = [];
    for (const m of state.messages) {
      items.push({
        key: `m-${m.id}`,
        at: m.createdAt,
        node: (
          <div className="feed-item feed-message">
            <div className="feed-head">
              <strong>{m.fromName}</strong>
              <time>{timeAgo(m.createdAt)}</time>
            </div>
            <p>{highlightMentions(m.text)}</p>
            {m.deliveries.length > 0 && (
              <div className="feed-deliveries">
                {m.deliveries.map((d) => (
                  <span key={d.toName} className={`delivery ${d.status}`}>
                    {d.toName}
                    {d.status === "read" ? " ✓" : " …"}
                  </span>
                ))}
              </div>
            )}
          </div>
        ),
      });
    }
    for (const e of state.events) {
      items.push({
        key: `e-${e.id}`,
        at: e.createdAt,
        node: (
          <div className="feed-item feed-event">
            <span>
              {e.agentName ? `${e.agentName} · ` : ""}
              {e.text ?? e.type}
            </span>
            <time>{timeAgo(e.createdAt)}</time>
          </div>
        ),
      });
    }
    return items.sort((a, b) => a.at - b.at).slice(-120);
  }, [state]);

  const feedEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed.length, tab]);

  if (!state) {
    return (
      <div className="loading">
        <p>正在连接办公室中枢……</p>
        <p className="loading-sub">
          如果一直停在这里，请先启动中枢：<code>agent-office\启动办公室.bat</code>
        </p>
      </div>
    );
  }

  const agents = state.agents.filter((a) => a.kind !== "user");

  return (
    <div className="office">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            办
          </span>
          <div>
            <h1>Agent 办公室</h1>
            <p>字字动画 · 多 Agent 协作中枢</p>
          </div>
        </div>
        <div className="health">
          <span className={`chip ${health ? "ok" : "bad"}`}>
            中枢 {health ? "在线" : "离线"}
          </span>
          <span className={`chip ${health?.codexCli ? "ok" : "bad"}`}>
            Codex CLI {health?.codexCli ? "可用" : "未检测到"}
          </span>
          <span className={`chip ${health?.cursorKey ? "ok" : "warn"}`}>
            Cursor Key {health?.cursorKey ? "已配置" : "未配置"}
          </span>
        </div>
      </header>

      <main className="layout">
        <aside className="col col-roster">
          <section className="panel">
            <h3>工位（{agents.length}）</h3>
            <div className="badges">
              {agents.length === 0 && (
                <p className="empty">
                  还没有成员入驻。启动一个 Cursor 会话或 Codex 终端，它们会自动登记；也可以新建托管工位。
                </p>
              )}
              {agents.map((agent) => (
                <AgentBadge
                  key={agent.id}
                  agent={agent}
                  onMention={(name) => setMentionPrefill(`@${name}`)}
                />
              ))}
            </div>
            <NewAgentForm onDone={refresh} />
          </section>
        </aside>

        <section className="col col-center">
          <nav className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "feed"}
              className={tab === "feed" ? "active" : ""}
              onClick={() => setTab("feed")}
            >
              动态流
            </button>
            <button
              role="tab"
              aria-selected={tab === "briefs"}
              className={tab === "briefs" ? "active" : ""}
              onClick={() => setTab("briefs")}
            >
              简报墙（{state.briefs.length}）
            </button>
          </nav>
          {tab === "feed" ? (
            <div className="feed" role="log">
              {feed.length === 0 && <p className="empty">还没有动态。发一条消息试试。</p>}
              {feed.map((item) => (
                <div key={item.key}>{item.node}</div>
              ))}
              <div ref={feedEndRef} />
            </div>
          ) : (
            <div className="brief-wall">
              {state.briefs.length === 0 && (
                <p className="empty">还没有简报。成员完成工作后会自动出现在这里。</p>
              )}
              {state.briefs.map((brief) => (
                <BriefCard key={brief.id} brief={brief} />
              ))}
            </div>
          )}
          <Composer agents={state.agents} prefill={mentionPrefill} onSent={refresh} />
        </section>

        <aside className="col col-tasks">
          <TaskPanel tasks={state.tasks} agents={state.agents} onChanged={refresh} />
        </aside>
      </main>
    </div>
  );
}
