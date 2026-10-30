// src/main.ts
import { rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import net from "node:net";
import { Events as Events2 } from "discord.js";

// src/config.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
var DATA_DIR = path.resolve(process.env.CHANNELCOLLAB_HOME || path.join(os.homedir(), ".channelcollab"));
var CONFIG_PATH = path.join(DATA_DIR, "config.json");
var PID_PATH = path.join(DATA_DIR, "bot.pid");
var INBOX_DIR = path.join(DATA_DIR, "inbox");
var STOP_PIPE = `\\\\.\\pipe\\channelcollab-${createHash("sha1").update(DATA_DIR.toLowerCase()).digest("hex").slice(0, 12)}`;
var BUILTIN_DEFAULTS = {
  history: 30,
  max_hops: 5,
  busy_policy: "queue",
  idle_close_minutes: 120,
  max_live_sessions: 4,
  permission_mode: "default",
  permission_timeout_minutes: 10
};
var ALLOWED_MODES = ["default", "acceptEdits", "plan", "dontAsk", "auto"];
function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${CONFIG_PATH} (${e.name})`);
  }
  const c = raw;
  if (!c.discord?.token) throw new Error(`${CONFIG_PATH}: discord.token is missing`);
  return {
    discord: { token: c.discord.token, guild_id: c.discord.guild_id, owner_id: c.discord.owner_id },
    defaults: { ...BUILTIN_DEFAULTS, ...c.defaults },
    channels: c.channels ?? {}
  };
}
function resolveChannel(config2, channelId) {
  const ch = config2.channels[channelId];
  if (!ch) return void 0;
  const permissionMode = ch.permission_mode ?? config2.defaults.permission_mode;
  if (!ALLOWED_MODES.includes(permissionMode)) {
    throw new Error(`channel ${channelId}: permission_mode "${permissionMode}" is not allowed`);
  }
  return {
    channelId,
    cwd: ch.cwd,
    launcher: ch.launcher ?? "",
    model: ch.model,
    permissionMode,
    tools: ch.tools,
    history: config2.defaults.history,
    maxHops: config2.defaults.max_hops,
    permissionTimeoutMs: config2.defaults.permission_timeout_minutes * 60 * 1e3
  };
}

// src/discord/bot.ts
import path7 from "node:path";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration
} from "discord.js";

// src/log.ts
function log(tag, ...rest) {
  console.log(`[${(/* @__PURE__ */ new Date()).toISOString().slice(11, 23)}] [${tag}]`, ...rest);
}
function brief(value, max = 200) {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

// src/router/queue.ts
var tails = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
function enqueue(key, job) {
  const ahead = pending.get(key) ?? 0;
  pending.set(key, ahead + 1);
  const run = async () => {
    try {
      await job();
    } finally {
      const left = (pending.get(key) ?? 1) - 1;
      if (left > 0) pending.set(key, left);
      else pending.delete(key);
    }
  };
  const tail = (tails.get(key) ?? Promise.resolve()).then(run, run);
  tails.set(key, tail);
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return { queued: ahead > 0 };
}
function isPending(key) {
  return pending.has(key);
}
function anyPending() {
  return pending.size > 0;
}

// src/router/trigger.ts
function decide(f) {
  if (f.fromSelf) return { action: "ignore", reason: "own-message" };
  if (f.isSystem) return { action: "ignore", reason: "system-message" };
  if (!f.baseChannelBound) return { action: "ignore", reason: "unbound-channel" };
  if (f.fromBot && !f.mentionsMe) return { action: "ignore", reason: "bot-without-mention" };
  if (!f.inThread) return f.mentionsMe ? { action: "open-thread" } : { action: "ignore", reason: "not-mentioned" };
  if (f.mentionsMe) return { action: "run" };
  if (f.mentionsOtherBot) return { action: "ignore", reason: "other-bot-mentioned" };
  return f.openedByMe ? { action: "run" } : { action: "ignore", reason: "not-opener" };
}
function countHops(messages) {
  let hops = 0;
  for (const m of messages) {
    if (m.isSystem) continue;
    if (!m.fromBot) return { hops, human: m };
    if (m.mentionsBot) hops++;
  }
  return { hops };
}

// src/store/state.ts
import { existsSync, mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import path2 from "node:path";
var STATE_PATH = path2.join(DATA_DIR, "state.json");
var state = { threads: {} };
function loadState() {
  if (!existsSync(STATE_PATH)) return;
  state = JSON.parse(readFileSync2(STATE_PATH, "utf8"));
  state.threads ??= {};
}
function saveState() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, STATE_PATH);
}
function getThread(threadId) {
  return state.threads[threadId];
}
function registerThread(threadId, channelId) {
  const t = { channelId, lastCostTotal: 0, resumeCostBase: 0, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  state.threads[threadId] = t;
  saveState();
  return t;
}

// src/runner/session.ts
import { existsSync as existsSync3, realpathSync, statSync } from "node:fs";
import path5 from "node:path";
import {
  createSdkMcpServer,
  query,
  tool
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// src/roster.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
import path3 from "node:path";
var ROSTER_PATH = path3.join(DATA_DIR, "roster.json");
var ROLE_NAMES = { engineer: "\u5DE5\u7A0B\u5E2B", planner: "\u4F01\u5283" };
function loadRoster() {
  if (!existsSync2(ROSTER_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync3(ROSTER_PATH, "utf8"));
    return Array.isArray(raw.bots) ? raw.bots : [];
  } catch (e) {
    log("roster", `cannot read ${ROSTER_PATH} (${e.name})`);
    return [];
  }
}
function rosterOwner(selfId) {
  return loadRoster().find((b) => b.botId === selfId)?.ownerDiscordId;
}
function botOwner(configured, selfId) {
  return configured || rosterOwner(selfId);
}
function roleName(role) {
  return ROLE_NAMES[role] ?? role;
}
function rosterPrompt(selfId, ownerId, roster = loadRoster()) {
  const self = roster.find((b) => b.botId === selfId);
  const others = roster.filter((b) => b.botId !== selfId);
  const lines = [
    self ? `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F ${self.botName}\uFF08Discord ID ${selfId}\uFF09\uFF0C${self.ownerName} \u7684 Bot\uFF0C\u89D2\u8272\uFF1A${roleName(self.role)}\u3002` : `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F Discord ID ${selfId} \u7684 Bot\uFF08\u4E0D\u5728\u540D\u518A\u4E2D\uFF09\u3002`
  ];
  if (ownerId) lines.push(`\u3010\u4F60\u7684\u4E3B\u4EBA\u3011Discord ID ${ownerId}\uFF1B\u8981\u627E\u4E3B\u4EBA\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@${ownerId}>\u3002`);
  if (others.length) {
    lines.push("\u3010\u5176\u4ED6 Bot\u3011\uFF08\u540D\u518A\uFF1B\u8A0E\u8AD6\u4E32\u88E1\u53EF\u80FD\u51FA\u73FE\u9019\u4E9B Bot\uFF09");
    for (const b of others) lines.push(`- ${b.botName}\uFF1A\u4E3B\u4EBA ${b.ownerName}\uFF0C\u89D2\u8272 ${roleName(b.role)}\uFF1B\u8981\u627E\u5B83\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@${b.botId}>`);
  }
  lines.push(
    "\u3010\u548C\u5176\u4ED6 Bot \u5354\u4F5C\u3011",
    "- \u8981\u8B93\u67D0\u500B Bot \u6536\u5230\u8A0A\u606F\uFF0C\u5FC5\u9808\u5728 reply \u7684\u6587\u5B57\u88E1\u5BEB `<@BotID>`\uFF08\u898B\u4E0A\u65B9\u540D\u518A\uFF09\u3002\u5C0D\u8A71\u7D00\u9304\u88E1\u986F\u793A\u7684\u300C@\u540D\u7A31\u300D\u53EA\u662F\u6587\u5B57\uFF0C\u7167\u6284\u4E0D\u6703\u901A\u77E5\u5C0D\u65B9\u3002",
    "- \u53EA\u6709\u9700\u8981\u5C0D\u65B9\u505A\u4E8B\u6216\u56DE\u7B54\u6642\u624D @ \u5B83\uFF1B\u53EA\u662F\u63D0\u5230\u5B83\uFF0C\u76F4\u63A5\u5BEB\u540D\u7A31\uFF0C\u4E0D\u8981 @\u3002",
    "- \u5176\u4ED6 Bot \u5411\u4F60\u63D0\u554F\u6216\u4EA4\u8FA6\u4E8B\u60C5\u6642\uFF0C\u5728\u56DE\u7B54\u88E1 @ \u5B83\uFF0C\u5B83\u624D\u6536\u5F97\u5230\u3002\u4F60\u5411\u5225\u4EBA\u8981\u7684\u7B54\u6848\u62FF\u5230\u4E4B\u5F8C\uFF0C\u76F4\u63A5\u7167\u8457\u505A\uFF0C\u4E0D\u5FC5\u518D @ \u5C0D\u65B9\u3002",
    "- \u4E0D\u8981\u79AE\u8C8C\u6027\u5730\u4E92 @ \u9053\u8B1D\u3001\u78BA\u8A8D\u6536\u5230\u6216\u5BD2\u6684\uFF0C\u907F\u514D\u7121\u610F\u7FA9\u7684\u4F86\u56DE\u3002",
    "- \u4E00\u8F2A\u88E1\u53EA\u5728\u6700\u5F8C\u4E00\u5247 reply \u653E @\uFF0C\u4E0D\u8981\u6BCF\u5247\u90FD @\u3002",
    "- \u4EFB\u52D9\u5B8C\u6210\u5C31\u505C\uFF1A\u5B8C\u6210\u5831\u544A\u662F\u5BEB\u7D66\u4EBA\u770B\u7684\uFF0C\u4E0D\u8981 @ \u4EFB\u4F55 Bot\uFF08\u5305\u62EC\u63D0\u4F9B\u7B54\u6848\u7D66\u4F60\u7684 Bot\uFF09\u3002",
    "- \u88AB\u5176\u4ED6 Bot @ \u4F46\u6C92\u6709\u9700\u8981\u4F60\u505A\u7684\u4E8B\uFF08\u4F8B\u5982\u5C0D\u65B9\u53EA\u662F\u901A\u77E5\u5B8C\u6210\uFF09\u6642\uFF0C\u4E0D\u8981\u547C\u53EB reply\uFF0C\u9019\u4E00\u8F2A\u76F4\u63A5\u7D50\u675F\u3002"
  );
  return lines.join("\n");
}

// src/runner/launcher.ts
import { execFile, spawn } from "node:child_process";
function launcherOptions(launcher, onStderr, onSpawn) {
  const l = launcher.trim();
  if (/\.(cmd|bat)$/i.test(l)) {
    return { pathToClaudeCodeExecutable: l, spawnClaudeCodeProcess: (o) => track(spawnViaCmd(o), o, onStderr, onSpawn) };
  }
  const spawnClaudeCodeProcess = (o) => track(spawnDirect(o), o, onStderr, onSpawn);
  if (l === "" || l.toLowerCase() === "claude") return { spawnClaudeCodeProcess };
  return { pathToClaudeCodeExecutable: l, spawnClaudeCodeProcess };
}
function alive(child) {
  return !!child.pid && child.exitCode === null && child.signalCode === null;
}
function killTree(child) {
  if (!alive(child)) return Promise.resolve();
  return new Promise((resolve) => execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, () => resolve()));
}
function track(child, o, onStderr, onSpawn) {
  child.stderr.on("data", (d) => onStderr(d.toString("utf8")));
  o.signal.addEventListener("abort", () => void killTree(child));
  onSpawn(child);
  return child;
}
function spawnDirect(o) {
  return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}
var CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg) {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(CMD_META, "^$1");
  return a.replace(CMD_META, "^$1");
}
function spawnViaCmd(o) {
  const line = [o.command.replace(CMD_META, "^$1"), ...o.args.map(escapeCmdArg)].join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    cwd: o.cwd,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: true
  });
}

// src/runner/policy.ts
import path4 from "node:path";
var READ_ONLY = /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "LS", "LSP", "NotebookRead", "ToolSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "Skill"]);
var EDITS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var PATH_KEYS = ["file_path", "notebook_path", "path"];
function inside(file, roots) {
  const abs = path4.resolve(roots[0] ?? ".", file);
  return roots.some((r) => {
    const rel = path4.relative(path4.resolve(r), abs);
    return rel === "" || !rel.startsWith("..") && !path4.isAbsolute(rel);
  });
}
function targetPath(input) {
  for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k]) return input[k];
  return void 0;
}
function decideTool(name, input, ctx) {
  if (name === "AskUserQuestion") return { kind: "cli", why: "question" };
  if (name.startsWith(ctx.ownPrefix)) return { kind: "allow", why: "own tool" };
  if (ctx.mode === "auto") return { kind: "cli", why: "auto mode" };
  if (READ_ONLY.has(name)) {
    const p = targetPath(input);
    if (p && !inside(p, ctx.roots)) return { kind: "ask", why: "read outside cwd" };
    return { kind: "allow", why: "read-only" };
  }
  if (ctx.mode === "plan") return { kind: "deny", why: "plan mode" };
  if (ctx.alwaysAllowed.has(name)) return { kind: "allow", why: "always allowed this session" };
  if (ctx.mode === "acceptEdits" && EDITS.has(name)) {
    const p = targetPath(input);
    if (p && inside(p, ctx.roots)) return { kind: "allow", why: "acceptEdits inside cwd" };
  }
  if (ctx.mode === "dontAsk") return { kind: "deny", why: "dontAsk mode" };
  return { kind: "ask", why: "needs approval" };
}
function canAct(kind, clickerId, who) {
  if (who.ownerId && clickerId === who.ownerId) return true;
  if (kind === "permission") return false;
  return !!who.requesterId && clickerId === who.requesterId;
}

// src/runner/session.ts
var OWN_PREFIX = "mcp__channelcollab__";
var REPLY_TOOL = `${OWN_PREFIX}reply`;
var TURN_TIMEOUT_MS = 10 * 60 * 1e3;
var MAX_TURNS = 40;
var CLOSE_GRACE_MS = 15 * 1e3;
var MAX_REPLY_FILES = 10;
function guidelines(selfId) {
  let configured;
  try {
    configured = loadConfig().discord.owner_id;
  } catch {
  }
  return [
    "\u4F60\u6B63\u5728\u4E00\u500B Discord \u8A0E\u8AD6\u4E32\u88E1\u548C\u4EBA\u5354\u4F5C\uFF0C\u8A0E\u8AD6\u4E32\u88E1\u53EF\u80FD\u9084\u6709\u5176\u4ED6\u4EBA\u7684 Bot\u3002\u6BCF\u5247\u4F7F\u7528\u8005\u8A0A\u606F\u6703\u6A19\u793A\u767C\u8A71\u8005\u3001\u4F4D\u7F6E\u548C\u6700\u8FD1\u7684\u5C0D\u8A71\u3002",
    `- \u4F60\u7684\u4E00\u822C\u6587\u5B57\u8F38\u51FA\u6C92\u6709\u4EBA\u770B\u5F97\u5230\uFF1B\u8981\u8B93\u4EBA\u770B\u5230\u7684\u5167\u5BB9\uFF0C\u4E00\u5F8B\u547C\u53EB ${REPLY_TOOL} \u5DE5\u5177\u3002`,
    "- \u56DE\u8986\u8981\u7C21\u77ED\uFF0C\u53EA\u8B1B\u7D50\u8AD6\uFF1B\u505A\u4E86\u4FEE\u6539\u5C31\u8AAA\u660E\u6539\u4E86\u4EC0\u9EBC\u3002",
    "- \u9700\u8981\u6B0A\u9650\u7684\u5DE5\u5177\u6703\u5728 Discord \u4E0A\u8ACB Bot \u7684\u4E3B\u4EBA\u6838\u51C6\uFF0C\u7B49\u5F85\u671F\u9593\u4E0D\u5FC5\u53E6\u5916\u8AAA\u660E\u3002\u88AB\u62D2\u7D55\u6642\u7167\u62D2\u7D55\u7406\u7531\u8ABF\u6574\u505A\u6CD5\uFF0C\u4E0D\u8981\u539F\u6A23\u91CD\u8A66\u3002",
    "- \u9700\u8981\u4F7F\u7528\u8005\u505A\u9078\u64C7\u6642\uFF0C\u53EF\u4EE5\u7528 AskUserQuestion \u5DE5\u5177\uFF0C\u9078\u9805\u6703\u4EE5\u6309\u9215\u6216\u9078\u55AE\u5448\u73FE\u5728 Discord \u4E0A\u3002",
    "- \u6539\u7A0B\u5F0F\u6700\u591A\u505A\u5230\u958B PR\uFF0C\u7D55\u4E0D\u81EA\u884C merge\u3002",
    "- \u9700\u8981\u4E3B\u4EBA\u597D\u597D\u601D\u8003\u7684\u6C7A\u7B56\uFF08\u4F8B\u5982\u65B9\u5411\u3001\u53D6\u6368\u3001\u5F71\u97FF\u7BC4\u570D\u5927\u7684\u6539\u52D5\uFF09\uFF0C\u5728 reply \u88E1 @ \u4E3B\u4EBA\uFF0C\u8ACB\u4E3B\u4EBA\u6C7A\u5B9A\uFF0C\u4E0D\u8981\u81EA\u5DF1\u6C7A\u5B9A\u3002",
    "- \u4F7F\u7528\u8005\u9644\u7684\u6A94\u6848\u6703\u4E0B\u8F09\u5230\u672C\u6A5F\uFF0C\u8DEF\u5F91\u5BEB\u5728\u8A0A\u606F\u7684\u3010\u9644\u4EF6\u3011\u88E1\uFF0C\u7528 Read \u8B80\u53D6\u3002",
    `- \u8981\u628A\u6A94\u6848\u50B3\u5230\u8A0E\u8AD6\u4E32\uFF0C\u547C\u53EB ${REPLY_TOOL} \u6642\u5728 files \u5E36\u672C\u6A5F\u8DEF\u5F91\uFF08\u53EA\u80FD\u662F\u5DE5\u4F5C\u76EE\u9304\u6216\u9644\u4EF6\u8CC7\u6599\u593E\u5E95\u4E0B\u7684\u6A94\u6848\uFF09\u3002`,
    rosterPrompt(selfId, botOwner(configured, selfId))
  ].join("\n");
}
var SESSION_ENV = /* @__PURE__ */ new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION"
]);
function childEnv(source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (SESSION_ENV.has(k.toUpperCase()) || k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    env[k] = v;
  }
  return env;
}
function checkFiles(files, roots) {
  const ok = [];
  const rejected = [];
  const realRoots = roots.filter((r) => existsSync3(r)).map((r) => realpathSync(r));
  for (const f of files) {
    try {
      const real = realpathSync(path5.resolve(roots[0], f));
      if (!inside(real, realRoots)) rejected.push(`${f}: not under the working directory or the attachment folder`);
      else if (!statSync(real).isFile()) rejected.push(`${f}: not a file`);
      else ok.push(real);
    } catch {
      rejected.push(`${f}: not found`);
    }
  }
  if (ok.length > MAX_REPLY_FILES) rejected.push(...ok.splice(MAX_REPLY_FILES).map((f) => `${f}: at most ${MAX_REPLY_FILES} files per message`));
  return { ok, rejected };
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
var LiveSession = class {
  /**
   * `costBase` is the cumulative total a resumed CLI starts counting from: what
   * it saved on its last clean exit (0 when new). A CLI that was killed does not
   * save, so its later turns are not part of the base.
   */
  constructor(threadId, selfId, channel, resume, costBase, alwaysAllowed = []) {
    this.threadId = threadId;
    this.tag = `live ${threadId}`;
    this.sessionId = resume;
    this.cost = costBase;
    this.alwaysAllowed = new Set(alwaysAllowed);
    const roots = [channel.cwd, path5.join(INBOX_DIR, threadId)];
    const server = createSdkMcpServer({
      name: "channelcollab",
      version: "0.1.0",
      alwaysLoad: true,
      tools: [
        tool(
          "reply",
          "Send a message to the people in the current Discord thread. This is the only way anyone sees what you say. Optionally attach local files (under the working directory or the attachment folder).",
          {
            text: z.string().describe("Message text (Markdown)"),
            files: z.array(z.string()).optional().describe("Local file paths to upload with the message")
          },
          async ({ text, files }) => {
            const t = this.turn;
            const checked = checkFiles(files ?? [], roots);
            log("reply", `${threadId} ${brief(text, 300)}${files?.length ? ` files=${JSON.stringify(checked.ok)} rejected=${JSON.stringify(checked.rejected)}` : ""}`);
            if (!t) return { content: [{ type: "text", text: "Not delivered: no active turn." }], isError: true };
            try {
              await t.sendReply(text, checked.ok);
            } catch (e) {
              log("reply", `${threadId} send failed: ${e.message}`);
              return { content: [{ type: "text", text: `Not delivered: ${e.message}` }], isError: true };
            }
            t.replies++;
            const note = checked.rejected.length ? ` Not attached: ${checked.rejected.join("; ")}` : "";
            return { content: [{ type: "text", text: `Delivered${checked.ok.length ? ` with ${checked.ok.length} file(s)` : ""}.${note}` }] };
          }
        )
      ]
    });
    const preToolUse = async (hookInput, toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const name = hookInput.tool_name;
      const toolInput = hookInput.tool_input ?? {};
      const d = decideTool(name, toolInput, { mode: channel.permissionMode, roots, alwaysAllowed: this.alwaysAllowed, ownPrefix: OWN_PREFIX });
      if (d.kind === "cli") return {};
      if (d.kind === "allow") {
        if (!name.startsWith(OWN_PREFIX)) log("permission", `${threadId} auto-allow ${name} (${d.why}) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: d.why } };
      }
      if (d.kind === "deny") {
        this.turn?.denials.push(name);
        log("permission", `${threadId} deny ${name} (${d.why}) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `\u9019\u500B\u983B\u9053\u7684\u6B0A\u9650\u6A21\u5F0F\uFF08${channel.permissionMode}\uFF09\u4E0D\u5141\u8A31\u57F7\u884C ${name}\u3002` } };
      }
      const answer = await this.ask(name, toolInput, toolUseId ?? "", signal);
      return answer.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.message } } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "approved by the owner" } };
    };
    const canUseTool = async (toolName, input, { signal, toolUseID }) => {
      if (toolName !== "AskUserQuestion") {
        const answer = await this.ask(toolName, input, toolUseID, signal);
        return answer.behavior === "deny" ? { behavior: "deny", message: answer.message } : { behavior: "allow", updatedInput: input };
      }
      const t = this.turn;
      if (!t) return { behavior: "deny", message: "No active turn." };
      const questions = input.questions ?? [];
      log("question", `${threadId} ask ${questions.length} question(s) id=${toolUseID} ${brief(questions.map((q) => q.question))}`);
      const answers = await this.waitFor(() => t.askQuestion(questions, this.linked(signal, t)));
      if (!answers) {
        log("question", `${threadId} unanswered id=${toolUseID}`);
        return { behavior: "deny", message: t.stoppedBy ? "\u4F7F\u7528\u8005\u505C\u6B62\u4E86\u9019\u4E00\u8F2A\u3002" : "\u6C92\u6709\u4EBA\u5728\u6642\u9650\u5167\u56DE\u7B54\u9019\u500B\u554F\u984C\u3002" };
      }
      log("question", `${threadId} answered id=${toolUseID} ${brief(answers)}`);
      return { behavior: "allow", updatedInput: { ...input, answers } };
    };
    const onStderr = (d) => {
      this.stderrTail.push(d);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    };
    const onSpawn = (child) => {
      this.child = child;
      log(this.tag, `spawned pid=${child.pid}`);
    };
    log(this.tag, `start cwd=${channel.cwd} model=${channel.model ?? "-"} mode=${channel.permissionMode} launcher=${channel.launcher || "builtin"} resume=${resume ?? "-"} always=${JSON.stringify([...this.alwaysAllowed])}`);
    this.q = query({
      prompt: this.input(),
      options: {
        cwd: channel.cwd,
        ...launcherOptions(channel.launcher, onStderr, onSpawn),
        env: childEnv(),
        ...channel.model ? { model: channel.model } : {},
        ...channel.tools ? { tools: channel.tools } : {},
        settingSources: ["user", "project"],
        // Always explicit: omitted, the user's own default (e.g. auto) applies and canUseTool is skipped.
        permissionMode: channel.permissionMode,
        systemPrompt: { type: "preset", preset: "claude_code", append: guidelines(selfId) },
        allowedTools: [REPLY_TOOL],
        mcpServers: { channelcollab: server },
        // The hook awaits the owner's answer in-process, so its timeout (seconds) must outlast the prompt's.
        hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: Math.ceil(channel.permissionTimeoutMs / 1e3) + 60 }] },
        canUseTool,
        maxTurns: MAX_TURNS,
        abortController: this.abort,
        stderr: onStderr,
        ...resume ? { resume } : {}
      }
    });
    this.done = this.read();
  }
  threadId;
  sessionId;
  model;
  /** When the last turn ended (or the session started); drives idle close and eviction. */
  lastActivity = Date.now();
  /** Resolves when the reader loop has finished, i.e. the CLI has exited. */
  done;
  /** Tools the owner chose "always allow" for; seeded from the thread state so a resume keeps them. */
  alwaysAllowed;
  tag;
  q;
  abort = new AbortController();
  inbox = [];
  wake;
  inputEnded = false;
  exited = false;
  closing;
  turn;
  turns = 0;
  cost;
  failure;
  forced = false;
  clean = false;
  child;
  stderrTail = [];
  /** A turn is running. */
  get busy() {
    return !!this.turn;
  }
  /** Can take another turn: not closing and not exited. */
  get usable() {
    return !this.inputEnded && !this.exited;
  }
  get pid() {
    return this.child?.pid;
  }
  /** Cumulative total_cost_usd as of the last result. */
  get costTotal() {
    return this.cost;
  }
  /** The CLI exited on its own after stdin closed, so it saved its cost total for the next resume. */
  get cleanExit() {
    return this.clean;
  }
  /** Run one turn. Never rejects: failures come back as `ok: false`. One turn at a time. */
  run(prompt, callbacks) {
    if (this.turn) throw new Error(`${this.tag}: a turn is already running`);
    const n = ++this.turns;
    return new Promise((resolve) => {
      const t = {
        ...callbacks,
        n,
        started: Date.now(),
        acted: false,
        tools: [],
        denials: [],
        replies: 0,
        lastText: "",
        remainingMs: TURN_TIMEOUT_MS,
        timerStarted: 0,
        waits: 0,
        abort: new AbortController(),
        resolve
      };
      this.turn = t;
      this.startClock(t);
      if (!this.usable) {
        this.finishTurn(void 0, "session is closed");
        return;
      }
      log(this.tag, `turn ${n} push pid=${this.pid ?? "(starting)"} session=${this.sessionId ?? "-"} chars=${prompt.length}`);
      this.inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
      this.wake?.();
    });
  }
  /**
   * Stop the running turn (🛑) without ending the session: waiting prompts are
   * cancelled and the CLI is interrupted. The turn ends with subtype
   * `interrupted`, and the next message continues the same session
   * (spike/phase2-check.ts).
   */
  async interrupt(by) {
    const t = this.turn;
    if (!t || t.stoppedBy || !this.usable) return false;
    t.stoppedBy = by;
    log(this.tag, `turn ${t.n} interrupt by ${by} pid=${this.pid ?? "-"}`);
    t.abort.abort();
    try {
      const r = await this.q.interrupt();
      log(this.tag, `turn ${t.n} interrupt acknowledged ${brief(r)}`);
    } catch (e) {
      log(this.tag, `turn ${t.n} interrupt failed: ${e.message}`);
    }
    return true;
  }
  /**
   * End the session. Graceful by default: close stdin and let the CLI exit
   * (a running turn finishes first). `force` kills right away and fails the
   * running turn. Either way the process tree is gone when this resolves.
   */
  close(reason, force = false) {
    if (force && !this.exited) {
      log(this.tag, `close (${reason}) force pid=${this.pid ?? "-"} busy=${this.busy}`);
      this.failure ??= reason;
      this.forced = true;
      this.inputEnded = true;
      this.turn?.abort.abort();
      this.q.close();
    }
    this.closing ??= (async () => {
      if (!force) log(this.tag, `close (${reason}) pid=${this.pid ?? "-"} busy=${this.busy}`);
      this.inputEnded = true;
      this.wake?.();
      const limit = CLOSE_GRACE_MS + (this.busy ? TURN_TIMEOUT_MS : 0);
      const exited = await Promise.race([this.done.then(() => true), sleep(limit).then(() => false)]);
      if (!exited) {
        log(this.tag, `close (${reason}) still running after ${limit} ms, killing`);
        this.forced = true;
        this.turn?.abort.abort();
        this.q.close();
        await Promise.race([this.done, sleep(5e3)]);
      }
      if (this.child) await killTree(this.child);
      log(this.tag, `closed (${reason}) pid=${this.pid ?? "-"} turns=${this.turns}`);
    })();
    return this.closing;
  }
  /** Ask the owner about a tool call; the turn clock stops while waiting. */
  async ask(toolName, input, toolUseId, signal) {
    const t = this.turn;
    if (!t) return { behavior: "deny", message: "No active turn." };
    log("permission", `${this.threadId} ask ${toolName} id=${toolUseId} ${brief(input)}`);
    const answer = await this.waitFor(() => t.askPermission({ toolName, input, toolUseId, signal: this.linked(signal, t) }));
    log("permission", `${this.threadId} ${answer.behavior} ${toolName} id=${toolUseId}${answer.behavior === "deny" ? ` ${brief(answer.message, 200)}` : ""}`);
    if (answer.behavior === "deny") t.denials.push(toolName);
    if (answer.behavior === "always") this.alwaysAllowed.add(toolName);
    return answer;
  }
  /** One signal for "the SDK gave up on this call" or "the turn was stopped". */
  linked(signal, t) {
    return AbortSignal.any([signal, t.abort.signal]);
  }
  /** Wait for a person with the turn clock paused (prompts may run in parallel). */
  async waitFor(wait) {
    const t = this.turn;
    if (t && t.waits++ === 0) this.stopClock(t);
    try {
      return await wait();
    } finally {
      if (t && --t.waits === 0 && this.turn === t) this.startClock(t);
    }
  }
  startClock(t) {
    t.timerStarted = Date.now();
    t.timer = setTimeout(() => {
      log(this.tag, `turn ${t.n} timeout after ${TURN_TIMEOUT_MS} ms of work, killing the session`);
      this.failure = "timeout";
      this.forced = true;
      t.abort.abort();
      this.abort.abort();
    }, t.remainingMs);
  }
  stopClock(t) {
    clearTimeout(t.timer);
    t.remainingMs = Math.max(0, t.remainingMs - (Date.now() - t.timerStarted));
  }
  /** Streaming input: yields queued user messages; returning closes stdin and ends the session. */
  async *input() {
    for (; ; ) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.inputEnded) return;
      await new Promise((r) => this.wake = r);
      this.wake = void 0;
    }
  }
  async read() {
    const started = Date.now();
    let error;
    try {
      for await (const msg of this.q) this.onMessage(msg, started);
    } catch (e) {
      error = e.message;
      log(this.tag, `error ${error}`);
      if (this.stderrTail.length) log(this.tag, `stderr tail: ${this.stderrTail.join("").slice(-1500)}`);
    }
    this.exited = true;
    this.clean = !error && !this.forced;
    this.inputEnded = true;
    this.wake?.();
    log(this.tag, `ended pid=${this.pid ?? "-"} after ${Date.now() - started} ms turns=${this.turns} clean=${this.clean} cost_total=${this.cost.toFixed(4)}${error ? ` error=${brief(error, 200)}` : ""}`);
    if (this.turn) this.finishTurn(void 0, error ?? this.failure ?? "session ended unexpectedly");
  }
  onMessage(msg, started) {
    const t = this.turn;
    if (msg.type === "system" && msg.subtype === "init") {
      if (!this.model) {
        const cc = msg.mcp_servers.find((s) => s.name === "channelcollab");
        log(this.tag, `init after ${Date.now() - started} ms pid=${this.pid ?? "-"} session=${msg.session_id} model=${msg.model} mode=${msg.permissionMode} apiKeySource=${msg.apiKeySource} cc_version=${msg.claude_code_version} channelcollab=${cc?.status} replyListed=${msg.tools.includes(REPLY_TOOL)} skills=${msg.skills.length} plugins=${msg.plugins.length}`);
      }
      this.sessionId = msg.session_id;
      this.model = msg.model;
    } else if (msg.type === "assistant" && t) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          if (!t.acted) {
            t.acted = true;
            log(this.tag, `turn ${t.n} first action after ${Date.now() - t.started} ms pid=${this.pid ?? "-"}`);
          }
          t.tools.push({ name: block.name, input: brief(block.input, 160) });
          log("tool_use", `${this.threadId} ${block.name} ${brief(block.input)}`);
        } else if (block.type === "text" && block.text.trim()) {
          t.lastText = block.text;
        }
      }
    } else if (msg.type === "result") {
      this.finishTurn(msg);
    }
  }
  finishTurn(result, error) {
    const t = this.turn;
    if (!t) {
      if (result) log(this.tag, `result without a turn: ${result.subtype}`);
      return;
    }
    this.turn = void 0;
    clearTimeout(t.timer);
    t.abort.abort();
    this.lastActivity = Date.now();
    const costTotal = result ? result.total_cost_usd : this.cost;
    const turnCost = costTotal >= this.cost ? costTotal - this.cost : costTotal;
    this.cost = costTotal;
    if (result?.session_id) this.sessionId = result.session_id;
    const out = {
      ok: !!result && result.subtype === "success" && !result.is_error,
      // An interrupted turn ends as error_during_execution; report it as what it was.
      subtype: t.stoppedBy && result ? "interrupted" : result?.subtype ?? this.failure ?? "error",
      sessionId: this.sessionId,
      model: this.model,
      costTotal,
      turnCost,
      numTurns: result?.num_turns ?? 0,
      durationMs: Date.now() - t.started,
      tools: t.tools,
      replies: t.replies,
      lastText: result?.subtype === "success" && result.result.trim() ? result.result : t.lastText,
      denials: t.denials,
      stoppedBy: t.stoppedBy,
      error
    };
    log("result", `${this.threadId} turn=${t.n} pid=${this.pid ?? "-"} ok=${out.ok} subtype=${out.subtype} session=${out.sessionId} turns=${out.numTurns} replies=${out.replies} tools=${out.tools.length} denials=${JSON.stringify(out.denials)}${out.stoppedBy ? ` stopped_by=${out.stoppedBy}` : ""} turn_cost_usd=${turnCost.toFixed(4)} total_cost_usd=${costTotal.toFixed(4)} duration_ms=${out.durationMs}`);
    t.resolve(out);
  }
};

// src/runner/pool.ts
var SWEEP_MS = 15 * 1e3;
var live = /* @__PURE__ */ new Map();
var closing = /* @__PURE__ */ new Map();
var stopping = false;
var sweeper;
function limits() {
  const d = loadConfig().defaults;
  return { idleMs: d.idle_close_minutes * 60 * 1e3, max: d.max_live_sessions };
}
function idle(s) {
  return !s.busy && !isPending(s.threadId);
}
function retire(s, reason, force = false) {
  if (live.get(s.threadId) === s) live.delete(s.threadId);
  const p = s.close(reason, force).catch((e) => log("pool", `close ${s.threadId} failed: ${e.message}`));
  closing.set(s.threadId, p);
  void p.finally(() => {
    if (closing.get(s.threadId) === p) closing.delete(s.threadId);
  });
  return p;
}
async function acquire(threadId, selfId, channel, resume, costBase) {
  if (stopping) throw new Error("bot is shutting down");
  const current = live.get(threadId);
  if (current?.usable) return current;
  if (current) retire(current, "ended");
  await closing.get(threadId);
  if (stopping) throw new Error("bot is shutting down");
  const s = new LiveSession(threadId, selfId, channel, resume, costBase, getThread(threadId)?.alwaysAllow);
  live.set(threadId, s);
  void s.done.then(() => {
    const ts = getThread(threadId);
    if (ts && s.cleanExit) {
      ts.resumeCostBase = s.costTotal;
      saveState();
    }
    if (live.get(threadId) === s) {
      live.delete(threadId);
      log("pool", `${threadId} session exited, will resume on next trigger (live=${live.size})`);
    }
  });
  enforceLimit(threadId);
  sweeper ??= setInterval(sweep, SWEEP_MS);
  sweeper.unref();
  return s;
}
function enforceLimit(keep) {
  let max;
  try {
    max = limits().max;
  } catch (e) {
    log("pool", `limit check skipped: ${e.message}`);
    return;
  }
  const candidates = [...live.values()].filter((s) => s.threadId !== keep && idle(s)).sort((a, b) => a.lastActivity - b.lastActivity);
  while (live.size > max) {
    const s = candidates.shift();
    if (!s) {
      log("pool", `live=${live.size} exceeds max_live_sessions=${max}, but every other session is busy`);
      return;
    }
    log("pool", `live=${live.size} exceeds max_live_sessions=${max}, closing longest idle ${s.threadId} (idle ${Math.round((Date.now() - s.lastActivity) / 1e3)} s)`);
    retire(s, "evicted");
  }
}
function sweep() {
  let idleMs;
  try {
    idleMs = limits().idleMs;
  } catch (e) {
    log("pool", `idle check skipped: ${e.message}`);
    return;
  }
  const now = Date.now();
  for (const s of live.values()) {
    if (idle(s) && now - s.lastActivity >= idleMs) {
      log("pool", `${s.threadId} idle ${Math.round((now - s.lastActivity) / 1e3)} s >= ${idleMs / 1e3} s`);
      retire(s, "idle");
    }
  }
}
async function closeAll() {
  stopping = true;
  if (sweeper) clearInterval(sweeper);
  const sessions = [...live.values()];
  log("pool", `closing ${sessions.length} live session(s)`);
  await Promise.all([...sessions.map((s) => retire(s, "shutdown", s.busy)), ...closing.values()]);
}

// src/discord/attachments.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import path6 from "node:path";
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function safeName(name) {
  const base = path6.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_");
  return base.slice(-120) || "file";
}
async function saveAttachments(message, threadId) {
  const saved = /* @__PURE__ */ new Map();
  if (!message.attachments.size) return saved;
  const dir = path6.join(INBOX_DIR, threadId);
  mkdirSync2(dir, { recursive: true });
  for (const a of message.attachments.values()) {
    if (a.size > MAX_ATTACHMENT_BYTES) {
      saved.set(a.id, { note: `\u8D85\u904E ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB \u4E0A\u9650\uFF0C\u6C92\u6709\u4E0B\u8F09` });
      log("attach", `${message.id} skip ${a.name} size=${a.size}`);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error("too large");
      const file = path6.join(dir, `${message.id}-${safeName(a.name)}`);
      writeFileSync2(file, buf);
      saved.set(a.id, { path: file });
      log("attach", `${message.id} saved ${a.name} bytes=${buf.length} -> ${file}`);
    } catch (e) {
      saved.set(a.id, { note: `\u4E0B\u8F09\u5931\u6557\uFF08${e.message}\uFF09` });
      log("attach", `${message.id} download ${a.name} failed: ${e.message}`);
    }
  }
  return saved;
}

// src/discord/details.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} from "discord.js";
var PREFIX = "detail:";
var MAX_KEPT = 200;
var details = /* @__PURE__ */ new Map();
var seq = 0;
function rememberTurn(threadId, turn) {
  const id = `${PREFIX}${threadId}:${++seq}`;
  details.set(id, turn);
  if (details.size > MAX_KEPT) details.delete(details.keys().next().value);
  return id;
}
function detailsButton(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("\u8A73\u7D30").setEmoji("\u{1F4C4}").setStyle(ButtonStyle.Secondary)
  );
}
async function attachDetails(message, customId) {
  await message.edit({ components: [detailsButton(customId)] });
}
function isDetailsButton(customId) {
  return customId.startsWith(PREFIX);
}
function format(t) {
  const lines = [
    `**\u9019\u4E00\u8F2A**\uFF1A${t.ok ? "\u2705 \u5B8C\u6210" : t.stoppedBy ? "\u23F9\uFE0F \u5DF2\u505C\u6B62" : `\u274C ${t.subtype}`}\u3000\u6A21\u578B ${t.model ?? "-"}\u3000${t.numTurns} \u6B65\u3000${(t.durationMs / 1e3).toFixed(1)} \u79D2`,
    `**\u8CBB\u7528**\uFF1A\u672C\u8F2A $${t.turnCost.toFixed(4)}\uFF08session \u7D2F\u8A08 $${t.costTotal.toFixed(4)}\uFF09`,
    `**Session**\uFF1A\`${t.sessionId ?? "-"}\``
  ];
  if (t.stoppedBy) lines.push(`**\u505C\u6B62**\uFF1A\u7531 ${t.stoppedBy} \u6309 \u{1F6D1} \u505C\u6B62`);
  if (t.denials.length) lines.push(`**\u88AB\u62D2\u7D55\u7684\u5DE5\u5177**\uFF1A${t.denials.join(", ")}`);
  if (t.error) lines.push(`**\u932F\u8AA4**\uFF1A${t.error.slice(0, 200)}`);
  lines.push(`**\u5DE5\u5177\u52D5\u4F5C**\uFF08${t.tools.length}\uFF09\uFF1A`);
  for (const [i, u] of t.tools.entries()) lines.push(`${i + 1}. \`${u.name}\` ${u.input.replace(/`/g, "'")}`);
  let text = lines.join("\n");
  if (text.length > 1900) text = `${text.slice(0, 1900)}
