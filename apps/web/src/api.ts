import type {
  AgentCard,
  OfficeBrief,
  OfficeEvent,
  OfficeMessage,
  OfficeTask,
} from "@agent-office/protocol";

export interface OfficeState {
  agents: AgentCard[];
  messages: OfficeMessage[];
  tasks: OfficeTask[];
  briefs: OfficeBrief[];
  events: OfficeEvent[];
}

export interface Health {
  ok: boolean;
  port: number;
  dataDir: string;
  codexCli: boolean;
  claudeCli: boolean;
  cursorKey: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  state: () => fetch("/api/state").then((r) => json<OfficeState>(r)),
  health: () => fetch("/api/health").then((r) => json<Health>(r)),
  sendMessage: (text: string) =>
    fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => json<{ routed: Array<{ name: string; mode: string }> }>(r)),
  createTask: (title: string, description: string, assignee: string | null) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description, assignee }),
    }).then((r) => json<OfficeTask>(r)),
  updateTask: (id: string, patch: { status?: string; assignee?: string | null }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<OfficeTask>(r)),
  createManagedAgent: (input: {
    name: string;
    kind: "codex" | "cursor" | "claude";
    workspace: string;
    sandbox: "read-only" | "workspace-write";
    model?: string;
  }) =>
    fetch("/api/agents/managed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<AgentCard>(r)),
  updateAgent: (id: string, patch: { name?: string; model?: string }) =>
    fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<AgentCard>(r)),
  dispatch: (input: { title: string; description?: string; agents?: string[] }) =>
    fetch("/api/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) =>
      json<{ assignedTo: string[]; reason: string; task: OfficeTask }>(r),
    ),
};
