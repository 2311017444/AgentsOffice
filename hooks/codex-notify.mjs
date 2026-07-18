// Codex notify 转发器：argv JSON → Hub /ingest/codex-notify
// Hub 不在线时静默失败，不影响 Codex 本身。
const arg = process.argv[2];
if (!arg) process.exit(0);

let payload = {};
try {
  payload = JSON.parse(arg);
} catch {
  process.exit(0);
}

const base = process.env.AGENT_OFFICE_URL || "http://127.0.0.1:4517";
try {
  await fetch(`${base}/ingest/codex-notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
} catch {
  /* 静默 */
}