\u2026\uFF08\u5DF2\u622A\u65B7\uFF09`;
  return text;
}
async function handleDetailsClick(i) {
  const t = details.get(i.customId);
  const content = t ? format(t) : "\u627E\u4E0D\u5230\u9019\u4E00\u8F2A\u7684\u7D00\u9304\uFF08Bot \u53EF\u80FD\u91CD\u555F\u904E\uFF09\u3002";
  await i.reply({ content, flags: MessageFlags.Ephemeral });
}

// src/discord/prompt.ts
function speaker(m, roster) {
  const name = m.member?.displayName ?? m.author.displayName;
  const r = m.author.bot ? roster.find((b) => b.botId === m.author.id) : void 0;
  const tags = [m.author.username, m.author.bot ? "Bot" : "", r ? `${r.ownerName} \u7684${roleName(r.role)}\uFF0CID ${r.botId}` : ""];
  return `${name}\uFF08${tags.filter(Boolean).join("\uFF0C")}\uFF09`;
}
function body(m, saved) {
  const files = [...m.attachments.values()].map((a) => {
    const s = saved?.get(a.id);
    if (s?.path) return `[\u9644\u4EF6] ${a.name}\uFF08${a.contentType ?? "\u672A\u77E5\u985E\u578B"}\uFF0C${a.size} bytes\uFF09\u672C\u6A5F\u8DEF\u5F91\uFF1A${s.path}`;
    return `[\u9644\u4EF6] ${a.name} ${a.url}${s?.note ? `\uFF08${s.note}\uFF09` : ""}`;
  });
  return [m.cleanContent, ...files].filter(Boolean).join("\n") || "\uFF08\u7A7A\u767D\u8A0A\u606F\uFF09";
}
async function recent(thread, trigger, limit, afterId) {
  if (limit <= 0) return [];
  const fetched = await thread.messages.fetch({ limit, before: trigger.id });
  const me = trigger.client.user.id;
  return [...fetched.values()].filter((m) => !m.system).filter((m) => !afterId || BigInt(m.id) > BigInt(afterId) && m.author.id !== me).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}
async function buildPrompt(opts) {
  const { thread, trigger } = opts;
  const history = await recent(thread, trigger, opts.history, opts.afterId);
  const roster = loadRoster();
  const parent = thread.parent?.name ?? thread.parentId;
  const parts = [
    `\u3010\u767C\u8A71\u8005\u3011${speaker(trigger, roster)}`,
    `\u3010\u4F4D\u7F6E\u3011\u983B\u9053 #${parent}\uFF0C\u8A0E\u8AD6\u4E32\u300C${thread.name}\u300D\uFF08ID ${thread.id}\uFF09`
  ];
  if (history.length) {
    parts.push(`\u3010\u6700\u8FD1\u8A0A\u606F\u3011\uFF08\u820A\u5230\u65B0\uFF0C${history.length} \u5247\uFF09`);
    for (const m of history) parts.push(`- ${speaker(m, roster)}\uFF1A${body(m).replace(/\n/g, "\n  ")}`);
  }
  parts.push("\u3010\u672C\u5247\u8A0A\u606F\u3011", body(trigger, opts.attachments));
  return parts.join("\n");
}

