"use strict";
// Optional PAC completion notifications. Credentials remain in a private local file.
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const BASE = process.env.PAC_TELEGRAM_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".hapi-servermall", "pac-bridge", "notify");
const STATE = path.join(BASE, "tg-state");
const LOG = path.join(BASE, "tg-notify.log");
fs.mkdirSync(STATE, { recursive: true });
function log(text) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 262144) fs.renameSync(LOG, LOG + ".old");
    fs.appendFileSync(LOG, new Date().toISOString() + " " + text + "\n");
  } catch (_) {}
}
function env() {
  const values = {};
  const file = path.join(BASE, "tg-notify.env");
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
function redact(value) {
  return String(value || "").replace(/\b(?:sk-|glpat-)[\w-]+/g, "[секрет скрыт]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[секрет скрыт]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[секрет скрыт]");
}
function clean(value, cap = 1200) {
  return redact(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, cap);
}
async function send(text) {
  const settings = env();
  if (!settings.TG_BOT_TOKEN || !settings.TG_CHAT_ID) throw new Error("Telegram credentials missing");
  const body = JSON.stringify({ chat_id: settings.TG_CHAT_ID, text: clean(text, 3500), disable_web_page_preview: true });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "api.telegram.org", path: "/bot" + settings.TG_BOT_TOKEN + "/sendMessage",
      method: "POST", timeout: 8000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let data = "";
      res.on("data", chunk => { if (data.length < 32768) data += chunk; });
      res.on("end", () => {
        try {
          const reply = JSON.parse(data);
          if (res.statusCode !== 200 || !reply.ok) return reject(new Error("Telegram HTTP " + res.statusCode + ": " + clean(reply.description, 160)));
          if (reply.result.text !== JSON.parse(body).text) return reject(new Error("Telegram text verification failed"));
          log("delivered message=" + reply.result.message_id + " text_verified=true");
          resolve(reply.result.message_id);
        } catch (_) { reject(new Error("Invalid Telegram response")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram timeout")));
    req.on("error", error => reject(new Error(clean(error.code || "Telegram connection failed", 80))));
    req.end(body);
  });
}
function stamp(hook) {
  return path.join(STATE, String(hook.session_id || hook["thread-id"] || "unknown").replace(/[^\w.-]/g, "_") + ".json");
}
function readState(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; } }
function questionText(input) {
  if (typeof input === "string") { try { input = JSON.parse(input); } catch (_) { return "Нужен твой ответ в чате."; } }
  return (input?.questions || []).map(q => q.title || q.question || "").filter(Boolean).join("\n\n") || "Нужен твой ответ в чате.";
}
async function notify(hook) {
  const event = hook.hook_event_name || (hook.type === "agent-turn-complete" ? "Stop" : "");
  const project = path.basename(hook.cwd || process.cwd());
  const file = stamp(hook), state = readState(file);
  if (event === "UserPromptSubmit") {
    fs.writeFileSync(file, JSON.stringify({ ...state, started: Date.now(), active: true }));
    return;
  }
  let text, identity;
  if (event === "Stop") {
    state.active = false;
    state.stopped = Date.now();
    fs.writeFileSync(file, JSON.stringify(state));
    const message = clean(hook.last_assistant_message || hook["last-assistant-message"] || "Ответ готов.", 1800);
    text = "Codex закончил ответ • " + project + "\n\n" + message;
    identity = "done:" + (hook.turn_id || hook["turn-id"] || crypto.createHash("sha256").update(message).digest("hex"));
  } else if (event === "PermissionRequest") {
    text = "Codex просит разрешение • " + project + "\n\n" + clean(hook.tool_input?.description || "Посмотри запрос разрешения в чате.");
    identity = "permission:" + (hook.tool_use_id || hook.turn_id || text);
  } else if (event === "PreToolUse" && /(?:^|[._])request_user_input(?:_async)?$/.test(hook.tool_name || "")) {
    const question = clean(questionText(hook.tool_input));
    text = "Codex ждёт твоего ответа • " + project + "\n\n" + question;
    identity = "question:" + (hook.tool_use_id || question);
  } else return;
  // Detect encoding damage before sending an unreadable notification.
  if (/\?{4,}/.test(text)) {
    log("notification text has encoding damage; sending readable notice");
    text = (event === "Stop" ? "Codex закончил ответ" : "Codex ждёт твоего ответа") + " • " + project +
      "\n\nТекст уведомления повреждён при передаче. Открой чат Codex, чтобы прочитать сообщение.";
  }
  const key = crypto.createHash("sha256").update(file + ":" + identity).digest("hex");
  const lock = path.join(STATE, key + ".sent");
  try {
    const previous = fs.statSync(lock);
    if (Date.now() - previous.mtimeMs < 60000) return;
    fs.unlinkSync(lock);
  } catch (_) {}
  let fd;
  try { fd = fs.openSync(lock, "wx"); fs.closeSync(fd); } catch (_) { return; }
  try { await send(text); }
  catch (error) { try { fs.unlinkSync(lock); } catch (_) {} throw error; }
}
async function main() {
  let raw = process.argv[2];
  if (!raw) { raw = ""; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1048576) throw new Error("Hook input too large"); } }
  await notify(JSON.parse(raw || "{}"));
}
module.exports = { send, notify, clean, log };
if (require.main === module) main().catch(error => log("error " + clean(error.message, 180))).finally(() => { process.stdout.write("{}\n"); });