// src/discord/prompts.ts
import {
  ActionRowBuilder as ActionRowBuilder2,
  ButtonBuilder as ButtonBuilder2,
  ButtonStyle as ButtonStyle2,
  MessageFlags as MessageFlags2,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
var OTHER = "__other";
var OTHER_LABEL = "\u5176\u4ED6\u2026\uFF08\u81EA\u884C\u8F38\u5165\uFF09";
var MAX_CONTENT = 1900;
var pending2 = /* @__PURE__ */ new Map();
var seq2 = 0;
var newId = () => `${Date.now().toString(36)}${(++seq2).toString(36)}`;
var fence = (s, lang = "") => `\`\`\`${lang}
${s.replace(/```/g, "'''")}
\`\`\``;
var clip = (s, max) => s.length > max ? `${s.slice(0, max)}\u2026` : s;
function clipLines(s, maxLines, maxChars) {
  const lines = s.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  const more = lines.length > maxLines ? `
\u2026\uFF08\u9084\u6709 ${lines.length - maxLines} \u884C\uFF09` : "";
  return clip(head, maxChars) + more;
}
function summarizeTool(name, input) {
  const str = (k) => typeof input[k] === "string" ? input[k] : "";
  if (name === "Bash" || name === "PowerShell") {
    const desc = str("description");
    return `${desc ? `${clip(desc, 200)}
` : ""}${fence(clipLines(str("command"), 20, 900), name === "Bash" ? "sh" : "powershell")}`;
  }
  if (name === "Edit" || name === "MultiEdit") {
    const edits = name === "Edit" ? [{ old_string: str("old_string"), new_string: str("new_string") }] : input.edits ?? [];
    const diff = edits.slice(0, 3).map((e) => [...clipLines(e.old_string, 8, 400).split("\n").map((l) => `- ${l}`), ...clipLines(e.new_string, 8, 400).split("\n").map((l) => `+ ${l}`)].join("\n")).join("\n\u2026\n");
    return `\`${str("file_path")}\`${edits.length > 3 ? `\uFF08\u5171 ${edits.length} \u8655\uFF0C\u53EA\u5217\u524D 3 \u8655\uFF09` : ""}
${fence(diff, "diff")}`;
  }
  if (name === "Write") {
    const content = str("content");
    return `\`${str("file_path")}\`\uFF08${content.split("\n").length} \u884C\uFF09
${fence(clipLines(content, 10, 600))}`;
  }
  const p = str("file_path") || str("notebook_path") || str("path");
  if (p) return `\`${p}\``;
  if (name === "WebFetch") return `${str("url")}`;
  return fence(brief(input, 600));
}
function rows(...builders) {
  return builders.map((b) => new ActionRowBuilder2().addComponents(...b));
}
async function edit(p, extra, keepComponents = false) {
  const content = clip(`${p.base}
${extra}`, MAX_CONTENT);
  await p.message?.edit({ content, ...keepComponents ? {} : { components: [] }, allowedMentions: { parse: [] } }).catch((e) => log("prompt", `edit failed: ${e.message}`));
}
function settleOnce(id, entry, timeoutMs, signal, onTimeout, onAbort) {
  pending2.set(id, entry);
  let finish;
  const result = new Promise((r) => finish = r);
  let settled = false;
  const timer = setTimeout(() => settle(onTimeout()), timeoutMs);
  const abort = () => settle(onAbort());
  signal.addEventListener("abort", abort, { once: true });
  function settle(v) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    pending2.delete(id);
    finish(v);
  }
  if (signal.aborted) abort();
  return { result, settle };
}
var minutes = (ms) => ms < 6e4 ? `${Math.round(ms / 1e3)} \u79D2` : `${Math.round(ms / 6e4)} \u5206\u9418`;
async function askPermission(thread, req, who, timeoutMs) {
  const id = newId();
  if (!who.ownerId) {
    await thread.send({ content: `\u{1F510} Claude \u60F3\u57F7\u884C \`${req.toolName}\`\uFF0C\u4F46\u9019\u500B Bot \u6C92\u6709\u8A2D\u5B9A\u4E3B\u4EBA\uFF08config \u7684 \`discord.owner_id\`\uFF09\uFF0C\u7121\u6CD5\u6838\u51C6\uFF0C\u5DF2\u62D2\u7D55\u3002`, allowedMentions: { parse: [] } });
    return { behavior: "deny", message: "\u9019\u500B Bot \u6C92\u6709\u8A2D\u5B9A\u4E3B\u4EBA\uFF0C\u6C92\u6709\u4EBA\u80FD\u6838\u51C6\u6B0A\u9650\u8ACB\u6C42\uFF0C\u5DF2\u62D2\u7D55\u3002" };
  }
  const base = `\u{1F510} **\u6B0A\u9650\u8ACB\u6C42** \`${req.toolName}\`\u3000<@${who.ownerId}> \u8ACB\u78BA\u8A8D\uFF08${minutes(timeoutMs)}\u5167\u6C92\u6709\u56DE\u61C9\u6703\u81EA\u52D5\u62D2\u7D55\uFF09
${summarizeTool(req.toolName, req.input)}`;
  const p = { kind: "permission", who, base: clip(base, MAX_CONTENT - 200), toolName: req.toolName, done: () => {
  } };
  const s = settleOnce(
    id,
    p,
    timeoutMs,
    req.signal,
    () => ({ a: { behavior: "deny", message: `\u7B49\u5F85\u4E3B\u4EBA\u6838\u51C6\u903E\u6642\uFF08${minutes(timeoutMs)}\uFF09\uFF0C\u5DF2\u81EA\u52D5\u62D2\u7D55\u3002` }, note: `\u231B \u903E\u6642\uFF08${minutes(timeoutMs)}\uFF09\uFF0C\u5DF2\u81EA\u52D5\u62D2\u7D55` }),
    () => ({ a: { behavior: "deny", message: "\u9019\u4E00\u8F2A\u5DF2\u505C\u6B62\uFF0C\u8ACB\u6C42\u5DF2\u53D6\u6D88\u3002" }, note: "\u23F9\uFE0F \u9019\u4E00\u8F2A\u5DF2\u505C\u6B62\uFF0C\u8ACB\u6C42\u5DF2\u53D6\u6D88" })
  );
  p.done = (a2, note2) => s.settle({ a: a2, note: note2 });
  p.message = await thread.send({
    content: p.base,
    components: rows([
      new ButtonBuilder2().setCustomId(`perm:${id}:allow`).setLabel("\u5141\u8A31").setStyle(ButtonStyle2.Success),
      new ButtonBuilder2().setCustomId(`perm:${id}:always`).setLabel(clip(`\u9019\u500B session \u4E00\u5F8B\u5141\u8A31 ${req.toolName}`, 80)).setStyle(ButtonStyle2.Primary),
      new ButtonBuilder2().setCustomId(`perm:${id}:deny`).setLabel("\u62D2\u7D55").setStyle(ButtonStyle2.Danger)
    ]),
    allowedMentions: { users: [who.ownerId] }
  });
  log("prompt", `permission ${id} posted ${req.toolName} tool_use=${req.toolUseId} message=${p.message.id}`);
  const { a, note } = await s.result;
  log("prompt", `permission ${id} ${a.behavior} ${req.toolName} tool_use=${req.toolUseId} (${note})`);
  await edit(p, note);
  return a;
}
function questionText(q) {
  const parts = q.questions.map((x, i) => {
    const opts = x.options.map((o, j) => `\u3000${j + 1}. **${o.label}**${o.description ? ` \u2014 ${o.description}` : ""}`).join("\n");
    const answer = q.answers[i] !== void 0 ? `
\u3000\u2192 **${q.answers[i]}**` : "";
    return `**${x.header || `\u554F\u984C ${i + 1}`}**${x.multiSelect ? "\uFF08\u53EF\u8907\u9078\uFF09" : ""}\uFF1A${x.question}
${opts}${answer}`;
  });
  return parts.join("\n\n");
}
function questionMenus(id, q) {
  return q.questions.map(
    (x, i) => new ActionRowBuilder2().addComponents(
      new StringSelectMenuBuilder().setCustomId(`ask:${id}:${i}`).setPlaceholder(clip(q.answers[i] !== void 0 ? `\u5DF2\u9078\uFF1A${q.answers[i]}` : `${x.header || `\u554F\u984C ${i + 1}`}\uFF1A\u8ACB\u9078\u64C7`, 150)).setMinValues(1).setMaxValues(x.multiSelect ? x.options.length + 1 : 1).addOptions(
        ...x.options.map((o, j) => ({ label: clip(o.label, 100), value: String(j), ...o.description ? { description: clip(o.description, 100) } : {} })),
        { label: OTHER_LABEL, value: OTHER }
      )
    )
  );
}
async function askQuestion(thread, questions, who, timeoutMs, signal) {
  const id = newId();
  const q = { kind: "question", who, base: "", questions: questions.slice(0, 5), answers: [], done: () => {
  } };
  const header = () => `\u2753 **Claude \u60F3\u554F**\uFF08${[who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`).join(" \u6216 ")} \u56DE\u7B54\uFF1B${minutes(timeoutMs)}\u5167\u6C92\u6709\u56DE\u61C9\u5C31\u7565\u904E\uFF09`;
  q.base = clip(`${header()}

${questionText(q)}`, MAX_CONTENT - 100);
  const s = settleOnce(
    id,
    q,
    timeoutMs,
    signal,
    () => ({ note: `\u231B \u903E\u6642\uFF08${minutes(timeoutMs)}\uFF09\uFF0C\u6C92\u6709\u56DE\u7B54` }),
    () => ({ note: "\u23F9\uFE0F \u5DF2\u53D6\u6D88" })
  );
  q.done = (answers2, note2) => s.settle({ answers: answers2, note: note2 });
  q.message = await thread.send({ content: q.base, components: questionMenus(id, q), allowedMentions: { users: who.requesterId ? [who.requesterId] : [] } });
  log("prompt", `question ${id} posted ${questions.length} question(s) message=${q.message.id}`);
  const { answers, note } = await s.result;
  log("prompt", `question ${id} ${answers ? `answered ${brief(answers)}` : note}`);
  q.base = clip(`${header()}

${questionText(q)}`, MAX_CONTENT - 100);
  await edit(q, note);
  return answers;
}
async function answerQuestion(i, id, q, index, answer) {
  q.answers[index] = answer;
  const complete = q.questions.every((_, j) => q.answers[j] !== void 0);
  const content = clip(`${q.base.split("\n\n")[0]}

${questionText(q)}`, MAX_CONTENT);
  const by = `\u2705 \u7531 <@${i.user.id}> \u56DE\u7B54`;
  if (i.isStringSelectMenu() || i.isFromMessage()) await i.update({ content: complete ? `${content}
${by}` : content, components: complete ? [] : questionMenus(id, q), allowedMentions: { parse: [] } });
  else await i.reply({ content: "\u5DF2\u8A18\u9304\u3002", flags: MessageFlags2.Ephemeral });
  if (complete) {
    const answers = Object.fromEntries(q.questions.map((x, j) => [x.question, q.answers[j]]));
    q.base = content;
    q.message = void 0;
    q.done(answers, by);
  }
}
function stopControl(thread, who, delayMs, stop) {
  const id = newId();
  const p = { kind: "stop", who, base: "\u2699\uFE0F \u8655\u7406\u4E2D\u2026", stop };
  let posting;
  const timer = setTimeout(() => {
    pending2.set(id, p);
    posting = thread.send({
      content: `${p.base}\uFF08\u4E3B\u4EBA\u6216\u63D0\u51FA\u9700\u6C42\u7684\u4EBA\u53EF\u4EE5\u6309 \u{1F6D1} \u505C\u6B62\uFF09`,
      components: rows([new ButtonBuilder2().setCustomId(`stop:${id}`).setLabel("\u505C\u6B62").setEmoji("\u{1F6D1}").setStyle(ButtonStyle2.Danger)]),
      allowedMentions: { parse: [] }
    }).then((m) => p.message = m).catch((e) => {
      log("prompt", `stop control failed: ${e.message}`);
      return void 0;
    });
  }, delayMs);
  return {
    /** Turn over: no more stopping. Resolves to the progress message, if one was posted. */
    async end() {
      clearTimeout(timer);
      pending2.delete(id);
      return posting ? await posting : void 0;
    }
  };
}
function denyText(kind, who) {
  if (kind === "permission") return "\u53EA\u6709 Bot \u64C1\u6709\u8005\u53EF\u4EE5\u6838\u51C6\u3002";
  const names = [who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
  return `\u53EA\u6709 ${names.join(" \u6216 ")} \u53EF\u4EE5${kind === "stop" ? "\u505C\u6B62\u9019\u4E00\u8F2A" : "\u56DE\u7B54"}\u3002`;
}
async function lookup(i, id) {
  const p = pending2.get(id);
  if (!p) {
    await i.reply({ content: "\u9019\u500B\u8ACB\u6C42\u5DF2\u7D93\u8655\u7406\u904E\uFF0C\u6216\u5DF2\u5931\u6548\uFF08\u4F8B\u5982 Bot \u91CD\u555F\u904E\uFF09\u3002", flags: MessageFlags2.Ephemeral });
    return void 0;
  }
  if (!canAct(p.kind, i.user.id, p.who)) {
    log("prompt", `${p.kind} ${id} refused ${i.user.username} (${i.user.id})`);
    await i.reply({ content: denyText(p.kind, p.who), flags: MessageFlags2.Ephemeral, allowedMentions: { parse: [] } });
    return void 0;
  }
  return p;
}
function isPromptInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
  return /^(perm|permdeny|ask|askother|stop):/.test(i.customId);
}
async function handlePromptInteraction(i) {
  if (i.isButton() && i.customId.startsWith("perm:")) {
    const [, id, action] = i.customId.split(":");
    const p = await lookup(i, id);
    if (!p || p.kind !== "permission") return;
    log("prompt", `permission ${id} ${action} clicked by ${i.user.username}`);
    if (action === "deny") {
      await i.showModal(
        new ModalBuilder().setCustomId(`permdeny:${id}`).setTitle(clip(`\u62D2\u7D55 ${p.toolName}`, 45)).addComponents(
          new ActionRowBuilder2().addComponents(
            new TextInputBuilder().setCustomId("reason").setLabel("\u62D2\u7D55\u7406\u7531\uFF08\u9078\u586B\uFF0C\u6703\u8F49\u544A Claude\uFF09").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1e3)
          )
        )
      );
      return;
    }
    const note = action === "always" ? `\u2705 <@${i.user.id}> \u5DF2\u5141\u8A31\uFF0C\u9019\u500B session \u4E4B\u5F8C\u7684 \`${p.toolName}\` \u4E0D\u518D\u8A62\u554F` : `\u2705 <@${i.user.id}> \u5DF2\u5141\u8A31`;
    await i.update({ content: clip(`${p.base}
${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
    p.message = void 0;
    p.done({ behavior: action === "always" ? "always" : "allow" }, note);
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("permdeny:")) {
    const id = i.customId.split(":")[1];
    const p = await lookup(i, id);
    if (!p || p.kind !== "permission") return;
    const reason = i.fields.getTextInputValue("reason").trim();
    const note = `\u{1F6AB} <@${i.user.id}> \u5DF2\u62D2\u7D55${reason ? `\uFF1A${clip(reason, 300)}` : ""}`;
    if (i.isFromMessage()) {
      await i.update({ content: clip(`${p.base}
${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
      p.message = void 0;
    } else await i.deferUpdate();
    log("prompt", `permission ${id} denied by ${i.user.username} reason=${brief(reason, 200)}`);
    p.done({ behavior: "deny", message: reason ? `\u4E3B\u4EBA\u62D2\u7D55\u4E86\u9019\u6B21\u7684 ${p.toolName}\uFF0C\u7406\u7531\uFF1A${reason}` : `\u4E3B\u4EBA\u62D2\u7D55\u4E86\u9019\u6B21\u7684 ${p.toolName}\uFF08\u6C92\u6709\u8AAA\u660E\u7406\u7531\uFF09\u3002` }, note);
    return;
  }
  if (i.isStringSelectMenu() && i.customId.startsWith("ask:")) {
    const [, id, idx] = i.customId.split(":");
    const p = await lookup(i, id);
    if (!p || p.kind !== "question") return;
    const index = Number(idx);
    const x = p.questions[index];
    const picked = i.values.filter((v) => v !== OTHER).map((v) => x.options[Number(v)]?.label ?? v);
    log("prompt", `question ${id} q${index} picked ${JSON.stringify(i.values)} by ${i.user.username}`);
    if (i.values.includes(OTHER)) {
      await i.showModal(
        new ModalBuilder().setCustomId(`askother:${id}:${index}:${i.values.filter((v) => v !== OTHER).join(",")}`).setTitle(clip(x.header || "\u5176\u4ED6", 45)).addComponents(
          new ActionRowBuilder2().addComponents(
            new TextInputBuilder().setCustomId("answer").setLabel(clip(x.question, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1e3)
          )
        )
      );
      return;
    }
    await answerQuestion(i, id, p, index, picked.join(", "));
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("askother:")) {
    const [, id, idx, chosen] = i.customId.split(":");
    const p = await lookup(i, id);
    if (!p || p.kind !== "question") return;
    const index = Number(idx);
    const x = p.questions[index];
    const picked = (chosen ? chosen.split(",") : []).map((v) => x.options[Number(v)]?.label ?? v);
    const text = i.fields.getTextInputValue("answer").trim();
    log("prompt", `question ${id} q${index} other=${brief(text, 200)} by ${i.user.username}`);
    await answerQuestion(i, id, p, index, [...picked, text].filter(Boolean).join(", "));
    return;
  }
  if (i.isButton() && i.customId.startsWith("stop:")) {
    const id = i.customId.split(":")[1];
    const p = await lookup(i, id);
    if (!p || p.kind !== "stop") return;
    log("prompt", `stop ${id} clicked by ${i.user.username}`);
    pending2.delete(id);
    await i.update({ content: `\u23F9\uFE0F <@${i.user.id}> \u6309\u4E86\u505C\u6B62\uFF0C\u6B63\u5728\u505C\u6B62\u2026`, components: [], allowedMentions: { parse: [] } });
    p.stop(i.user.displayName || i.user.username);
  }
}

// src/discord/status.ts
var STATUS = {
  received: "\u{1F440}",
  waiting: "\u23F3",
  running: "\u2699\uFE0F",
  done: "\u2705",
  failed: "\u274C",
  stopped: "\u23F9\uFE0F"
};
var StatusReactions = class {
  constructor(message) {
    this.message = message;
  }
  message;
  current;
  /** Swap the bot's own status reaction. Failures (e.g. missing Add Reactions) are logged, never thrown. */
  async set(status) {
    const emoji = STATUS[status];
    if (emoji === this.current) return;
    const previous = this.current;
    this.current = emoji;
    try {
      await this.message.react(emoji);
      if (previous) {
        const me = this.message.client.user.id;
        await this.message.reactions.cache.find((r) => r.emoji.name === previous)?.users.remove(me);
      }
    } catch (e) {
      log("status", `${this.message.id} ${status} failed: ${e.message}`);
    }
  }
};

// src/discord/bot.ts
var DISCORD_LIMIT = 2e3;
var FALLBACK_MAX = 500;
var STOP_BUTTON_DELAY_MS = 5e3;
function splitMessage(text) {
  const out = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf("\n", DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}
function threadName(message) {
  const text = message.content.replace(/<@[!&]?\d+>/g, "").replace(/\s+/g, " ").trim();
  return (text || "Claude \u4EFB\u52D9").slice(0, 60);
}
function mentionsBot(message, exceptId) {
  return message.mentions.users.some((u) => u.bot && u.id !== exceptId);
}
async function openThread(message) {
  try {
    return await message.startThread({ name: threadName(message), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
  } catch (e) {
    const opened = message.channel.isTextBased() && "threads" in message.channel ? await message.channel.threads.fetch(message.id).catch(() => null) : null;
    if (!opened) throw e;
    return opened;
  }
}
var HOP_SCAN_PAGES = 5;
async function threadHops(thread, trigger, maxHops) {
  const toHop = (m) => ({ isSystem: m.system, fromBot: m.author.bot, mentionsBot: mentionsBot(m, m.author.id), authorId: m.author.id });
  const list = [toHop(trigger)];
  let before = trigger.id;
  for (let page = 0; ; page++) {
    const r = countHops(list);
    if (r.human || r.hops > maxHops || page === HOP_SCAN_PAGES) return { hops: r.hops, humanId: r.human?.authorId ?? await starterHuman(thread) };
    const batch = [...(await thread.messages.fetch({ limit: 100, before })).values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
    if (!batch.length) return { hops: r.hops, humanId: await starterHuman(thread) };
    list.push(...batch.map(toHop));
    before = batch.at(-1).id;
  }
}
async function starterHuman(thread) {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  return starter && !starter.author.bot ? starter.author.id : void 0;
}
function createBot() {
  const client2 = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  client2.on(Events.MessageCreate, (message) => {
    onMessage(message).catch((e) => log("error", `message ${message.id}: ${e.stack ?? e}`));
  });
  client2.once(Events.ClientReady, (c) => {
    let configured;
    try {
      configured = loadConfig().discord.owner_id;
    } catch {
    }
    const owner = botOwner(configured, c.user.id);
    log("owner", owner ? `${owner} (${configured ? "discord.owner_id" : "roster"})` : "none: set discord.owner_id, or permission requests are denied");
    log("roster", `${loadRoster().length} bots from ${ROSTER_PATH}`);
  });
  client2.on(Events.InteractionCreate, (i) => {
    if (i.isButton() && isDetailsButton(i.customId)) {
      log("details", `${i.customId} clicked by ${i.user.username}`);
      handleDetailsClick(i).catch((e) => log("error", `details ${i.customId}: ${e.message}`));
    } else if (isPromptInteraction(i)) {
      handlePromptInteraction(i).catch((e) => log("error", `prompt interaction: ${e.stack ?? e}`));
    }
  });
  return client2;
}
async function onMessage(message) {
  if (!message.inGuild()) return;
  const me = message.client.user.id;
  if (message.author.id === me) return;
  let config2;
  let channel;
  const ch = message.channel;
  const inThread = ch.isThread();
  const baseChannelId = inThread ? ch.parentId ?? "" : ch.id;
  try {
    config2 = loadConfig();
    channel = resolveChannel(config2, baseChannelId);
  } catch (e) {
    log("config", e.message);
    return;
  }
  if (config2.discord.guild_id && message.guildId !== config2.discord.guild_id) return;
  const fromBot = message.author.bot;
  const mentionsMe = message.mentions.users.has(me);
  let ownerId = null;
  if (inThread && channel) ownerId = ch.ownerId ?? (await ch.fetch().catch(() => ch)).ownerId;
  const decision = decide({
    fromSelf: false,
    isSystem: message.system,
    fromBot,
    mentionsMe,
    mentionsOtherBot: mentionsBot(message, me),
    inThread,
    baseChannelId,
    baseChannelBound: !!channel,
    openedByMe: ownerId === me
  });
  const mentions = [...message.mentions.users.keys()].join(",");
  if (decision.action === "ignore") {
    if (decision.reason !== "unbound-channel") log("ignore", `${message.id} ${decision.reason} channel=${ch.id} owner=${ownerId ?? "-"} author=${message.author.username} mentions=[${mentions}] text=${brief(message.content, 80)}`);
    return;
  }
  if (!channel) return;
  let thread;
  if (decision.action === "open-thread") {
    if (ch.type !== ChannelType.GuildText) {
      log("ignore", `${message.id} unsupported-channel-type type=${ch.type}`);
      return;
    }
    const existing = message.thread;
    thread = existing ?? await openThread(message);
    ownerId = thread.ownerId;
    log("thread", `${ownerId === me ? "opened" : "joined"} ${thread.id} "${thread.name}" from message ${message.id} owner=${ownerId ?? "-"}`);
  } else {
    thread = ch;
  }
  if (!getThread(thread.id)) {
    registerThread(thread.id, baseChannelId);
    if (ownerId !== me) log("thread", `adopted ${thread.id} "${thread.name}" owner=${ownerId ?? "-"}`);
  }
  const hop = fromBot && decision.action === "run" ? await threadHops(thread, message, channel.maxHops) : { hops: 0 };
  if (hop.hops > channel.maxHops) {
    log("ignore", `${message.id} max-hops hops=${hop.hops} max=${channel.maxHops} thread=${thread.id} author=${message.author.username}`);
    const human = hop.humanId ? `<@${hop.humanId}> ` : "";
    await thread.send({
      content: `${human}Bot \u4E4B\u9593\u5DF2\u9023\u7E8C\u8F49\u624B ${hop.hops - 1} \u6B21\uFF0C\u9054\u5230\u4E0A\u9650 ${channel.maxHops}\uFF0C\u9019\u5247\u4E0D\u518D\u8655\u7406\uFF0C\u8ACB\u4EBA\u985E\u63A5\u624B\u3002`,
      allowedMentions: { users: hop.humanId ? [hop.humanId] : [] }
    });
    return;
  }
  log("trigger", `${message.id} thread=${thread.id} owner=${ownerId ?? "-"} author=${message.author.username}${fromBot ? "(bot)" : ""} mentions=[${mentions}] hops=${hop.hops} text=${brief(message.content, 120)}`);
  const status = new StatusReactions(message);
  await status.set("received");
  const who = {
    ownerId: botOwner(config2.discord.owner_id, me),
    // A bot cannot click, and naming it in a prompt could trigger it.
    requesterId: fromBot ? void 0 : message.author.id
  };
  const { queued } = enqueue(thread.id, () => runInThread(thread, message, channel, status, who));
  if (queued) {
    log("queue", `${message.id} waiting for thread ${thread.id}`);
    await status.set("waiting");
  }
}
async function runInThread(thread, trigger, channel, status, who) {
  let progress;
  try {
    await status.set("running");
    const ts = getThread(thread.id);
    const attachments = await saveAttachments(trigger, thread.id);
    const prompt = await buildPrompt({
      thread,
      trigger,
      history: channel.history,
      afterId: ts.sessionId ? ts.lastSeenMessageId : void 0,
      attachments
    });
    let lastReply;
    let waits = 0;
    const waiting = async (wait) => {
      if (waits++ === 0) await status.set("waiting");
      try {
        return await wait();
      } finally {
        if (--waits === 0) await status.set("running");
      }
    };
    const session = await acquire(thread.id, trigger.client.user.id, channel, ts.sessionId, ts.resumeCostBase ?? ts.lastCostTotal);
    progress = stopControl(thread, who, STOP_BUTTON_DELAY_MS, (by) => void session.interrupt(by));
    const turn = await session.run(prompt, {
      sendReply: async (text, files) => {
        const chunks = splitMessage(text);
        if (!chunks.length && files.length) chunks.push("");
        for (const [i, chunk] of chunks.entries()) {
          const attach = i === chunks.length - 1 ? files.map((f) => ({ attachment: f, name: path7.basename(f) })) : [];
          lastReply = await thread.send({ ...chunk ? { content: chunk } : {}, files: attach, allowedMentions: { parse: ["users"] } });
        }
      },
      askPermission: (req) => waiting(async () => {
        try {
          const answer = await askPermission(thread, req, who, channel.permissionTimeoutMs);
          if (answer.behavior === "always") {
            ts.alwaysAllow = [.../* @__PURE__ */ new Set([...ts.alwaysAllow ?? [], req.toolName])];
            saveState();
          }
          return answer;
        } catch (e) {
          log("error", `permission prompt ${thread.id}: ${e.message}`);
          return { behavior: "deny", message: `\u7121\u6CD5\u5728 Discord \u4E0A\u8A62\u554F\u4E3B\u4EBA\uFF08${e.message}\uFF09\uFF0C\u5DF2\u62D2\u7D55\u3002` };
        }
      }),
      askQuestion: (questions, signal) => waiting(
        () => askQuestion(thread, questions, who, channel.permissionTimeoutMs, signal).catch((e) => {
          log("error", `question prompt ${thread.id}: ${e.message}`);
          return void 0;
        })
      )
    });
    const progressMessage = await progress.end();
    if (turn.sessionId) ts.sessionId = turn.sessionId;
    ts.lastCostTotal = turn.costTotal;
    ts.lastSeenMessageId = trigger.id;
    saveState();
    const notice = async (content) => progressMessage ? await progressMessage.edit({ content, components: [], allowedMentions: { parse: [] } }) : await thread.send({ content, allowedMentions: { parse: [] } });
    if (turn.stoppedBy) {
      log("stopped", `${thread.id} by ${turn.stoppedBy} subtype=${turn.subtype}`);
      const msg = await notice(`\u23F9\uFE0F \u5DF2\u7531 ${turn.stoppedBy} \u505C\u6B62\u3002\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u9019\u6BB5\u5C0D\u8A71\u3002`);
      await attachDetails(msg, rememberTurn(thread.id, turn));
      await status.set("stopped");
      return;
    }
    if (turn.ok && turn.replies === 0 && trigger.author.bot) {
      log("silent", `${thread.id} no reply to bot ${trigger.author.username} ${brief(turn.lastText, 200)}`);
      await progressMessage?.delete().catch(() => {
      });
      await status.set("done");
      return;
    }
    if (!turn.ok || turn.replies === 0 || !lastReply) {
      const text = turn.ok ? `\uFF08\u6C92\u6709\u547C\u53EB reply\uFF0C\u4EE5\u4E0B\u70BA\u81EA\u52D5\u6458\u8981\uFF09
${turn.lastText.trim().slice(0, FALLBACK_MAX) || "\uFF08\u6C92\u6709\u8F38\u51FA\uFF09"}` : `\u57F7\u884C\u5931\u6557\uFF1A${turn.subtype}${turn.error ? `\uFF08${turn.error.slice(0, 200)}\uFF09` : ""}\u3002\u4E0B\u6B21\u89F8\u767C\u6642\u6703\u63A5\u56DE\u9019\u6BB5\u5C0D\u8A71\u3002`;
      log("fallback", `${thread.id} ${brief(text, 200)}`);
      lastReply = await notice(text);
    } else {
      await progressMessage?.delete().catch(() => {
      });
    }
    await attachDetails(lastReply, rememberTurn(thread.id, turn));
    await status.set(turn.ok ? "done" : "failed");
  } catch (e) {
    log("error", `run ${thread.id}: ${e.stack ?? e}`);
    await (await progress?.end())?.delete().catch(() => {
    });
    await thread.send({ content: `\u57F7\u884C\u5931\u6557\uFF1A${e.message.slice(0, 200)}`, allowedMentions: { parse: [] } }).catch(() => {
    });
    await status.set("failed");
  }
}

// src/main.ts
var DRAIN_MS = 5e3;
var config = loadConfig();
loadState();
log("start", `pid=${process.pid} home=${DATA_DIR} pipe=${STOP_PIPE} guild=${config.discord.guild_id ?? "-"} bound channels=${Object.keys(config.channels).join(", ") || "(none)"}`);
var stopServer = net.createServer((socket) => {
  socket.on("error", () => {
  });
  socket.once("data", (d) => {
    if (d.toString().trim() !== "stop") return void socket.end("unknown command\n");
    socket.end(`stopping pid=${process.pid}
`);
    void shutdown("stop command");
  });
});
await new Promise((resolve) => {
  stopServer.once("error", (e) => {
    log("start", `cannot listen on ${STOP_PIPE} (${e.code}); is another bot running? exiting`);
    process.exit(1);
  });
  stopServer.listen(STOP_PIPE, resolve);
});
var client = createBot();
client.once(Events2.ClientReady, (c) => {
  writeFileSync3(PID_PATH, String(process.pid), "utf8");
  log("ready", `logged in as ${c.user.tag} id=${c.user.id} guilds=${c.guilds.cache.size}`);
});
var stopping2 = false;
async function shutdown(signal) {
  if (stopping2) return;
  stopping2 = true;
  log("stop", signal);
  try {
    await closeAll();
    const deadline = Date.now() + DRAIN_MS;
    while (anyPending() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await client.destroy();
  } catch (e) {
    log("stop", `error ${e.message}`);
  }
  rmSync(PID_PATH, { force: true });
  stopServer.close();
  log("stop", "done");
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(sig, () => void shutdown(sig));
process.on("unhandledRejection", (e) => log("error", `unhandled rejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => log("error", `uncaught exception: ${e.stack ?? e}`));
await client.login(config.discord.token);
