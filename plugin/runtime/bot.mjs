// src/main.ts
import { rmSync, writeFileSync as writeFileSync3 } from "node:fs";
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
var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
var isEffort = (v) => typeof v === "string" && EFFORT_LEVELS.includes(v);
var PIN_PATH = path.join(DATA_DIR, "pin.json");
var BUILTIN_DEFAULTS = {
  history: 30,
  max_hops: 5,
  busy_policy: "queue",
  idle_close_minutes: 120,
  max_live_sessions: 4,
  permission_mode: "default",
  permission_timeout_minutes: 10,
  owner_wait_minutes: 2,
  // No limit: a turn runs until it ends; only the owner stops it (🛑, /stop, !stop).
  turn_timeout_minutes: 0,
  // No step limit either.
  max_turns: 0
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
    channels: c.channels ?? {},
    dm: c.dm && typeof c.dm === "object" && typeof c.dm.cwd === "string" && c.dm.cwd ? c.dm : void 0,
    security: { pin_unlock_minutes: positive(c.security?.pin_unlock_minutes, 30) },
    access: { roster_only: c.access?.roster_only !== false }
  };
}
function positive(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}
function resolveChannel(config2, channelId) {
  const ch = config2.channels[channelId];
  return ch ? resolve(config2, channelId, ch, `channel ${channelId}`) : void 0;
}
function resolveDm(config2) {
  return config2.dm ? resolve(config2, "dm", config2.dm, "dm") : void 0;
}
function resolve(config2, channelId, ch, what) {
  const permissionMode = ch.permission_mode ?? config2.defaults.permission_mode;
  if (!ALLOWED_MODES.includes(permissionMode)) {
    throw new Error(`${what}: permission_mode "${permissionMode}" is not allowed`);
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
    permissionTimeoutMs: config2.defaults.permission_timeout_minutes * 60 * 1e3,
    ownerWaitMs: Math.min(config2.defaults.owner_wait_minutes, config2.defaults.permission_timeout_minutes) * 60 * 1e3,
    turnTimeoutMs: minutesOrZero(ch.turn_timeout_minutes ?? config2.defaults.turn_timeout_minutes) * 60 * 1e3,
    maxTurns: Math.floor(minutesOrZero(ch.max_turns ?? config2.defaults.max_turns)),
    ...isEffort(ch.effort) ? { effort: ch.effort } : {}
  };
}
function minutesOrZero(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// src/discord/bot.ts
import {
  ActionRowBuilder as ActionRowBuilder7,
  ButtonBuilder as ButtonBuilder6,
  ButtonStyle as ButtonStyle6,
  ChannelType as ChannelType3,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags as MessageFlags7,
  Partials,
  ThreadAutoArchiveDuration as ThreadAutoArchiveDuration3
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

// src/runner/policy.ts
import path2 from "node:path";
var READ_ONLY = /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "LS", "LSP", "NotebookRead", "ToolSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "Skill"]);
var EDITS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var PATH_KEYS = ["file_path", "notebook_path", "path"];
function inside(file, roots) {
  const abs = path2.resolve(roots[0] ?? ".", file);
  return roots.some((r) => {
    const rel = path2.relative(path2.resolve(r), abs);
    return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
  });
}
function targetPath(input) {
  for (const k2 of PATH_KEYS) if (typeof input[k2] === "string" && input[k2]) return input[k2];
  return void 0;
}
function decideTool(name, input, ctx) {
  if (name === "AskUserQuestion") return { kind: "cli", why: "question" };
  if (name.startsWith(ctx.ownPrefix)) return { kind: "allow", why: "own tool" };
  if (ctx.mode === "auto") {
    if (ctx.alwaysAllowed.has(name)) return { kind: "allow", why: "always allowed this session" };
    return { kind: "cli", why: "auto mode" };
  }
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
function decidePost(mode, ownerTriggered) {
  if (mode === "plan") return { kind: "deny", why: "plan mode" };
  if (ownerTriggered) return { kind: "allow", why: "the owner asked for this turn" };
  if (mode === "dontAsk") return { kind: "deny", why: "dontAsk mode" };
  return { kind: "ask", why: "post requested by someone other than the owner" };
}
function blockedByClassifier(mode) {
  return mode === "auto" ? "ask" : "keep";
}
function retryKey(name, input) {
  const { description: _label, ...rest } = input;
  return `${name} ${JSON.stringify(rest)}`;
}
function canAct(kind, clickerId, who) {
  if (who.ownerId && clickerId === who.ownerId) return true;
  if (kind === "permission") return false;
  return !!who.requesterId && clickerId === who.requesterId;
}

// src/roster.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import path3 from "node:path";
var ROSTER_PATH = path3.join(DATA_DIR, "roster.json");
var ROLE_NAMES = { engineer: "\u5DE5\u7A0B\u5E2B", planner: "\u4F01\u5283" };
function loadRosterFile() {
  if (!existsSync(ROSTER_PATH)) return { bots: [], members: [] };
  try {
    const raw = JSON.parse(readFileSync2(ROSTER_PATH, "utf8").replace(/^﻿/, ""));
    return {
      bots: Array.isArray(raw.bots) ? raw.bots.filter((b) => b && b.botId && b.botName) : [],
      members: Array.isArray(raw.members) ? raw.members.filter((m) => m && m.discordId && m.name) : []
    };
  } catch (e) {
    log("roster", `cannot read ${ROSTER_PATH} (${e.name})`);
    return { bots: [], members: [] };
  }
}
function loadRoster() {
  return loadRosterFile().bots;
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
function botDetails(b) {
  return [b.ownerName ? `\u4E3B\u4EBA ${b.ownerName}` : "", b.role ? `\u89D2\u8272 ${roleName(b.role)}` : ""].filter(Boolean).join("\uFF0C");
}
function rosterPeople(roster) {
  const people = /* @__PURE__ */ new Map();
  for (const m of roster.members) {
    if (!people.has(m.discordId)) people.set(m.discordId, { name: m.name, discordId: m.discordId, role: m.role, bots: [] });
  }
  for (const b of roster.bots) {
    if (!b.ownerDiscordId) continue;
    const p = people.get(b.ownerDiscordId);
    if (p) p.bots.push(b.botName);
    else people.set(b.ownerDiscordId, { name: b.ownerName || `${b.botName} \u7684\u4E3B\u4EBA`, discordId: b.ownerDiscordId, role: b.role, bots: [b.botName] });
  }
  return [...people.values()];
}
function rosterPrompt(selfId, ownerId, roster = loadRosterFile(), opts = {}) {
  if (opts.dm) return dmRosterPrompt(selfId, ownerId, roster);
  const self = roster.bots.find((b) => b.botId === selfId);
  const others = roster.bots.filter((b) => b.botId !== selfId);
  const people = rosterPeople(roster);
  const owner = ownerId ? people.find((p) => p.discordId === ownerId) : void 0;
  const team = people.filter((p) => p.discordId !== ownerId);
  const lines = [
    self ? `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F ${self.botName}\uFF08Discord ID ${selfId}\uFF09${self.ownerName ? `\uFF0C${self.ownerName} \u7684 Bot` : ""}${self.role ? `\uFF0C\u89D2\u8272\uFF1A${roleName(self.role)}` : ""}\u3002` : `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F Discord ID ${selfId} \u7684 Bot\uFF08\u4E0D\u5728\u540D\u518A\u4E2D\uFF09\u3002`
  ];
  if (ownerId) lines.push(`\u3010\u4F60\u7684\u4E3B\u4EBA\u3011${owner ? `${owner.name}\uFF0C` : ""}Discord ID ${ownerId}\uFF1B\u8981\u627E\u4E3B\u4EBA\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@${ownerId}>\u3002`);
  if (others.length) {
    lines.push("\u3010\u5176\u4ED6 Bot\u3011\uFF08\u540D\u518A\uFF1B\u8A0E\u8AD6\u4E32\u88E1\u53EF\u80FD\u51FA\u73FE\u9019\u4E9B Bot\uFF09");
    for (const b of others) {
      const details2 = botDetails(b);
      lines.push(`- ${b.botName}${details2 ? `\uFF1A${details2}` : ""}\uFF1B\u8981\u627E\u5B83\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@${b.botId}>`);
    }
  }
  if (team.length) {
    lines.push("\u3010\u5718\u968A\u6210\u54E1\u3011\uFF08\u540D\u518A\u4E0A\u7684\u4EBA\uFF1B\u8981 @ \u67D0\u4EBA\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@ID>\uFF0C\u548C Bot \u4E00\u6A23\u53EA\u5728\u9700\u8981\u5C0D\u65B9\u505A\u4E8B\u6216\u56DE\u7B54\u6642\u624D @\uFF09");
    for (const p of team) {
      const bots = p.bots.length ? `Bot\uFF1A${p.bots.join("\u3001")}` : "";
      const role = p.role ? `\u89D2\u8272 ${roleName(p.role)}` : "";
      const details2 = [role, bots].filter(Boolean).join("\uFF0C");
      lines.push(`- ${p.name}${details2 ? `\uFF1A${details2}` : ""}\uFF1B\u8981\u627E\u4ED6\u5C31\u5728 reply \u6587\u5B57\u88E1\u5BEB <@${p.discordId}>`);
    }
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
function dmRosterPrompt(selfId, ownerId, roster) {
  const self = roster.bots.find((b) => b.botId === selfId);
  const others = roster.bots.filter((b) => b.botId !== selfId);
  const people = rosterPeople(roster);
  const owner = ownerId ? people.find((p) => p.discordId === ownerId) : void 0;
  const team = people.filter((p) => p.discordId !== ownerId);
  const lines = [
    self ? `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F ${self.botName}\uFF08Discord ID ${selfId}\uFF09${self.ownerName ? `\uFF0C${self.ownerName} \u7684 Bot` : ""}${self.role ? `\uFF0C\u89D2\u8272\uFF1A${roleName(self.role)}` : ""}\u3002` : `\u3010\u4F60\u7684\u8EAB\u5206\u3011\u4F60\u662F Discord ID ${selfId} \u7684 Bot\uFF08\u4E0D\u5728\u540D\u518A\u4E2D\uFF09\u3002`
  ];
  if (ownerId) lines.push(`\u3010\u4F60\u7684\u4E3B\u4EBA\u3011${owner ? `${owner.name}\uFF0C` : ""}Discord ID ${ownerId}\uFF1B\u4F60\u73FE\u5728\u5C31\u662F\u5728\u548C\u4E3B\u4EBA\u79C1\u8A0A\u3002`);
  if (others.length || team.length) {
    lines.push("\u3010\u5718\u968A\u3011\uFF08\u540D\u518A\uFF0C\u8B93\u4F60\u77E5\u9053\u5718\u968A\u6709\u8AB0\uFF09");
    for (const b of others) {
      const details2 = botDetails(b);
      lines.push(`- Bot ${b.botName}${details2 ? `\uFF1A${details2}` : ""}`);
    }
    for (const p of team) {
      const details2 = [p.role ? `\u89D2\u8272 ${roleName(p.role)}` : "", p.bots.length ? `Bot\uFF1A${p.bots.join("\u3001")}` : ""].filter(Boolean).join("\uFF0C");
      lines.push(`- ${p.name}${details2 ? `\uFF1A${details2}` : ""}`);
    }
  }
  lines.push(
    "\u3010\u79C1\u8A0A\u5B88\u5247\u3011",
    "- \u9019\u662F\u4F60\u548C\u4E3B\u4EBA\u7684\u4E00\u5C0D\u4E00\u79C1\u8A0A\uFF0C\u5225\u4EBA\u770B\u4E0D\u5230\uFF0C\u4E5F\u6536\u4E0D\u5230\u901A\u77E5\u3002",
    "- \u4E0D\u8981 @ \u4EFB\u4F55\u4EBA\u6216\u4EFB\u4F55 Bot\uFF1B\u9700\u8981\u5225\u4EBA\u5354\u52A9\u6642\uFF0C\u544A\u8A34\u4E3B\u4EBA\u8A72\u627E\u8AB0\uFF0C\u7531\u4E3B\u4EBA\u6C7A\u5B9A\u3002"
  );
  return lines.join("\n");
}

// src/security/access.ts
function allowedTrigger(authorId, ownerId, roster) {
  if (ownerId && authorId === ownerId) return true;
  if (roster.members.some((m) => m.discordId === authorId)) return true;
  return roster.bots.some((b) => b.botId === authorId || b.ownerDiscordId === authorId);
}

// src/security/pin.ts
import { scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
var MAX_FAILURES = 3;
function readPinFile(file = PIN_PATH) {
  if (!existsSync2(file)) return void 0;
  try {
    const f = JSON.parse(readFileSync3(file, "utf8").replace(/^﻿/, ""));
    if (f.algo !== "scrypt" || !f.salt || !f.hash || !(f.N > 1) || !(f.r > 0) || !(f.p > 0) || !(f.keylen >= 16)) return void 0;
    return f;
  } catch {
    return void 0;
  }
}
var normalizePin = (pin) => pin.normalize("NFKC").trim();
function verifyPin(pin, f) {
  const want = Buffer.from(f.hash, "base64");
  let got;
  try {
    got = scryptSync(normalizePin(pin), Buffer.from(f.salt, "base64"), f.keylen, { N: f.N, r: f.r, p: f.p, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}
function approvalStep(isOwner, gate) {
  if (!isOwner) return "refuse";
  if (gate.locked) return "locked";
  return gate.required ? "pin" : "approve";
}
var PinGate = class {
  constructor(read, unlockMs, now = Date.now) {
    this.read = read;
    this.unlockMs = unlockMs;
    this.now = now;
  }
  read;
  unlockMs;
  now;
  unlockedUntil = 0;
  failures = 0;
  lockedAt;
  /** A PIN has been set on this computer. */
  get configured() {
    return !!this.read();
  }
  get locked() {
    return this.lockedAt !== void 0;
  }
  /** A correct PIN was entered recently and nothing is locked. */
  get unlocked() {
    return !this.locked && this.now() < this.unlockedUntil;
  }
  /** Approving needs the PIN now: one is set and the unlock window has passed. Locked counts as needing it. */
  get required() {
    return this.configured && !this.unlocked;
  }
  attempt(pin) {
    if (this.locked) return { result: "locked", justLocked: false };
    const f = this.read();
    if (!f) return { result: "not-set" };
    if (verifyPin(pin, f)) {
      this.failures = 0;
      this.unlockedUntil = this.now() + this.unlockMs();
      return { result: "ok" };
    }
    this.failures++;
    if (this.failures >= MAX_FAILURES) {
      this.lockedAt = this.now();
      this.unlockedUntil = 0;
      return { result: "locked", justLocked: true };
    }
    return { result: "wrong", left: MAX_FAILURES - this.failures };
  }
  /** `unlock` from the computer: clear the lock and the failure count (the PIN is still needed). */
  reset() {
    this.lockedAt = void 0;
    this.failures = 0;
  }
  state() {
    return { configured: this.configured, locked: this.locked, unlockedUntil: this.unlocked ? this.unlockedUntil : 0, failures: this.failures };
  }
};
var pinGate = new PinGate(
  () => readPinFile(),
  () => {
    try {
      return loadConfig().security.pin_unlock_minutes * 60 * 1e3;
    } catch {
      return 30 * 60 * 1e3;
    }
  }
);

// src/store/state.ts
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync4, renameSync, writeFileSync } from "node:fs";
import path4 from "node:path";
var STATE_PATH = path4.join(DATA_DIR, "state.json");
var DM_KEY = "dm";
var DM_HISTORY_MAX = 30;
var state = { threads: {} };
function loadState() {
  if (!existsSync3(STATE_PATH)) return;
  state = JSON.parse(readFileSync4(STATE_PATH, "utf8"));
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
function registerThread(threadId, channelId, name) {
  const t = { channelId, lastCostTotal: 0, resumeCostBase: 0, createdAt: (/* @__PURE__ */ new Date()).toISOString(), ...name ? { name } : {} };
  state.threads[threadId] = t;
  saveState();
  return t;
}
function getBatch(id) {
  return state.approvals?.[id];
}
function putBatch(b) {
  const keep = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  state.approvals = Object.fromEntries(Object.entries(state.approvals ?? {}).filter(([, x]) => x.expiresAt > keep));
  state.approvals[b.id] = b;
  saveState();
}
function allThreads() {
  return Object.entries(state.threads);
}
function freshDm() {
  return { channelId: DM_KEY, lastCostTotal: 0, resumeCostBase: 0, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function getDm() {
  state.dm ??= freshDm();
  return state.dm;
}
function dmHistory() {
  return state.dmHistory ?? [];
}
function switchDm(next) {
  const cur = state.dm;
  const rest = (state.dmHistory ?? []).filter((h) => h.sessionId && h.sessionId !== cur?.sessionId && h.sessionId !== next?.sessionId);
  state.dmHistory = [...cur?.sessionId ? [cur] : [], ...rest].slice(0, DM_HISTORY_MAX);
  state.dm = next ?? freshDm();
  saveState();
  return state.dm;
}
function getConversation(key) {
  return key === DM_KEY ? state.dm : state.threads[key];
}
function findSession(key, sessionId) {
  if (!sessionId) return void 0;
  if (key !== DM_KEY) return state.threads[key]?.sessionId === sessionId ? state.threads[key] : void 0;
  return [state.dm, ...state.dmHistory ?? []].find((d) => d?.sessionId === sessionId);
}
var folderKey = (cwd) => path4.resolve(cwd).toLowerCase();
function rememberSkills(cwd, items) {
  const key = folderKey(cwd);
  const prev = state.skills?.[key];
  if (prev && JSON.stringify(prev.items) === JSON.stringify(items)) return;
  state.skills = { ...state.skills ?? {}, [key]: { at: (/* @__PURE__ */ new Date()).toISOString(), items } };
  saveState();
}
function skillsFor(cwd) {
  return state.skills?.[folderKey(cwd)]?.items;
}

// src/discord/approvals-ui.ts
import {
  ActionRowBuilder as ActionRowBuilder4,
  ButtonBuilder as ButtonBuilder3,
  ButtonStyle as ButtonStyle3,
  MessageFlags as MessageFlags4,
  StringSelectMenuBuilder as StringSelectMenuBuilder2
} from "discord.js";

// src/runner/approvals.ts
var APPROVAL_TTL_MS = 24 * 60 * 60 * 1e3;
var DEFER_MESSAGE = "\u4E3B\u4EBA\u66AB\u6642\u4E0D\u5728\u3002\u9019\u500B\u52D5\u4F5C\u5DF2\u6392\u5165\u5F85\u6838\u51C6\u6E05\u55AE\u3002\u8ACB\u6539\u7528\u4E0D\u9700\u8981\u6B0A\u9650\u7684\u65B9\u5F0F\u628A\u80FD\u505A\u7684\u505A\u5B8C\uFF1B\u505A\u4E0D\u5230\u7684\u90E8\u5206\uFF0C\u5728 reply \u88E1\u6574\u7406\u6210\u300C\u5F85\u4E3B\u4EBA\u6838\u51C6\u300D\uFF0C\u8AAA\u660E\u8981\u505A\u4EC0\u9EBC\u3001\u70BA\u4EC0\u9EBC\uFF0C\u7136\u5F8C\u7D50\u675F\u9019\u4E00\u8F2A\u3002\u4E0D\u8981\u91CD\u8A66\u540C\u4E00\u500B\u52D5\u4F5C\u3002";
function deferItem(toolName, input) {
  return { toolName, input, key: retryKey(toolName, input) };
}
function deferredKeys(items) {
  return items.map((x) => x.key);
}
function newBatch(f) {
  const now = f.now ?? Date.now();
  const seen = /* @__PURE__ */ new Set();
  const items = f.items.filter((x) => seen.has(x.key) ? false : (seen.add(x.key), true));
  return { id: f.id, convKey: f.convKey, kind: f.kind, ...f.requesterId ? { requesterId: f.requesterId } : {}, items, createdAt: now, expiresAt: now + APPROVAL_TTL_MS, status: "pending" };
}
function decide2(b, choice, now = Date.now()) {
  if (b.status !== "pending") return { result: "already", status: b.status };
  if (now >= b.expiresAt) {
    b.status = "expired";
    return { result: "expired" };
  }
  const picked = choice === "all" ? b.items.map((_, i) => i) : choice === "none" ? [] : choice.filter((i) => i >= 0 && i < b.items.length);
  const allow = b.items.filter((_, i) => picked.includes(i));
  const deny = b.items.filter((_, i) => !picked.includes(i));
  b.status = !allow.length ? "denied" : deny.length ? "partial" : "approved";
  return { result: "decided", status: b.status, allow, deny };
}
var line = (x, i) => `${i + 1}. ${x.toolName} ${JSON.stringify(x.input).slice(0, 400)}`;
function approvedPrompt(allow, deny) {
  const parts = [`\u4E3B\u4EBA\u5DF2\u6838\u51C6\uFF1A
${allow.map(line).join("\n")}
\u8ACB\u7528\u76F8\u540C\u53C3\u6578\u57F7\u884C\u9019\u4E9B\u52D5\u4F5C\uFF0C\u5B8C\u6210\u5269\u4E0B\u7684\u5DE5\u4F5C\uFF0C\u4E26\u7528 reply \u56DE\u5831\u3002`];
  if (deny.length) parts.push(`\u4E3B\u4EBA\u62D2\u7D55\u4E86\u9019\u4E9B\u52D5\u4F5C\uFF0C\u4E0D\u8981\u505A\uFF1A
${deny.map(line).join("\n")}`);
  return parts.join("\n\n");
}
function deniedNote(deny) {
  return `\u3010\u4E3B\u4EBA\u7684\u6C7A\u5B9A\u3011\u5148\u524D\u6392\u5165\u5F85\u6838\u51C6\u6E05\u55AE\u7684\u52D5\u4F5C\uFF0C\u4E3B\u4EBA\u62D2\u7D55\u4E86\uFF0C\u4E0D\u8981\u505A\u9019\u4E9B\u52D5\u4F5C\uFF1A
${deny.map(line).join("\n")}`;
}
function noticeText(b, ownerId, where) {
  const n = b.items.length;
  if (b.status === "approved") return `\u2705 \u4E3B\u4EBA\u5DF2\u6838\u51C6\u5F85\u6838\u51C6\u7684 ${n} \u500B\u52D5\u4F5C\uFF0CBot \u63A5\u8457\u505A\u3002`;
  if (b.status === "partial") return `\u2705 \u4E3B\u4EBA\u5DF2\u6838\u51C6\u90E8\u5206\u5F85\u6838\u51C6\u7684\u52D5\u4F5C\uFF0CBot \u63A5\u8457\u505A\uFF08\u5176\u9918\u5DF2\u62D2\u7D55\uFF09\u3002`;
  if (b.status === "denied") return `\u{1F6AB} \u4E3B\u4EBA\u62D2\u7D55\u4E86\u5F85\u6838\u51C6\u7684 ${n} \u500B\u52D5\u4F5C\u3002`;
  if (b.status === "expired") return `\u231B \u5F85\u6838\u51C6\u7684 ${n} \u500B\u52D5\u4F5C\u5DF2\u904E\u671F\uFF0824 \u5C0F\u6642\uFF09\uFF0C\u6C92\u6709\u57F7\u884C\u3002`;
  return `\u23F3 \u6709 ${n} \u500B\u52D5\u4F5C\u7B49 <@${ownerId}> \u6838\u51C6\uFF08${where === "dm" ? "\u5DF2\u79C1\u8A0A\u4E3B\u4EBA" : "\u8ACB\u4E3B\u4EBA\u6309\u4E0B\u65B9\u7684\u5361\u7247"}\uFF09\u3002`;
}
function outcomeText(d, by) {
  if (d.result === "expired") return "\u231B \u5DF2\u904E\u671F\uFF0824 \u5C0F\u6642\uFF09\uFF0C\u6309\u9215\u5931\u6548\u3002";
  if (d.result === "already") return `\u5DF2\u8655\u7406\u904E\uFF08${d.status}\uFF09\u3002`;
  if (d.status === "approved") return `\u2705 ${by} \u5DF2\u5168\u90E8\u6838\u51C6\uFF0CBot \u63A5\u8457\u505A\u3002`;
  if (d.status === "denied") return `\u{1F6AB} ${by} \u5DF2\u5168\u90E8\u62D2\u7D55\u3002`;
  return `\u2705 ${by} \u6838\u51C6\u4E86 ${d.allow.length} \u500B\uFF0C\u62D2\u7D55\u4E86 ${d.deny.length} \u500B\uFF0CBot \u63A5\u8457\u505A\u6838\u51C6\u7684\u90E8\u5206\u3002`;
}
async function deliverCard(send, onDmError) {
  if (send.dm) {
    try {
      return { where: "dm", sent: await send.dm() };
    } catch (e) {
      onDmError?.(e);
    }
  }
  return { where: "thread", sent: await send.thread() };
}

// src/discord/commands.ts
var COMMANDS = {
  help: { dmOnly: false, takesArg: false, private: true, desc: "\u5217\u51FA\u6307\u4EE4" },
  clear: { dmOnly: true, takesArg: false, private: false, desc: "\u7D50\u675F\u76EE\u524D\u7684\u5C0D\u8A71\uFF0C\u4E0B\u4E00\u5247\u8A0A\u606F\u958B\u65B0\u7684" },
  resume: { dmOnly: true, takesArg: false, private: true, desc: "\u5F9E\u6E05\u55AE\u9078\u4E00\u6BB5\u4EE5\u524D\u7684\u5C0D\u8A71\u63A5\u56DE\u4F86" },
  stop: { dmOnly: false, takesArg: false, private: false, desc: "\u4E2D\u65B7 Claude \u6B63\u5728\u505A\u7684\u9019\u4E00\u8F2A\uFF08\u540C \u{1F6D1}\uFF09" },
  status: { dmOnly: false, takesArg: false, private: true, desc: "\u5DE5\u4F5C\u76EE\u9304\u3001\u6A21\u578B\u3001\u6A21\u5F0F\u3001\u82B1\u8CBB\u3001\u4E0A\u4E0B\u6587\u548C\u984D\u5EA6" },
  model: { dmOnly: false, takesArg: true, private: false, desc: "\u63DB\u6A21\u578B\uFF08haiku\uFF0Fsonnet\uFF0Fopus\uFF09", example: "sonnet" },
  effort: { dmOnly: false, takesArg: true, private: false, desc: "\u8ABF\u6574\u52AA\u529B\u7A0B\u5EA6\uFF08low\uFF0Fmedium\uFF0Fhigh\uFF0Fxhigh\uFF0Fmax\uFF0Cdefault \u56DE\u5230\u9810\u8A2D\uFF09", example: "high" },
  plan: { dmOnly: false, takesArg: false, private: false, desc: "\u5207\u5230\u8A08\u756B\u6A21\u5F0F\uFF08\u53EA\u8A0E\u8AD6\u4E0D\u52D5\u624B\uFF09\uFF0C\u518D\u7528\u4E00\u6B21\u5207\u56DE" },
  compact: { dmOnly: false, takesArg: false, private: false, desc: "\u58D3\u7E2E\u4E0A\u4E0B\u6587\uFF0C\u8B93\u5C0D\u8A71\u53EF\u4EE5\u7E7C\u7E8C" },
  retry: { dmOnly: false, takesArg: false, private: false, desc: "\u628A\u4E0A\u4E00\u5247\u8A0A\u606F\u539F\u6A23\u91CD\u9001\u4E00\u6B21" },
  skill: { dmOnly: false, takesArg: true, private: false, desc: "\u57F7\u884C Claude Code \u7684 skill \u6216\u81EA\u8A02\u6307\u4EE4", example: "<\u540D\u7A31> [\u53C3\u6578]" },
  takeback: { dmOnly: false, takesArg: false, private: false, ownerOnly: true, desc: "\u5F37\u5236\u63A5\u56DE\u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\u7684\u5C0D\u8A71\uFF08\u96FB\u8166\u4E0A\u7684\u8ACB\u5148\u95DC\u6389\uFF09" }
};
var EFFORT_CHOICES = [
  { level: "low", label: "low", note: "\u6700\u5FEB\u3001\u6700\u7701" },
  { level: "medium", label: "medium", note: "\u8F03\u5FEB" },
  { level: "high", label: "high", note: "\u4ED4\u7D30" },
  { level: "xhigh", label: "xhigh", note: "\u5F88\u4ED4\u7D30" },
  { level: "max", label: "max", note: "\u6700\u4ED4\u7D30\u3001\u6700\u6162" }
];
function normalizeEffort(arg) {
  const a = arg.trim().toLowerCase();
  if (EFFORT_CHOICES.some((c) => c.level === a)) return a;
  if (a === "default" || a === "none" || a === "\u9810\u8A2D") return null;
  return void 0;
}
var MODEL_CHOICES = [
  { alias: "haiku", label: "Haiku", note: "\u6700\u5FEB\u3001\u6700\u4FBF\u5B9C" },
  { alias: "sonnet", label: "Sonnet", note: "\u5747\u8861\uFF08\u5EFA\u8B70\uFF09" },
  { alias: "opus", label: "Opus", note: "\u6700\u5F37\u3001\u6700\u8CB4" }
];
function stripMentions(text) {
  return text.replace(/<@[!&]?\d+>/g, " ").replace(/\s+/g, " ").trim();
}
function parseCommand(text) {
  const clean = stripMentions(text);
  const sk = /^!skill(?:\s+(\S+)(?:\s+(.+))?)?$/i.exec(clean);
  if (sk) return { name: "skill", ...sk[1] !== void 0 ? { arg: sk[1] } : {}, ...sk[2] !== void 0 ? { rest: sk[2] } : {} };
  const m = /^!([a-z]+)(?:\s+(\S+))?$/i.exec(clean);
  if (!m) return void 0;
  const name = m[1].toLowerCase();
  const spec = COMMANDS[name];
  if (!spec) return void 0;
  if (m[2] !== void 0 && !spec.takesArg) return void 0;
  return m[2] !== void 0 ? { name, arg: m[2] } : { name };
}
function normalizeModel(arg) {
  const a = arg.trim().toLowerCase();
  if (MODEL_CHOICES.some((c) => c.alias === a)) return a;
  return /^claude-[a-z0-9.[\]-]+$/.test(a) ? a : void 0;
}
function helpText(kind) {
  const lines = Object.entries(COMMANDS).filter(([, s]) => kind === "dm" || !s.dmOnly).map(([n, s]) => `\`/${n}\`${s.example ? ` ${s.example}` : ""}\u3000${s.desc}`);
  const who = kind === "dm" ? "" : "\n\u8A0E\u8AD6\u4E32\u88E1\u53EA\u6709 Bot \u7684\u4E3B\u4EBA\u6216\u63D0\u51FA\u9700\u6C42\u7684\u4EBA\u80FD\u7528\uFF1B`/clear`\u3001`/resume` \u53EA\u80FD\u5728\u79C1\u8A0A\u7528\u3002";
  return [
    "**\u6307\u4EE4**\uFF1A\u6253 `/` \u6703\u8DF3\u51FA\u9078\u55AE\uFF0C\u540C\u4E00\u500B\u4F3A\u670D\u5668\u6709\u597D\u5E7E\u96BB Bot \u6642\uFF0C\u8ACB\u9078\u9019\u96BB Bot \u5E95\u4E0B\u7684\u6307\u4EE4\u3002",
    "\u4E5F\u53EF\u4EE5\u6253 `!` \u958B\u982D\u7684\u5099\u7528\u5BEB\u6CD5\uFF08\u4F8B\u5982 `!model sonnet`\u3001`!skill <\u540D\u7A31> [\u53C3\u6578]`\uFF0C\u8A0A\u606F\u53EA\u6253\u6307\u4EE4\u624D\u7B97\uFF09\u3002",
    ...lines,
    "`/skill` \u7684\u540D\u7A31\u6703\u5F9E\u6E05\u55AE\u9078\uFF1B\u6E05\u55AE\u662F\u9019\u500B\u5DE5\u4F5C\u8CC7\u6599\u593E\u4E0A\u6B21\u958B\u5C0D\u8A71\u6642 Claude Code \u63D0\u4F9B\u7684 skill \u548C\u81EA\u8A02\u6307\u4EE4\uFF08\u9084\u6C92\u958B\u904E\u5C0D\u8A71\u6642\uFF0C\u5148\u50B3\u4E00\u5247\u8A0A\u606F\uFF09\u3002skill \u7528\u5230\u7684\u5DE5\u5177\u4E00\u6A23\u8981\u6309\u6B0A\u9650\u6309\u9215\u3002"
  ].join("\n") + who;
}
var CHAT_INPUT = 1;
var STRING = 3;
var CONTEXT_GUILD = 0;
var CONTEXT_BOT_DM = 1;
var GUILD_INSTALL = 0;
function slashDefinitions() {
  return Object.entries(COMMANDS).map(([name, s]) => {
    const def = {
      type: CHAT_INPUT,
      name,
      description: s.desc.slice(0, 100),
      contexts: s.dmOnly ? [CONTEXT_BOT_DM] : [CONTEXT_GUILD, CONTEXT_BOT_DM],
      integration_types: [GUILD_INSTALL]
    };
    if (name === "model") {
      def.options = [{ type: STRING, name: "name", description: "\u8981\u63DB\u6210\u7684\u6A21\u578B\uFF08\u4E0D\u9078\u5C31\u986F\u793A\u6309\u9215\uFF09", required: false, choices: MODEL_CHOICES.map((m) => ({ name: `${m.label}\uFF08${m.note}\uFF09`, value: m.alias })) }];
    }
    if (name === "effort") {
      def.options = [{ type: STRING, name: "level", description: "\u52AA\u529B\u7A0B\u5EA6\uFF08\u4E0D\u9078\u5C31\u986F\u793A\u6309\u9215\uFF09", required: false, choices: [...EFFORT_CHOICES.map((e) => ({ name: `${e.label}\uFF08${e.note}\uFF09`, value: e.level })), { name: "default\uFF08\u56DE\u5230\u9810\u8A2D\uFF09", value: "default" }] }];
    }
    if (name === "skill") {
      def.options = [
        { type: STRING, name: "name", description: "skill \u6216\u81EA\u8A02\u6307\u4EE4\u7684\u540D\u7A31\uFF08\u5F9E\u6E05\u55AE\u9078\uFF09", required: true, autocomplete: true, max_length: 100 },
        { type: STRING, name: "args", description: "\u8981\u4EA4\u7D66\u5B83\u7684\u53C3\u6578\uFF08\u9078\u586B\uFF09", required: false, max_length: 1500 }
      ];
    }
    return def;
  });
}
function commandFromSlash(name, options = {}) {
  if (!(name in COMMANDS)) return void 0;
  const n = name;
  if (n === "model") return options.name ? { name: n, arg: options.name } : { name: n };
  if (n === "effort") return options.level ? { name: n, arg: options.level } : { name: n };
  if (n === "skill") return { name: n, ...options.name ? { arg: options.name } : {}, ...options.args?.trim() ? { rest: options.args.trim() } : {} };
  return { name: n };
}
function commandGate(f) {
  if (f.locked) return "locked";
  if (f.where === "dm") {
    const a = dmAccess({ authorId: f.actorId, ownerId: f.ownerId, dmEnabled: !!f.dmEnabled });
    if (a === "not-owner") return "dm-not-owner";
    if (a === "disabled") return "dm-disabled";
    if (!f.pinSet) return "dm-no-pin";
    if (!f.pinUnlocked) return "dm-pin-needed";
    return void 0;
  }
  if (!f.bound) return "unbound";
  if (f.notAllowed) return "not-allowed";
  if (f.where !== "thread") return "not-thread";
  if (COMMANDS[f.cmd].dmOnly) return "dm-only";
  if (COMMANDS[f.cmd].ownerOnly && (!f.ownerId || f.actorId !== f.ownerId)) return "owner-only";
  if (!canAct("stop", f.actorId, { ownerId: f.ownerId, requesterId: f.requesterId })) return "not-actor";
  return void 0;
}
function gateText(r, f) {
  const c = `${f.slash ? "/" : "!"}${f.cmd}`;
  switch (r) {
    case "locked":
      return "\u{1F512} \u5DF2\u9396\u5B9A\uFF08PIN \u8F38\u932F\u592A\u591A\u6B21\uFF09\u3002\u8ACB\u5728\u96FB\u8166\u4E0A\u57F7\u884C unlock \u6216\u91CD\u555F Bot \u89E3\u9664\u3002";
    case "unbound":
      return "\u9019\u500B\u983B\u9053\u6C92\u6709\u7D81\u5B9A\u9019\u96BB Bot\uFF0C\u6307\u4EE4\u53EA\u80FD\u5728\u7D81\u5B9A\u983B\u9053\u7684\u8A0E\u8AD6\u4E32\u88E1\uFF08\u6216\u79C1\u8A0A Bot\uFF09\u4F7F\u7528\u3002";
    case "not-allowed":
      return "\u4F60\u4E0D\u5728\u9019\u96BB Bot \u7684\u767D\u540D\u55AE\u88E1\uFF0C\u8ACB Bot \u7684\u4E3B\u4EBA\u628A\u4F60\u52A0\u9032\u540D\u518A\u3002";
    case "not-thread":
      return "\u6307\u4EE4\u8ACB\u5728\u8A0E\u8AD6\u4E32\u88E1\uFF08\u6216\u79C1\u8A0A Bot\uFF09\u4F7F\u7528\u3002";
    case "dm-only":
      return `\`${c}\` \u53EA\u80FD\u5728\u79C1\u8A0A Bot \u6642\u4F7F\u7528\u3002`;
    case "not-actor": {
      const names = [f.requesterId, f.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
      return `\u53EA\u6709 ${names.join(" \u6216 ") || "Bot \u7684\u4E3B\u4EBA"} \u53EF\u4EE5\u5728\u9019\u500B\u8A0E\u8AD6\u4E32\u7528\u6307\u4EE4\u3002`;
    }
    case "owner-only":
      return `\`${c}\` \u53EA\u6709 Bot \u7684\u4E3B\u4EBA${f.ownerId ? `\uFF08<@${f.ownerId}>\uFF09` : ""}\u53EF\u4EE5\u7528\u3002`;
    case "dm-not-owner":
      return "\u9019\u96BB Bot \u53EA\u63A5\u53D7\u4E3B\u4EBA\u79C1\u8A0A\u3002";
    case "dm-disabled":
      return "\u79C1\u8A0A\u672A\u958B\u555F\uFF1A\u8ACB\u5728\u96FB\u8166\u4E0A\u7528 /channelcollab:bind \u958B\u555F\u79C1\u8A0A\uFF08\u8981\u5148\u8A2D\u5B9A PIN\uFF09\u3002";
    case "dm-no-pin":
      return NO_PIN_TEXT;
    case "dm-pin-needed":
      return "\u{1F512} \u79C1\u8A0A\u8981\u5148\u8F38\u5165 PIN \u89E3\u9396\uFF0C\u89E3\u9396\u5F8C\u518D\u7528\u4E00\u6B21\u6307\u4EE4\u3002";
  }
}
var NO_PIN_TEXT = "\u79C1\u8A0A\u8981\u5148\u8A2D\u5B9A PIN \u624D\u80FD\u7528\uFF1A\u8ACB\u5728\u96FB\u8166\u4E0A\u57F7\u884C channelcollab \u7684 set-pin\uFF08\u6216\u5728 Claude Code \u7528 /channelcollab:bind \u8A2D\u5B9A PIN\uFF09\u3002";
function dmAccess(f) {
  if (!f.ownerId || f.authorId !== f.ownerId) return "not-owner";
  return f.dmEnabled ? "run" : "disabled";
}
function throttle(seen, key, now = Date.now(), windowMs = 10 * 60 * 1e3) {
  const last = seen.get(key);
  if (last !== void 0 && now - last < windowMs) return false;
  seen.set(key, now);
  return true;
}
function mentionsSelf(f, selfId, ownRoleId) {
  if ([...f.userIds].includes(selfId)) return true;
  return [...f.roles].some((r) => r.botId === selfId || !!ownRoleId && r.id === ownRoleId);
}
function mentionsOtherBotRole(roles, selfId) {
  return [...roles].some((r) => !!r.botId && r.botId !== selfId);
}
var DISCORD_LIMIT = 2e3;
function splitMessage(text, limit = DISCORD_LIMIT) {
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}
function splitReply(text, footer = "") {
  const chunks = splitMessage(text);
  if (!footer) return chunks;
  const tail = `
${footer}`;
  const last = chunks.pop();
  if (last === void 0) return [footer];
  if (last.length + tail.length <= DISCORD_LIMIT) return [...chunks, last + tail];
  const again = splitMessage(last, DISCORD_LIMIT - tail.length);
  again[again.length - 1] += tail;
  return [...chunks, ...again];
}
function duration(ms) {
  const min = Math.max(0, Math.round(ms / 6e4));
  if (min < 1) return "\u4E0D\u5230 1 \u5206\u9418";
  const h = Math.floor(min / 60);
  return h ? `${h} \u5C0F\u6642${min % 60 ? ` ${min % 60} \u5206` : ""}` : `${min} \u5206\u9418`;
}
function shortTime(iso) {
  if (iso === void 0) return "\u6642\u9593\u4E0D\u660E";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u6642\u9593\u4E0D\u660E";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function resumeList(candidates, max = 10) {
  const seen = /* @__PURE__ */ new Set();
  return [...candidates].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).filter((c) => seen.has(c.sessionId) ? false : (seen.add(c.sessionId), true)).slice(0, max);
}
function resumeOption(c) {
  const src = c.kind === "dm" ? "\u79C1\u8A0A" : `\u8A0E\u8AD6\u4E32\u300C${c.source}\u300D`;
  const clip3 = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
  return { label: clip3(`${shortTime(c.at)}\u3000${src}`, 100), description: clip3(c.summary.replace(/\s+/g, " ").trim() || "\uFF08\u6C92\u6709\u6458\u8981\uFF09", 100) };
}

// src/discord/conversation.ts
import path9 from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";

// src/runner/failure.ts
var SECRET_PATTERNS = [
  /[MN][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Bot)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g,
  /(?<![\\/:.\w-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w-])/g
];
function maskSecrets(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => /^(Bearer|Bot)\s/i.test(m) ? `${m.split(/\s+/)[0]} ***` : "***");
  return out;
}
var HINTS = [
  {
    test: (f, t) => f.apiError === "authentication_failed" || f.apiError === "oauth_org_not_allowed" || /not logged in|please run \/login|\/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|oauth token|credentials/i.test(t),
    hint: "Claude \u6C92\u767B\u5165\uFF08\u6216\u767B\u5165\u904E\u671F\uFF09\uFF1A\u8ACB\u5728\u9019\u53F0\u96FB\u8166\u958B\u7D42\u7AEF\u6A5F\u57F7\u884C claude\uFF0C\u7167\u756B\u9762\u767B\u5165\u5F8C\u518D\u8A66\u3002"
  },
  { test: (f, t) => f.apiError === "billing_error" || /credit balance|billing|payment/i.test(t), hint: "\u5E33\u865F\u7684\u4ED8\u8CBB\u6216\u984D\u5EA6\u8A2D\u5B9A\u6709\u554F\u984C\uFF0C\u8ACB\u627E\u7BA1\u7406\u54E1\u78BA\u8A8D\u3002" },
  { test: (f, t) => f.apiError === "rate_limit" || /rate.?limit|usage limit|limit reached|\b429\b|hit your limit/i.test(t), hint: "\u984D\u5EA6\u66AB\u6642\u7528\u5B8C\u4E86\uFF0C\u7B49\u91CD\u7F6E\u5F8C\u518D\u8A66\uFF08\u6253 !status \u53EF\u4EE5\u770B\u984D\u5EA6\uFF09\u3002" },
  { test: (f, t) => f.apiError === "model_not_found" || /model\b.*\b(not found|does not exist|not available|invalid)|invalid model/i.test(t), hint: "\u6A21\u578B\u540D\u7A31\u4E0D\u5C0D\u6216\u6C92\u6709\u4F7F\u7528\u6B0A\u9650\uFF0C\u6253 !model \u63DB\u4E00\u500B\u3002" },
  { test: (_f, t) => /prompt is too long|context (length|window)|too many tokens|exceeds? the (maximum|context)/i.test(t), hint: "\u4E0A\u4E0B\u6587\u592A\u9577\u4E86\uFF1A\u6253 !compact \u58D3\u7E2E\uFF0C\u6216\u5728\u79C1\u8A0A\u6253 !clear \u958B\u65B0\u5C0D\u8A71\u3002" },
  {
    test: (f, t) => f.apiError === "overloaded" || f.apiError === "server_error" || /overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket hang up/i.test(t),
    hint: "Anthropic \u670D\u52D9\u66AB\u6642\u5FD9\u788C\u6216\u7DB2\u8DEF\u4E0D\u7A69\uFF0C\u7A0D\u5F8C\u518D\u8A66\u4E00\u6B21\uFF08\u53EF\u4EE5\u6253 !retry\uFF09\u3002"
  },
  { test: (f) => f.subtype === "error_max_turns", hint: "\u9019\u4E00\u8F2A\u9054\u5230\u8A2D\u5B9A\u7684\u6B65\u6578\u4E0A\u9650\uFF08max_turns\uFF09\u88AB\u505C\u6B62\u4E86\uFF1B\u5C0D\u8A71\u5DF2\u4FDD\u5B58\uFF0C\u56DE\u8986\u300C\u7E7C\u7E8C\u300D\u5C31\u6703\u63A5\u8457\u505A\u3002" },
  { test: (f) => f.subtype === "timeout", hint: "\u9019\u4E00\u8F2A\u8D85\u904E\u8A2D\u5B9A\u7684\u5DE5\u4F5C\u6642\u9593\u4E0A\u9650\uFF08turn_timeout_minutes\uFF09\u88AB\u505C\u6B62\u4E86\uFF1B\u5C0D\u8A71\u5DF2\u4FDD\u5B58\uFF0C\u56DE\u8986\u300C\u7E7C\u7E8C\u300D\u5C31\u6703\u63A5\u8457\u505A\u3002" }
];
function failureHint(f) {
  const text = `${f.error ?? ""}`;
  return HINTS.find((h) => h.test(f, text))?.hint ?? "\u53EF\u4EE5\u518D\u8A66\u4E00\u6B21\uFF08\u6253 !retry\uFF09\uFF1B\u4E00\u76F4\u5931\u6557\u7684\u8A71\uFF0C\u8ACB\u5728\u96FB\u8166\u4E0A\u7528 /channelcollab:status \u770B\u6700\u8FD1\u7684\u932F\u8AA4\u3002";
}
function errorExcerpt(error, maxLines = 3, maxChars = 200) {
  if (!error?.trim()) return [];
  return maskSecrets(error).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxLines).map((l) => l.length > maxChars ? `${l.slice(0, maxChars)}\u2026` : l);
}
function explainFailure(f, followUp = "\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u9019\u6BB5\u5C0D\u8A71\u3002") {
  const head = `\u274C \u57F7\u884C\u5931\u6557${f.subtype && f.subtype !== "success" && f.subtype !== "error" ? `\uFF08${f.subtype}\uFF09` : ""}`;
  const lines = errorExcerpt(f.error).map((l) => `> ${l.replace(/`/g, "'")}`);
  if (!lines.length && f.apiError) lines.push(`> ${f.apiError}`);
  return [head, ...lines, `\u{1F4A1} ${failureHint(f)}`, followUp].filter(Boolean).join("\n");
}

// src/runner/session.ts
import { existsSync as existsSync4, realpathSync, statSync } from "node:fs";
import path6 from "node:path";
import {
  createSdkMcpServer,
  query,
  tool
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// src/security/zones.ts
import path5 from "node:path";
var FILE_TOOLS = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "Grep", "Glob", "LS"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PATH_KEYS2 = ["file_path", "notebook_path", "path"];
var PATTERN_KEYS = ["pattern", "glob"];
function normPath(p) {
  return p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function under(abs, root) {
  const r = normPath(root);
  return abs === r || abs.startsWith(`${r}/`);
}
var WHY = {
  home: "channelcollab \u7684\u8CC7\u6599\u593E\uFF08Bot \u8A2D\u5B9A\u3001token\u3001PIN\uFF09",
  ssh: "SSH \u91D1\u9470\u8CC7\u6599\u593E\uFF08.ssh\uFF09",
  env: ".env \u74B0\u5883\u8B8A\u6578\u6A94\uFF08\u5E38\u653E\u5BC6\u78BC\u8207\u91D1\u9470\uFF09",
  cred: "Claude \u7684\u767B\u5165\u8CC7\u6599\uFF08.credentials.json\uFF09",
  ctl: "channelcollab \u7684\u7E3D\u63A7\u8173\u672C\uFF08\u6539\u8A2D\u5B9A\u3001PIN\u3001\u767D\u540D\u55AE\u3001token \u90FD\u8981\u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u81EA\u5DF1\u505A\uFF09"
};
function forbiddenPath(p, base, z2) {
  const abs = normPath(path5.resolve(base, p));
  if (z2.allow.some((a) => under(abs, a))) return void 0;
  const parts = abs.split("/");
  if (z2.homes.some((h) => under(abs, h)) || parts.some((s) => s.startsWith(".channelcollab"))) return WHY.home;
  if (parts.includes(".ssh")) return WHY.ssh;
  const name = parts.at(-1) ?? "";
  if (/^\.env(\..+)?$/.test(name)) return WHY.env;
  if (name === ".credentials.json") return WHY.cred;
  return void 0;
}
function forbiddenText(text, z2) {
  let t = normPath(text);
  if (z2.allow.some((a) => t.includes(`${normPath(a)}/..`))) return WHY.home;
  for (const a of z2.allow) t = t.split(normPath(a)).join(" ");
  if (z2.homes.some((h) => t.includes(normPath(h))) || t.includes(".channelcollab")) return WHY.home;
  if (/(^|[^\w.-])\.ssh([^\w-]|$)/.test(t)) return WHY.ssh;
  if (/(^|[\s"'`/=:(,;|&<>*])\.env(\.[\w.*-]+)?(?=$|[\s"'`;|&)<>,}*])/.test(t)) return WHY.env;
  if (t.includes(".credentials.json")) return WHY.cred;
  if (/(^|[^\w-])(channelcollab|create-bot|ctl)\.mjs([^\w-]|$)/.test(t)) return WHY.ctl;
  return void 0;
}
function strings(v, out = [], depth = 0) {
  if (depth > 4) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}
function forbiddenUse(name, input, cwd, z2, ownPrefix) {
  if (name.startsWith(ownPrefix)) {
    const files = Array.isArray(input.files) ? input.files.filter((f) => typeof f === "string") : [];
    for (const f of files) {
      const why = forbiddenPath(f, cwd, z2);
      if (why) return why;
    }
    return void 0;
  }
  if (SHELL_TOOLS.has(name)) return typeof input.command === "string" ? forbiddenText(input.command, z2) : void 0;
  if (FILE_TOOLS.has(name)) {
    for (const k2 of PATH_KEYS2) {
      const v = input[k2];
      if (typeof v === "string" && v) {
        const why = forbiddenPath(v, cwd, z2);
        if (why) return why;
      }
    }
    for (const k2 of PATTERN_KEYS) {
      const v = input[k2];
      if (typeof v === "string" && v) {
        const why = forbiddenText(v, z2);
        if (why) return why;
      }
    }
    return void 0;
  }
  if (name.startsWith("mcp__")) {
    for (const s of strings(input)) {
      const why = forbiddenText(s, z2);
      if (why) return why;
    }
  }
  return void 0;
}
function zoneDenyMessage(why) {
  return `\u{1F6AB} \u9019\u500B\u52D5\u4F5C\u78B0\u5230 channelcollab \u7684\u7981\u5340\uFF1A${why}\u3002\u4EFB\u4F55\u6B0A\u9650\u6A21\u5F0F\u90FD\u4E0D\u80FD\u8B80\u5BEB\u9019\u88E1\uFF0C\u4E3B\u4EBA\u7684\u6309\u9215\u4E5F\u89E3\u4E0D\u958B\u3002\u4E0D\u8981\u518D\u8A66\uFF0C\u4E5F\u4E0D\u8981\u63DB\u5225\u7684\u65B9\u6CD5\u7E5E\u904E\uFF1B\u771F\u7684\u9700\u8981\u7684\u8A71\uFF0C\u8ACB\u4E3B\u4EBA\u81EA\u5DF1\u5728\u96FB\u8166\u4E0A\u8655\u7406\u3002`;
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
  return new Promise((resolve2) => execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, () => resolve2()));
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
  const line2 = [o.command.replace(CMD_META, "^$1"), ...o.args.map(escapeCmdArg)].join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line2}"`], {
    cwd: o.cwd,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: true
  });
}

// src/runner/usage.ts
var CONTEXT_THRESHOLDS = [70, 85, 95];
var FOOTER_FROM = 85;
var NOTICE_AT = /* @__PURE__ */ new Set([70, 95]);
function contextAlert(pct, notified) {
  const kept = notified.filter((t) => t <= pct);
  const crossed = CONTEXT_THRESHOLDS.filter((t) => pct >= t && !kept.includes(t));
  const next = [.../* @__PURE__ */ new Set([...kept, ...crossed])].sort((a, b) => a - b);
  const loud = crossed.filter((t) => NOTICE_AT.has(t));
  return loud.length ? { notify: Math.max(...loud), notified: next } : { notified: next };
}
function contextNotice(pct, kind) {
  const clear = kind === "dm" ? "\uFF0C\u6216 !clear \u958B\u65B0\u5C0D\u8A71" : "";
  return pct >= 95 ? `\u{1F9E0} \u4E0A\u4E0B\u6587\u5DF2\u7528 ${pct}%\uFF0C\u5FEB\u6EFF\u4E86\uFF0C\u5EFA\u8B70\u73FE\u5728\u6253 !compact \u58D3\u7E2E${clear}\u3002` : `\u{1F9E0} \u4E0A\u4E0B\u6587\u5DF2\u7528 ${pct}%\uFF0C\u53EF\u4EE5\u6253 !compact \u58D3\u7E2E${clear}\u3002`;
}
function contextFooter(pct) {
  if (pct === void 0 || pct < FOOTER_FROM) return "";
  return `\u{1F9E0} \u4E0A\u4E0B\u6587 ${pct}%${pct >= 95 ? "\uFF0C\u5FEB\u6EFF\u4E86" : ""}\uFF0C\u53EF\u6253 !compact`;
}
function contextFromUsage(usage, window) {
  if (!usage || !window) return void 0;
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (!tokens) return void 0;
  return { pct: Math.round(tokens / window * 100), tokens, max: window };
}
var LABELS = {
  five_hour: "5 \u5C0F\u6642",
  seven_day: "\u6BCF\u9031",
  seven_day_opus: "\u6BCF\u9031 Opus",
  seven_day_sonnet: "\u6BCF\u9031 Sonnet",
  seven_day_overage_included: "\u6BCF\u9031\uFF08\u542B\u52A0\u8CFC\uFF09",
  overage: "\u52A0\u8CFC"
};
var rateLabel = (type) => LABELS[type] ?? type;
function rateWindows(info) {
  const out = [];
  for (const [type, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w && typeof w === "object") out.push({ type, utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: w.status, surpassedThreshold: num(w.surpassedThreshold) });
  }
  if (!out.length && info.rateLimitType) {
    out.push({ type: info.rateLimitType, utilization: num(info.utilization), resetsAt: num(info.resetsAt), status: info.status, surpassedThreshold: num(info.surpassedThreshold) });
  }
  return out;
}
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var pctOf = (u) => Math.round(u * 100);
function formatReset(resetsAt, now = Date.now()) {
  if (!resetsAt) return "";
  const d = new Date(resetsAt * 1e3);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function level(w) {
  if (w.status === "rejected") return 100;
  if (w.utilization !== void 0 && w.utilization >= 0.95) return 95;
  if (w.utilization !== void 0 && w.utilization >= 0.8) return 80;
  if (w.status === "allowed_warning") return 1;
  return 0;
}
function rateAlerts(info, notified, now = Date.now()) {
  const out = [];
  const windows = rateWindows(info);
  for (const w of windows) {
    const lv = level(w);
    const prev = notified.get(w.type);
    const fresh = !prev || prev.resetsAt !== w.resetsAt;
    if (fresh || lv < prev.level) notified.set(w.type, { level: Math.min(lv, fresh ? 0 : lv), resetsAt: w.resetsAt });
    const cur = notified.get(w.type);
    if (lv <= cur.level || lv === 0) continue;
    cur.level = lv;
    const when = formatReset(w.resetsAt, now);
    const reset = when ? `\uFF0C\u7D04 ${when} \u91CD\u7F6E` : "";
    if (lv === 100) out.push(`\u26D4 ${rateLabel(w.type)}\u984D\u5EA6\u5DF2\u7528\u5B8C${reset}${when ? "\uFF0C\u5230\u6642\u518D\u8A66" : ""}\u3002`);
    else if (lv === 1) out.push(`\u26A0\uFE0F ${rateLabel(w.type)}\u984D\u5EA6\u63A5\u8FD1\u4E0A\u9650${reset}\u3002`);
    else out.push(`\u26A0\uFE0F ${rateLabel(w.type)}\u984D\u5EA6\u5DF2\u7528 ${pctOf(w.utilization)}%${reset}\u3002`);
  }
  if (info.status === "rejected" && !out.some((l) => l.startsWith("\u26D4")) && !windows.some((w) => w.status === "rejected")) {
    const key = `rejected:${info.rateLimitType ?? "-"}`;
    if (notified.get(key)?.resetsAt !== info.resetsAt) {
      notified.set(key, { level: 100, resetsAt: info.resetsAt });
      const when = formatReset(info.resetsAt, now);
      out.push(`\u26D4 ${info.rateLimitType ? rateLabel(info.rateLimitType) : ""}\u984D\u5EA6\u5DF2\u7528\u5B8C${when ? `\uFF0C\u7D04 ${when} \u91CD\u7F6E\uFF0C\u5230\u6642\u518D\u8A66` : ""}\u3002`);
    }
  }
  return out;
}
function rateSummary(info, now = Date.now()) {
  if (!info) return "\u672A\u77E5\uFF08\u9019\u6B21\u555F\u52D5\u5F8C\u9084\u6C92\u6536\u5230\u984D\u5EA6\u8CC7\u8A0A\uFF0C\u8DD1\u904E\u4E00\u8F2A\u5F8C\u518D\u770B\uFF09";
  const parts = rateWindows(info).map((w) => {
    const used = w.utilization !== void 0 ? `${pctOf(w.utilization)}%` : w.status === "rejected" ? "\u5DF2\u7528\u5B8C" : w.status === "allowed_warning" ? "\u63A5\u8FD1\u4E0A\u9650" : "\u6B63\u5E38";
    const when = formatReset(w.resetsAt, now);
    return `${rateLabel(w.type)} ${used}${when ? `\uFF08${when} \u91CD\u7F6E\uFF09` : ""}`;
  });
  const state2 = info.status === "rejected" ? "\u26D4 \u76EE\u524D\u88AB\u9650\u5236" : info.status === "allowed_warning" ? "\u26A0\uFE0F \u63A5\u8FD1\u4E0A\u9650" : "\u6B63\u5E38";
  return parts.length ? `${state2}\uFF1A${parts.join("\u3001")}` : state2;
}
var latestRate;
var rateNotified = /* @__PURE__ */ new Map();
function recordRateLimit(info) {
  latestRate = info;
  return rateAlerts(info, rateNotified);
}
function latestRateLimit() {
  return latestRate;
}

// src/runner/skills.ts
var NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
function validSkillName(name) {
  return NAME.test(name);
}
function skillCatalog(offered, skills = [], terminal = []) {
  const isSkill = new Set(skills);
  const noTerminal = new Set(terminal);
  const seen = /* @__PURE__ */ new Map();
  for (const c of offered) {
    if (!validSkillName(c.name) || noTerminal.has(c.name)) continue;
    if (c.builtin && !isSkill.has(c.name)) continue;
    if (!seen.has(c.name)) seen.set(c.name, { name: c.name, description: (c.description ?? "").trim(), hint: (c.argumentHint ?? "").trim() });
  }
  for (const s of skills) if (validSkillName(s) && !noTerminal.has(s) && !seen.has(s)) seen.set(s, { name: s, description: "", hint: "" });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
var MAX_CHOICES = 25;
var NO_LIST = "__none__";
var NO_LIST_TEXT = "\u5148\u50B3\u4E00\u5247\u8A0A\u606F\u958B\u59CB\u5C0D\u8A71\uFF0C\u4E4B\u5F8C\u5C31\u80FD\u9078 skill";
function skillChoices(list, typed) {
  if (!list?.length) return [{ name: NO_LIST_TEXT, value: NO_LIST }];
  const q = typed.trim().toLowerCase().replace(/^\//, "");
  const score = (s) => !q ? 1 : s.name.toLowerCase().startsWith(q) ? 0 : s.name.toLowerCase().includes(q) ? 1 : s.description.toLowerCase().includes(q) ? 2 : 3;
  return list.map((s) => ({ s, n: score(s) })).filter((x) => x.n < 3).sort((a, b) => a.n - b.n || a.s.name.localeCompare(b.s.name)).slice(0, MAX_CHOICES).map(({ s }) => {
    const label2 = s.description ? `${s.name} \u2014 ${s.description.replace(/\s+/g, " ")}` : s.name;
    return { name: label2.length > 100 ? `${label2.slice(0, 99)}\u2026` : label2, value: s.name };
  });
}
var MAX_SKILL_ARGS = 1500;
function skillPrompt(list, name, args = "") {
  if (!list?.length) return { ok: false, reason: "no-list" };
  const n = name.trim().replace(/^\//, "");
  if (n === NO_LIST || !validSkillName(n) || !list.some((s) => s.name === n)) return { ok: false, reason: "unknown" };
  const a = args.replace(/\s+/g, " ").trim().slice(0, MAX_SKILL_ARGS);
  return { ok: true, prompt: a ? `/${n} ${a}` : `/${n}` };
}

// src/runner/turn-clock.ts
var WARN_BEFORE_MS = 5 * 60 * 1e3;
var TurnClock = class {
  /** `limitMs` 0 (or less) means no limit: neither callback ever fires. */
  constructor(limitMs, onTimeout, onWarn, warnBeforeMs = WARN_BEFORE_MS) {
    this.limitMs = limitMs;
    this.onTimeout = onTimeout;
    this.onWarn = onWarn;
    this.remaining = limitMs;
    this.warnAt = limitMs > 0 && onWarn && limitMs >= 2 * warnBeforeMs ? warnBeforeMs : -1;
  }
  limitMs;
  onTimeout;
  onWarn;
  remaining;
  warnAt;
  started = 0;
  timer;
  warnTimer;
  running = false;
  done = false;
  get limited() {
    return this.limitMs > 0;
  }
  /** Working time left (ms); Infinity without a limit. */
  get left() {
    if (!this.limited) return Infinity;
    return Math.max(0, this.remaining - (this.running ? Date.now() - this.started : 0));
  }
  /** Start or continue counting. */
  resume() {
    if (!this.limited || this.running || this.done) return;
    this.running = true;
    this.started = Date.now();
    this.timer = setTimeout(() => {
      this.done = true;
      this.clear();
      this.onTimeout();
    }, this.remaining);
    this.timer.unref?.();
    if (this.warnAt > 0 && this.remaining > this.warnAt) {
      this.warnTimer = setTimeout(() => {
        this.warnAt = -1;
        this.onWarn?.();
      }, this.remaining - this.warnAt);
      this.warnTimer.unref?.();
    }
  }
  /** Stop counting while someone is being waited for. */
  pause() {
    if (!this.running) return;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
    this.clear();
  }
  /** The turn ended: nothing fires after this. */
  stop() {
    this.done = true;
    this.clear();
  }
  clear() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.warnTimer);
    this.timer = this.warnTimer = void 0;
  }
};
function limitLabel(ms) {
  if (!ms || ms <= 0) return "\u4E0D\u9650";
  if (ms < 6e4) return `${Math.round(ms / 1e3)} \u79D2`;
  const min = Math.round(ms / 6e4);
  const h = Math.floor(min / 60);
  return h ? `${h} \u5C0F\u6642${min % 60 ? ` ${min % 60} \u5206` : ""}` : `${min} \u5206\u9418`;
}
function timeoutNotice(limitMs, kind, who = {}) {
  const users = kind === "dm" ? [] : [who.requesterId, who.ownerId].filter((v, i, a) => !!v && a.indexOf(v) === i);
  const at = users.map((u) => `<@${u}>`).join(" ");
  return {
    content: `${at ? `${at} ` : ""}\u23F1\uFE0F \u9019\u4E00\u8F2A\u5DE5\u4F5C\u8D85\u904E ${limitLabel(limitMs)}\u7684\u4E0A\u9650\uFF0C\u5DF2\u505C\u6B62\uFF08\u4E0D\u662F\u88AB\u64CB\u4E0B\uFF09\u3002\u5C0D\u8A71\u5DF2\u4FDD\u5B58\uFF0C\u56DE\u8986\u300C\u7E7C\u7E8C\u300D\u5C31\u6703\u63A5\u8457\u505A\u3002\u8981\u8ABF\u6574\u4E0A\u9650\u8ACB\u6539\u8A2D\u5B9A\u7684 turn_timeout_minutes\uFF080 \u4EE3\u8868\u4E0D\u9650\uFF09\u3002`,
    users
  };
}
function maxTurnsNotice(maxTurns, kind, who = {}) {
  const users = kind === "dm" ? [] : [who.requesterId, who.ownerId].filter((v, i, a) => !!v && a.indexOf(v) === i);
  const at = users.map((u) => `<@${u}>`).join(" ");
  return {
    content: `${at ? `${at} ` : ""}\u23F9\uFE0F \u9019\u4E00\u8F2A\u5DF2\u9054 ${maxTurns > 0 ? `${maxTurns} \u6B65` : "\u6B65\u6578"}\u4E0A\u9650\uFF0C\u5DF2\u505C\u6B62\uFF08\u4E0D\u662F\u88AB\u64CB\u4E0B\uFF09\u3002\u5C0D\u8A71\u5DF2\u4FDD\u5B58\uFF0C\u56DE\u8986\u300C\u7E7C\u7E8C\u300D\u5C31\u6703\u63A5\u8457\u505A\u3002\u8981\u8ABF\u6574\u4E0A\u9650\u8ACB\u6539\u8A2D\u5B9A\u7684 max_turns\uFF080 \u4EE3\u8868\u4E0D\u9650\uFF09\u3002`,
    users
  };
}
function timeoutWarning(limitMs, leftMs) {
  return `\u23F3 \u9019\u4E00\u8F2A\u5FEB\u5230 ${limitLabel(limitMs)}\u7684\u5DE5\u4F5C\u4E0A\u9650\u4E86\uFF08\u5269\u7D04 ${Math.max(1, Math.round(leftMs / 6e4))} \u5206\u9418\uFF09\u3002\u6642\u9593\u5230\u6703\u505C\u6B62\u9019\u4E00\u8F2A\uFF0C\u5C0D\u8A71\u6703\u4FDD\u5B58\u3002`;
}
var TIMEOUT_TOOL_MESSAGE = "This turn hit its working-time limit and is being stopped by the bot. Do not call any more tools and do not reply; the bot tells the people in the conversation itself.";

// src/runner/session.ts
var OWN_PREFIX = "mcp__channelcollab__";
var REPLY_TOOL = `${OWN_PREFIX}reply`;
var POST_TOOL = `${OWN_PREFIX}post_to_channel`;
var BUSY_CLOSE_WAIT_MS = 10 * 60 * 1e3;
var INTERRUPT_GRACE_MS = 30 * 1e3;
var CLOSE_GRACE_MS = 15 * 1e3;
var MAX_REPLY_FILES = 10;
function guidelines(selfId, auto, kind = "thread", targets = "") {
  let configured;
  try {
    configured = loadConfig().discord.owner_id;
  } catch {
  }
  const dm = kind === "dm";
  const where = dm ? "\u79C1\u8A0A" : "\u8A0E\u8AD6\u4E32";
  return [
    dm ? "\u4F60\u6B63\u5728 Discord \u79C1\u8A0A\u88E1\u548C\u4F60\u7684\u4E3B\u4EBA\u4E00\u5C0D\u4E00\u5C0D\u8A71\uFF08\u4E3B\u4EBA\u53EF\u80FD\u5728\u624B\u6A5F\u4E0A\uFF0C\u9060\u7AEF\u8ACB\u4F60\u5728\u9019\u53F0\u96FB\u8166\u4E0A\u505A\u4E8B\uFF09\u3002\u6BCF\u5247\u4F7F\u7528\u8005\u8A0A\u606F\u6703\u6A19\u793A\u767C\u8A71\u8005\u8207\u4F4D\u7F6E\u3002" : "\u4F60\u6B63\u5728\u4E00\u500B Discord \u8A0E\u8AD6\u4E32\u88E1\u548C\u4EBA\u5354\u4F5C\uFF0C\u8A0E\u8AD6\u4E32\u88E1\u53EF\u80FD\u9084\u6709\u5176\u4ED6\u4EBA\u7684 Bot\u3002\u6BCF\u5247\u4F7F\u7528\u8005\u8A0A\u606F\u6703\u6A19\u793A\u767C\u8A71\u8005\u3001\u4F4D\u7F6E\u548C\u6700\u8FD1\u7684\u5C0D\u8A71\u3002",
    `- \u4F60\u7684\u4E00\u822C\u6587\u5B57\u8F38\u51FA\u6C92\u6709\u4EBA\u770B\u5F97\u5230\uFF1B\u8981\u8B93\u4EBA\u770B\u5230\u7684\u5167\u5BB9\uFF0C\u4E00\u5F8B\u547C\u53EB ${REPLY_TOOL} \u5DE5\u5177\u3002`,
    dm ? "- \u56DE\u8986\u8981\u7C21\u77ED\uFF0C\u53EA\u8B1B\u7D50\u8AD6\uFF08\u4E3B\u4EBA\u591A\u534A\u5728\u624B\u6A5F\u4E0A\u770B\uFF09\uFF1B\u505A\u4E86\u4FEE\u6539\u5C31\u8AAA\u660E\u6539\u4E86\u4EC0\u9EBC\u3002" : "- \u56DE\u8986\u8981\u7C21\u77ED\uFF0C\u53EA\u8B1B\u7D50\u8AD6\uFF1B\u505A\u4E86\u4FEE\u6539\u5C31\u8AAA\u660E\u6539\u4E86\u4EC0\u9EBC\u3002",
    auto ? `- \u9019\u500B${dm ? "\u79C1\u8A0A" : "\u983B\u9053"}\u7528\u81EA\u52D5\u6A21\u5F0F\uFF1A\u52D5\u4F5C\u7531 Claude Code \u81EA\u52D5\u5224\u65B7\uFF1B\u88AB\u81EA\u52D5\u6A21\u5F0F\u64CB\u4E0B\u7684\u52D5\u4F5C\u6703\u6539\u5728 Discord \u4E0A\u8ACB Bot \u7684\u4E3B\u4EBA\u6C7A\u5B9A\uFF0C\u7B49\u5F85\u671F\u9593\u4E0D\u5FC5\u53E6\u5916\u8AAA\u660E\u3002\u4E4B\u5F8C\u82E5\u88AB\u544A\u77E5\u53EF\u4EE5\u91CD\u8A66\u9019\u500B\u547C\u53EB\uFF0C\u4EE3\u8868\u4E3B\u4EBA\u5DF2\u7D93\u56DE\u8986\uFF1A\u8ACB\u7528\u5B8C\u5168\u76F8\u540C\u7684\u53C3\u6578\u91CD\u8A66\u4E00\u6B21\uFF08\u4E0D\u8981\u6539\u6307\u4EE4\uFF09\uFF1B\u82E5\u7D50\u679C\u662F\u4E3B\u4EBA\u62D2\u7D55\uFF0C\u7167\u62D2\u7D55\u7406\u7531\u8ABF\u6574\u505A\u6CD5\uFF0C\u4E0D\u8981\u518D\u8A66\u3002` : "- \u9700\u8981\u6B0A\u9650\u7684\u5DE5\u5177\u6703\u5728 Discord \u4E0A\u8ACB Bot \u7684\u4E3B\u4EBA\u6838\u51C6\uFF0C\u7B49\u5F85\u671F\u9593\u4E0D\u5FC5\u53E6\u5916\u8AAA\u660E\u3002\u88AB\u62D2\u7D55\u6642\u7167\u62D2\u7D55\u7406\u7531\u8ABF\u6574\u505A\u6CD5\uFF0C\u4E0D\u8981\u539F\u6A23\u91CD\u8A66\u3002",
    "- \u6B0A\u9650\u8ACB\u6C42\u7684\u7D50\u679C\u82E5\u662F\u300C\u4E3B\u4EBA\u66AB\u6642\u4E0D\u5728\u2026\u5DF2\u6392\u5165\u5F85\u6838\u51C6\u6E05\u55AE\u300D\uFF1A\u4E0D\u8981\u91CD\u8A66\u540C\u4E00\u500B\u52D5\u4F5C\uFF1B\u6539\u7528\u4E0D\u9700\u8981\u6B0A\u9650\u7684\u65B9\u5F0F\u628A\u80FD\u505A\u7684\u505A\u5B8C\uFF0C\u505A\u4E0D\u5230\u7684\u90E8\u5206\u5728 reply \u88E1\u6574\u7406\u6210\u300C\u5F85\u4E3B\u4EBA\u6838\u51C6\u300D\uFF08\u8981\u505A\u4EC0\u9EBC\u3001\u70BA\u4EC0\u9EBC\uFF09\uFF0C\u7136\u5F8C\u7D50\u675F\u9019\u4E00\u8F2A\u3002\u4E3B\u4EBA\u6838\u51C6\u5F8C\u6703\u518D\u544A\u8A34\u4F60\uFF0C\u5230\u6642\u7528\u76F8\u540C\u53C3\u6578\u57F7\u884C\u3002",
    "- \u88AB\u300C\u7981\u5340\u300D\u64CB\u4E0B\u7684\u52D5\u4F5C\uFF08channelcollab \u7684\u8CC7\u6599\u593E\u3001.ssh\u3001.env\u3001Claude \u7684\u767B\u5165\u8CC7\u6599\uFF09\u4EFB\u4F55\u60C5\u6CC1\u90FD\u4E0D\u80FD\u505A\uFF0C\u4E0D\u8981\u518D\u8A66\uFF0C\u4E5F\u4E0D\u8981\u63DB\u65B9\u6CD5\u7E5E\u904E\u3002",
    "- \u9700\u8981\u4F7F\u7528\u8005\u505A\u9078\u64C7\u6642\uFF0C\u53EF\u4EE5\u7528 AskUserQuestion \u5DE5\u5177\uFF0C\u9078\u9805\u6703\u4EE5\u6309\u9215\u6216\u9078\u55AE\u5448\u73FE\u5728 Discord \u4E0A\u3002",
    dm ? "- \u9700\u8981\u4E3B\u4EBA\u597D\u597D\u601D\u8003\u7684\u6C7A\u7B56\uFF08\u4F8B\u5982\u65B9\u5411\u3001\u53D6\u6368\u3001\u5F71\u97FF\u7BC4\u570D\u5927\u7684\u6539\u52D5\uFF09\uFF0C\u76F4\u63A5\u5728 reply \u88E1\u554F\u4E3B\u4EBA\uFF0C\u4E0D\u8981\u81EA\u5DF1\u6C7A\u5B9A\u3002" : "- \u9700\u8981\u4E3B\u4EBA\u597D\u597D\u601D\u8003\u7684\u6C7A\u7B56\uFF08\u4F8B\u5982\u65B9\u5411\u3001\u53D6\u6368\u3001\u5F71\u97FF\u7BC4\u570D\u5927\u7684\u6539\u52D5\uFF09\uFF0C\u5728 reply \u88E1 @ \u4E3B\u4EBA\uFF0C\u8ACB\u4E3B\u4EBA\u6C7A\u5B9A\uFF0C\u4E0D\u8981\u81EA\u5DF1\u6C7A\u5B9A\u3002",
    "- \u4F7F\u7528\u8005\u9644\u7684\u6A94\u6848\u6703\u4E0B\u8F09\u5230\u672C\u6A5F\uFF0C\u8DEF\u5F91\u5BEB\u5728\u8A0A\u606F\u7684\u3010\u9644\u4EF6\u3011\u88E1\uFF0C\u7528 Read \u8B80\u53D6\u3002",
    `- \u8981\u628A\u6A94\u6848\u50B3\u5230${where}\uFF0C\u547C\u53EB ${REPLY_TOOL} \u6642\u5728 files \u5E36\u672C\u6A5F\u8DEF\u5F91\uFF08\u53EA\u80FD\u662F\u5DE5\u4F5C\u76EE\u9304\u6216\u9644\u4EF6\u8CC7\u6599\u593E\u5E95\u4E0B\u7684\u6A94\u6848\uFF09\u3002`,
    postGuideline(targets),
    rosterPrompt(selfId, botOwner(configured, selfId), void 0, { dm })
  ].join("\n");
}
function postGuideline(targets) {
  if (!targets.trim()) return `- ${POST_TOOL} \u53EF\u4EE5\u628A\u7D50\u679C\u8CBC\u5230\u9019\u96BB Bot \u7D81\u5B9A\u7684\u5718\u968A\u983B\u9053\uFF0C\u4F46\u76EE\u524D\u6C92\u6709\u7D81\u5B9A\u4EFB\u4F55\u983B\u9053\uFF0C\u6240\u4EE5\u4E0D\u80FD\u7528\u3002`;
  return [
    `- \u4F7F\u7528\u8005\u8981\u4F60\u300C\u56DE\u5831\u5230\u7FA4\u7D44\u300D\u300C\u8CBC\u5230\u983B\u9053\u300D\u6642\uFF0C\u7528 ${POST_TOOL}\uFF08\u4E0D\u662F reply\uFF09\uFF1Achannel \u586B\u4E0B\u9762\u7684\u983B\u9053 ID \u6216\u540D\u7A31\uFF1B\u8981\u958B\u65B0\u8A0E\u8AD6\u4E32\u5C31 new_thread: true \u4E26\u7D66 thread_title\uFF1B\u4E5F\u53EF\u4EE5\u7528 thread \u6307\u5B9A\u90A3\u500B\u983B\u9053\u5E95\u4E0B\u65E2\u6709\u7684\u8A0E\u8AD6\u4E32\u3002\u53EA\u80FD\u8CBC\u5230\u4E0B\u9762\u9019\u4E9B\u983B\u9053\uFF08\u6216\u5B83\u5011\u5E95\u4E0B\u7684\u8A0E\u8AD6\u4E32\uFF09\u3002\u8CBC\u51FA\u53BB\u524D\u5148\u6574\u7406\u6210\u7D66\u5718\u968A\u770B\u7684\u6458\u8981\uFF1BBot \u6703\u81EA\u5DF1\u6A19\u660E\u662F\u8AB0\u7684\u5DE5\u4F5C\u56DE\u5831\u3002`,
    `  \u4E0D\u662F\u4E3B\u4EBA\u672C\u4EBA\u8981\u6C42\u7684\u6642\u5019\uFF0C\u9019\u500B\u5DE5\u5177\u8981\u4E3B\u4EBA\u6309\u6309\u9215\u6838\u51C6\u3002\u8CBC\u5B8C\u518D\u7528 reply \u7C21\u77ED\u544A\u8A34\u9019\u88E1\u7684\u4EBA\u8CBC\u5230\u54EA\u88E1\uFF08\u9644\u4E0A\u9023\u7D50\uFF09\u3002`,
    `  \u53EF\u4EE5\u8CBC\u7684\u983B\u9053\uFF1A${targets}`
  ].join("\n");
}
function modeDenyMessage(mode, toolName) {
  if (mode === "plan") return `\u76EE\u524D\u662F\u8A08\u756B\u6A21\u5F0F\uFF08\u4E3B\u4EBA\u6253\u4E86 !plan\uFF09\uFF1A\u53EA\u8A0E\u8AD6\u3001\u4E0D\u52D5\u624B\uFF0C\u4E0D\u80FD\u57F7\u884C ${toolName}\u3002\u8ACB\u7528 reply \u628A\u4F60\u7684\u8A08\u756B\u8AAA\u660E\u7D66\u4E3B\u4EBA\uFF0C\u7B49\u4E3B\u4EBA\u518D\u6253\u4E00\u6B21 !plan \u5207\u56DE\u5F8C\u518D\u52D5\u624B\u3002`;
  return `\u9019\u500B\u983B\u9053\u7684\u6B0A\u9650\u6A21\u5F0F\uFF08${mode}\uFF09\u4E0D\u5141\u8A31\u57F7\u884C ${toolName}\u3002`;
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
  for (const [k2, v] of Object.entries(source)) {
    if (SESSION_ENV.has(k2.toUpperCase()) || k2 === "ANTHROPIC_API_KEY" || k2 === "ANTHROPIC_AUTH_TOKEN") continue;
    env[k2] = v;
  }
  return env;
}
function checkFiles(files, roots, zones) {
  const ok = [];
  const rejected = [];
  const realRoots = roots.filter((r) => existsSync4(r)).map((r) => realpathSync(r));
  for (const f of files) {
    try {
      const real = realpathSync(path6.resolve(roots[0], f));
      const zone = forbiddenPath(real, roots[0], zones);
      if (zone) rejected.push(`${f}: no-go zone (${zone})`);
      else if (!inside(real, realRoots)) rejected.push(`${f}: not under the working directory or the attachment folder`);
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
  constructor(threadId, selfId, channel, resume, costBase, alwaysAllowed = [], kind = "thread", targets = "") {
    this.threadId = threadId;
    this.kind = kind;
    this.tag = `live ${threadId}`;
    this.sessionId = resume;
    this.cost = costBase;
    this.alwaysAllowed = new Set(alwaysAllowed);
    this.mode = channel.permissionMode;
    this.cwd = channel.cwd;
    this.turnTimeoutMs = channel.turnTimeoutMs;
    const roots = [channel.cwd, path6.join(INBOX_DIR, threadId)];
    const zones = { homes: [DATA_DIR], allow: [roots[1]] };
    const server = createSdkMcpServer({
      name: "channelcollab",
      version: "0.1.0",
      alwaysLoad: true,
      tools: [
        tool(
          "reply",
          `Send a message to ${kind === "dm" ? "your owner in the current Discord direct message" : "the people in the current Discord thread"}. This is the only way anyone sees what you say. Optionally attach local files (under the working directory or the attachment folder).`,
          {
            text: z.string().describe("Message text (Markdown)"),
            files: z.array(z.string()).optional().describe("Local file paths to upload with the message")
          },
          async ({ text, files }) => {
            const t = this.turn;
            const checked = checkFiles(files ?? [], roots, zones);
            log("reply", `${threadId} ${brief(text, 300)}${files?.length ? ` files=${JSON.stringify(checked.ok)} rejected=${JSON.stringify(checked.rejected)}` : ""}`);
            if (!t) return { content: [{ type: "text", text: "Not delivered: no active turn." }], isError: true };
            if (t.timedOut) return { content: [{ type: "text", text: `Not delivered. ${TIMEOUT_TOOL_MESSAGE}` }], isError: true };
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
        ),
        tool(
          "post_to_channel",
          `Post a report to one of the team channels this bot is bound to (or a thread under one), e.g. when asked to "report to the group". Not for answering here: use reply for that. Needs the owner's approval unless the owner asked for this turn. Channels: ${targets || "(none bound)"}`,
          {
            channel: z.string().describe("Bound channel: its ID or its name (#name)"),
            text: z.string().describe("Message text (Markdown); the bot adds who the report is from"),
            files: z.array(z.string()).optional().describe("Local file paths to attach (under the working directory or the attachment folder)"),
            thread: z.string().optional().describe("An existing thread under that channel (thread ID) to post in instead"),
            new_thread: z.boolean().optional().describe("Open a new thread in the channel for this report"),
            thread_title: z.string().optional().describe("Title of the new thread (with new_thread)")
          },
          async ({ channel: target, text, files, thread, new_thread, thread_title }) => {
            const t = this.turn;
            if (!t) return { content: [{ type: "text", text: "Not posted: no active turn." }], isError: true };
            if (t.timedOut) return { content: [{ type: "text", text: `Not posted. ${TIMEOUT_TOOL_MESSAGE}` }], isError: true };
            if (!t.postToChannel) return { content: [{ type: "text", text: "Not posted: posting to channels is not available here." }], isError: true };
            const checked = checkFiles(files ?? [], roots, zones);
            const newThread = new_thread ? (thread_title?.trim() || text.split("\n")[0].replace(/[#*_`>]/g, "").trim() || "Claude \u56DE\u5831").slice(0, 100) : void 0;
            log("post", `${threadId} -> ${target}${thread ? ` thread=${thread}` : ""}${newThread ? ` new thread "${newThread}"` : ""} ${brief(text, 200)}${files?.length ? ` files=${JSON.stringify(checked.ok)} rejected=${JSON.stringify(checked.rejected)}` : ""}`);
            const r = await t.postToChannel({ channel: target, text, files: checked.ok, thread, newThread }).catch((e) => ({ ok: false, error: e.message }));
            if (!r.ok) return { content: [{ type: "text", text: `Not posted: ${r.error}` }], isError: true };
            const note = checked.rejected.length ? ` Not attached: ${checked.rejected.join("; ")}` : "";
            return { content: [{ type: "text", text: `Posted to ${r.where}: ${r.url}.${note}` }] };
          }
        )
      ]
    });
    const preToolUse = async (hookInput, toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const name = hookInput.tool_name;
      const toolInput = hookInput.tool_input ?? {};
      const effort = hookInput.effort?.level;
      if (effort) this.effortActual = effort;
      if (this.turn?.timedOut) {
        log("permission", `${threadId} deny ${name} (turn timeout) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: TIMEOUT_TOOL_MESSAGE } };
      }
      const zone = forbiddenUse(name, toolInput, channel.cwd, zones, OWN_PREFIX);
      if (zone) {
        this.turn?.denials.push(name);
        log("permission", `${threadId} deny ${name} (no-go zone: ${zone}) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: zoneDenyMessage(zone) } };
      }
      const retry = this.turn?.retries.get(retryKey(name, toolInput));
      if (retry) {
        this.turn?.retries.delete(retryKey(name, toolInput));
        log("permission", `${threadId} retry ${"deny" in retry ? "deny" : "allow"} ${name} (owner answered: classifier block or approve-later) id=${toolUseId ?? "-"}`);
        return "deny" in retry ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: retry.deny } } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "approved by the owner after an auto mode block" } };
      }
      if (name === POST_TOOL) {
        const p = decidePost(this.mode, !!this.turn?.ownerTriggered);
        log("permission", `${threadId} ${p.kind} ${name} (${p.why}) id=${toolUseId ?? "-"}`);
        if (p.kind === "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: p.why } };
        if (p.kind === "deny") {
          this.turn?.denials.push(name);
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: modeDenyMessage(this.mode, name) } };
        }
        const answer2 = await this.ask(name, toolInput, toolUseId ?? "", signal);
        return answer2.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer2.message } } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "approved by the owner" } };
      }
      const d = decideTool(name, toolInput, { mode: this.mode, roots, alwaysAllowed: this.alwaysAllowed, ownPrefix: OWN_PREFIX });
      if (d.kind === "cli") return {};
      if (d.kind === "allow") {
        if (!name.startsWith(OWN_PREFIX)) log("permission", `${threadId} auto-allow ${name} (${d.why}) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: d.why } };
      }
      if (d.kind === "deny") {
        this.turn?.denials.push(name);
        log("permission", `${threadId} deny ${name} (${d.why}) id=${toolUseId ?? "-"}`);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: modeDenyMessage(this.mode, name) } };
      }
      const answer = await this.ask(name, toolInput, toolUseId ?? "", signal);
      return answer.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.message } } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "approved by the owner" } };
    };
    const permissionDenied = async (hookInput, toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== "PermissionDenied") return {};
      const t = this.turn;
      if (!t || blockedByClassifier(this.mode) !== "ask") return {};
      const name = hookInput.tool_name;
      const toolInput = hookInput.tool_input ?? {};
      log("permission", `${threadId} classifier blocked ${name} (${brief(hookInput.reason, 200)}) id=${toolUseId ?? hookInput.tool_use_id}`);
      const answer = await this.ask(name, toolInput, toolUseId ?? hookInput.tool_use_id, signal, hookInput.reason ?? "");
      if (t.stoppedBy || this.turn !== t) return {};
      t.retries.set(retryKey(name, toolInput), answer.behavior === "deny" ? { deny: answer.message } : { allow: true });
      return { hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } };
    };
    const canUseTool = async (toolName, input, { signal, toolUseID }) => {
      if (toolName === POST_TOOL && !this.turn?.ownerTriggered) {
        if (this.mode === "plan" || this.mode === "dontAsk") return { behavior: "deny", message: modeDenyMessage(this.mode, toolName) };
        const answer = await this.ask(toolName, input, toolUseID, signal);
        return answer.behavior === "deny" ? { behavior: "deny", message: answer.message } : { behavior: "allow", updatedInput: input };
      }
      if (toolName.startsWith(OWN_PREFIX)) return { behavior: "allow", updatedInput: input };
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
    const hookTimeout = Math.ceil(channel.permissionTimeoutMs / 1e3) + 60;
    log(this.tag, `start kind=${kind} cwd=${channel.cwd} model=${channel.model ?? "-"} mode=${channel.permissionMode} launcher=${channel.launcher || "builtin"} resume=${resume ?? "-"} turn_limit=${limitLabel(this.turnTimeoutMs)} max_turns=${channel.maxTurns || "none"} always=${JSON.stringify([...this.alwaysAllowed])}`);
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
        systemPrompt: { type: "preset", preset: "claude_code", append: guidelines(selfId, (channel.basePermissionMode ?? channel.permissionMode) === "auto", kind, targets) },
        ...channel.effort ? { effort: channel.effort } : {},
        allowedTools: [REPLY_TOOL],
        mcpServers: { channelcollab: server },
        // The hooks await the owner's answer in-process, so their timeout (seconds) must outlast the prompt's.
        // PermissionDenied is always registered: !plan can switch an auto session out of auto and back.
        hooks: {
          PreToolUse: [{ hooks: [preToolUse], timeout: hookTimeout }],
          PermissionDenied: [{ hooks: [permissionDenied], timeout: hookTimeout }]
        },
        canUseTool,
        // max_turns (counted per user message in streaming mode, spike/live-check.ts): off by default, so not sent.
        ...channel.maxTurns > 0 ? { maxTurns: channel.maxTurns } : {},
        abortController: this.abort,
        stderr: onStderr,
        ...resume ? { resume } : {},
        // A resumed CLI reuses the system prompt it recorded first (--system-prompt-snapshot on). A session
        // handed over from the computer recorded the computer's prompt, without these guidelines; rendering
        // it fresh keeps the bot's rules (and roster changes) in effect (spike/v017-snapshot.ts).
        ...resume ? { extraArgs: { "system-prompt-snapshot": "off" } } : {}
      }
    });
    this.done = this.read();
  }
  threadId;
  kind;
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
  /** Usage of the last main-thread API call, and the context window from the last result (fallback for contextUsage). */
  lastUsage;
  contextWindow;
  /** Permission mode in effect now (!plan switches it); the hooks read this. */
  mode;
  /** When this process was started (for !status). */
  startedAt = Date.now();
  cwd;
  /** Working time per turn before it is stopped; 0 = no limit. */
  turnTimeoutMs;
  /** Effort the CLI reports for the current turn (PreToolUse hook input), for !status. */
  effortActual;
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
  /** Switch the model for the following responses (!model); the session keeps running. */
  async setModel(model) {
    await this.q.setModel(model);
    log(this.tag, `model set to ${model}`);
  }
  /** Switch the permission mode (!plan); the hooks follow it right away. */
  /** Switch the effort level (!effort) for the following turns; null goes back to the model's default. */
  async setEffort(level2) {
    await this.q.applyFlagSettings({ effortLevel: level2 });
    if (!level2) this.effortActual = void 0;
    log(this.tag, `effort set to ${level2 ?? "default"}`);
  }
  async setMode(mode) {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
    log(this.tag, `permission mode set to ${mode}`);
  }
  /**
   * How full the context window is after the last turn: Claude Code's own
   * figure (getContextUsage, the /context numbers), else the last API call's
   * tokens over the model's context window.
   */
  async contextUsage() {
    if (this.usable) {
      try {
        const u = await Promise.race([this.q.getContextUsage({ detail: "summary" }), sleep(5e3).then(() => void 0)]);
        if (u && Number.isFinite(u.percentage)) return { pct: Math.round(u.percentage), tokens: u.totalTokens, max: u.maxTokens };
      } catch (e) {
        log(this.tag, `getContextUsage failed: ${e.message}`);
      }
    }
    return contextFromUsage(this.lastUsage, this.contextWindow);
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
  run(prompt, callbacks, opts = {}) {
    if (this.turn) throw new Error(`${this.tag}: a turn is already running`);
    const n = ++this.turns;
    return new Promise((resolve2) => {
      const t = {
        ...callbacks,
        n,
        started: Date.now(),
        acted: false,
        tools: [],
        denials: [],
        replies: 0,
        lastText: "",
        clock: void 0,
        ownerTriggered: !!opts.ownerTriggered,
        waits: 0,
        abort: new AbortController(),
        retries: /* @__PURE__ */ new Map(),
        resolve: resolve2
      };
      t.clock = new TurnClock(
        this.turnTimeoutMs,
        () => this.onTimeout(t),
        () => {
          log(this.tag, `turn ${n} close to the time limit (${limitLabel(this.turnTimeoutMs)})`);
          t.notice?.(timeoutWarning(this.turnTimeoutMs, t.clock.left)).catch((e) => log(this.tag, `time limit warning failed: ${e.message}`));
        }
      );
      for (const k2 of opts.preapproved ?? []) t.retries.set(k2, { allow: true });
      this.turn = t;
      t.clock.resume();
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
      const limit = CLOSE_GRACE_MS + (this.busy ? BUSY_CLOSE_WAIT_MS : 0);
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
  async ask(toolName, input, toolUseId, signal, blockedReason) {
    const t = this.turn;
    if (!t) return { behavior: "deny", message: "No active turn." };
    log("permission", `${this.threadId} ask ${toolName} id=${toolUseId}${blockedReason !== void 0 ? " (auto mode block)" : ""} ${brief(input)}`);
    const answer = await this.waitFor(() => t.askPermission({ toolName, input, toolUseId, blockedReason, signal: this.linked(signal, t) }));
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
    if (t && t.waits++ === 0) t.clock.pause();
    try {
      return await wait();
    } finally {
      if (t && --t.waits === 0 && this.turn === t) t.clock.resume();
    }
  }
  /**
   * The turn used up its working time (turn_timeout_minutes; off by default).
   * Interrupt it like 🛑 so the session stays and "繼續" picks it up; from now
   * on replies and tools are refused, and the bot posts the notice itself.
   * Only if the turn does not end soon is the session killed.
   */
  onTimeout(t) {
    if (this.turn !== t) return;
    t.timedOut = true;
    log(this.tag, `turn ${t.n} timeout: ${limitLabel(this.turnTimeoutMs)} of work used, interrupting the turn`);
    t.abort.abort();
    this.q.interrupt().catch((e) => log(this.tag, `turn ${t.n} timeout interrupt failed: ${e.message}`));
    t.killTimer = setTimeout(() => {
      if (this.turn !== t) return;
      log(this.tag, `turn ${t.n} timeout: still running ${INTERRUPT_GRACE_MS} ms after the interrupt, killing the session`);
      this.failure = "timeout";
      this.forced = true;
      this.abort.abort();
    }, INTERRUPT_GRACE_MS);
    t.killTimer.unref?.();
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
      if (this.failure === "timeout") error = `timeout (killed after ${limitLabel(this.turnTimeoutMs)} of work; SDK: ${error})`;
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
        this.offered = { skills: msg.skills, terminal: msg.terminal_slash_commands ?? [] };
        this.q.supportedCommands().then((list) => this.recordSkills(list)).catch((e) => {
          log(this.tag, `supportedCommands failed (${e.message}); /skill lists the init skills only`);
          this.recordSkills([]);
        });
      }
      this.sessionId = msg.session_id;
      this.model = msg.model;
    } else if (msg.type === "system" && msg.subtype === "commands_changed") {
      this.recordSkills(msg.commands);
    } else if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      log(this.tag, `rate limit ${brief(info, 400)}`);
      for (const text of recordRateLimit(info)) {
        if (t?.notice) t.notice(text).catch((e) => log(this.tag, `rate limit notice failed: ${e.message}`));
        else log(this.tag, `rate limit notice (no turn to post it): ${text}`);
      }
    } else if (msg.type === "assistant" && t) {
      if (msg.error) t.apiError = msg.error;
      if (msg.parent_tool_use_id === null && msg.message.usage) this.lastUsage = msg.message.usage;
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
  /** What the init message said about skills; the /skill list is built from it and the command list. */
  offered = { skills: [], terminal: [] };
  /** Keep the /skill list for this folder (state.json), for autocomplete before the next session starts. */
  recordSkills(list) {
    const items = skillCatalog(list, this.offered.skills, this.offered.terminal);
    rememberSkills(this.cwd, items);
    log(this.tag, `skills for /skill: ${items.length} (${brief(items.map((s) => s.name).join(" "), 200)})`);
  }
  finishTurn(result, error) {
    const t = this.turn;
    if (!t) {
      if (result) log(this.tag, `result without a turn: ${result.subtype}`);
      return;
    }
    this.turn = void 0;
    t.clock.stop();
    clearTimeout(t.killTimer);
    t.abort.abort();
    this.lastActivity = Date.now();
    const costTotal = result ? result.total_cost_usd : this.cost;
    const turnCost = costTotal >= this.cost ? costTotal - this.cost : costTotal;
    this.cost = costTotal;
    if (result?.session_id) this.sessionId = result.session_id;
    const windowOf = result?.modelUsage && this.model ? result.modelUsage[this.model]?.contextWindow : void 0;
    if (windowOf) this.contextWindow = windowOf;
    if (result?.is_error && !error) {
      error = result.subtype === "success" ? result.result : result.errors?.join("\n");
    }
    const out = {
      ok: !t.timedOut && !!result && result.subtype === "success" && !result.is_error,
      // An interrupted turn ends as error_during_execution; report it as what it was.
      subtype: t.timedOut ? "timeout" : t.stoppedBy && result ? "interrupted" : result?.subtype ?? this.failure ?? "error",
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
      timedOut: t.timedOut,
      error,
      apiError: t.apiError
    };
    log("result", `${this.threadId} turn=${t.n} pid=${this.pid ?? "-"} ok=${out.ok} subtype=${out.subtype} session=${out.sessionId} turns=${out.numTurns} replies=${out.replies} tools=${out.tools.length} denials=${JSON.stringify(out.denials)}${out.stoppedBy ? ` stopped_by=${out.stoppedBy}` : ""}${out.timedOut ? " timeout=true" : ""} turn_cost_usd=${turnCost.toFixed(4)} total_cost_usd=${costTotal.toFixed(4)} duration_ms=${out.durationMs}`);
    t.resolve(out);
  }
};

// src/runner/pool.ts
var SWEEP_MS = 15 * 1e3;
var live = /* @__PURE__ */ new Map();
var closing = /* @__PURE__ */ new Map();
var stopping = false;
var held = /* @__PURE__ */ new Set();
function hold(key) {
  held.add(key);
}
function unhold(key) {
  held.delete(key);
}
var sweeper;
function liveSession(threadId) {
  return live.get(threadId);
}
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
async function acquire(threadId, selfId, channel, resume, costBase, kind = "thread", targets = "") {
  if (stopping) throw new Error("bot is shutting down");
  if (held.has(threadId) || getConversation(threadId)?.takeover) throw new Error("this conversation is taken over on the computer");
  const current = live.get(threadId);
  if (current?.usable) return current;
  if (current) retire(current, "ended");
  await closing.get(threadId);
  if (stopping) throw new Error("bot is shutting down");
  if (held.has(threadId) || getConversation(threadId)?.takeover) throw new Error("this conversation is taken over on the computer");
  const s = new LiveSession(threadId, selfId, channel, resume, costBase, getConversation(threadId)?.alwaysAllow, kind, targets);
  live.set(threadId, s);
  void s.done.then(() => {
    const ts = findSession(threadId, s.sessionId);
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
function release(threadId, reason) {
  const s = live.get(threadId);
  return s ? retire(s, reason) : closing.get(threadId) ?? Promise.resolve();
}
async function closeAll() {
  stopping = true;
  if (sweeper) clearInterval(sweeper);
  const sessions = [...live.values()];
  log("pool", `closing ${sessions.length} live session(s)`);
  await Promise.all([...sessions.map((s) => retire(s, "shutdown", s.busy)), ...closing.values()]);
}

// src/discord/post.ts
import path7 from "node:path";
import { ChannelType, ThreadAutoArchiveDuration } from "discord.js";
function boundTargets(client2, config2) {
  return Object.keys(config2.channels).map((id) => {
    const ch = client2.channels.cache.get(id);
    return { id, name: ch && "name" in ch && ch.name ? ch.name : "" };
  });
}
function targetsLine(targets) {
  return targets.map((t) => t.name ? `#${t.name}\uFF08ID ${t.id}\uFF09` : `\u983B\u9053 ID ${t.id}`).join("\u3001");
}
function resolveTarget(targets, query2) {
  const list = targets.length ? targetsLine(targets) : "\uFF08\u6C92\u6709\u7D81\u5B9A\u4EFB\u4F55\u983B\u9053\uFF09";
  const q = query2.trim().replace(/^<#(\d+)>$/, "$1").replace(/^#/, "").trim();
  if (!q) return { ok: false, error: `\u6C92\u6709\u6307\u5B9A\u983B\u9053\u3002\u53EF\u4EE5\u8CBC\u7684\u983B\u9053\uFF1A${list}` };
  const byId = targets.find((t) => t.id === q);
  if (byId) return { ok: true, id: byId.id };
  const byName = targets.filter((t) => t.name && t.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return { ok: true, id: byName[0].id };
  if (byName.length > 1) return { ok: false, error: `\u6709\u597D\u5E7E\u500B\u983B\u9053\u53EB\u300C${q}\u300D\uFF0C\u8ACB\u6539\u7528\u983B\u9053 ID\uFF1A${targetsLine(byName)}` };
  return { ok: false, error: `\u300C${q}\u300D\u4E0D\u662F\u9019\u96BB Bot \u7D81\u5B9A\u7684\u983B\u9053\uFF0C\u53EA\u80FD\u8CBC\u5230\uFF1A${list}` };
}
function sourceLabel(source, ownerId) {
  const owner = ownerId ? `<@${ownerId}>` : "\u4E3B\u4EBA";
  if (source.kind === "dm") return `\u{1F4E3} \u7531 ${owner} \u7684\u79C1\u8A0A\u5DE5\u4F5C\u56DE\u5831`;
  if (source.kind === "thread") return `\u{1F4E3} \u7531\u8A0E\u8AD6\u4E32 <#${source.threadId}> \u7684\u5DE5\u4F5C\u56DE\u5831\uFF08${owner} \u7684 Bot\uFF09`;
  return `\u{1F4E3} \u7531 ${owner} \u5728\u96FB\u8166\u4E0A\u7684\u5DE5\u4F5C\u56DE\u5831`;
}
function mentionedUsers(text, ownerId) {
  const ids = [...text.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => id !== ownerId);
}
async function postReport(client2, req) {
  try {
    return await post(client2, req);
  } catch (e) {
    log("post", `failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
async function post(client2, req) {
  const config2 = loadConfig();
  const text = req.text.trim();
  const files = req.files ?? [];
  if (!text && !files.length) return { ok: false, error: "\u5167\u5BB9\u662F\u7A7A\u7684" };
  const target = resolveTarget(boundTargets(client2, config2), req.channel);
  if (!target.ok) return target;
  const ch = await client2.channels.fetch(target.id).catch(() => null);
  if (!ch || !("guildId" in ch)) return { ok: false, error: `Bot \u770B\u4E0D\u5230\u983B\u9053 ${target.id}\uFF08\u53EF\u80FD\u6C92\u6709\u6B0A\u9650\u6216\u983B\u9053\u5DF2\u522A\u9664\uFF09` };
  if (config2.discord.guild_id && ch.guildId !== config2.discord.guild_id) return { ok: false, error: `\u983B\u9053 ${target.id} \u4E0D\u5728\u8A2D\u5B9A\u7684\u4F3A\u670D\u5668\u88E1` };
  const channelName = "name" in ch && ch.name ? `#${ch.name}` : `\u983B\u9053 ${target.id}`;
  const ownerId = botOwner(config2.discord.owner_id, client2.user.id);
  const chunks = splitMessage(`${sourceLabel(req.source, ownerId)}
${text}`);
  const users = mentionedUsers(text, ownerId);
  const attach = files.map((f) => ({ attachment: f, name: path7.basename(f) }));
  const isForum = ch.type === ChannelType.GuildForum;
  let room;
  let where = channelName;
  let first;
  if (req.thread) {
    const th = await client2.channels.fetch(req.thread).catch(() => null);
    if (!th?.isThread() || th.parentId !== target.id) return { ok: false, error: `\u8A0E\u8AD6\u4E32 ${req.thread} \u4E0D\u5728 ${channelName} \u5E95\u4E0B` };
    room = th;
    where = `${channelName} \u7684\u8A0E\u8AD6\u4E32\u300C${th.name}\u300D`;
  } else if (req.newThread) {
    const name = req.newThread.replace(/\s+/g, " ").trim().slice(0, 100) || "Claude \u56DE\u5831";
    if (isForum) {
      const head = chunks.shift();
      room = await ch.threads.create({ name, message: { content: head, ...chunks.length ? {} : { files: attach }, allowedMentions: { users } } });
      first = await room.fetchStarterMessage().catch(() => null) ?? void 0;
    } else if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      room = await ch.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
    } else return { ok: false, error: `${channelName} \u4E0D\u80FD\u958B\u8A0E\u8AD6\u4E32` };
    where = `${channelName} \u7684\u65B0\u8A0E\u8AD6\u4E32\u300C${name}\u300D`;
  } else if (isForum) {
    return { ok: false, error: `${channelName} \u662F\u8AD6\u58C7\u983B\u9053\uFF0C\u8981\u958B\u65B0\u8A0E\u8AD6\u4E32\uFF08new_thread\uFF09\u6216\u6307\u5B9A\u65E2\u6709\u7684\u8A0E\u8AD6\u4E32` };
  } else if (!ch.isTextBased() || !("send" in ch)) {
    return { ok: false, error: `${channelName} \u4E0D\u80FD\u767C\u6587` };
  }
  const dest = room ?? ch;
  let last = first;
  for (const [i, chunk] of chunks.entries()) {
    const m = await dest.send({ content: chunk, ...i === chunks.length - 1 && attach.length ? { files: attach } : {}, allowedMentions: { users } });
    first ??= m;
    last = m;
  }
  if (!first) return { ok: false, error: "\u6C92\u6709\u9001\u51FA\u4EFB\u4F55\u8A0A\u606F" };
  if (req.newThread && room) {
    const ts = getThread(room.id) ?? registerThread(room.id, target.id, room.name);
    if (req.forkFrom) ts.forkFrom = req.forkFrom;
    ts.source = req.source.kind === "cli" ? "\u96FB\u8166\u4E0A\u7684\u5DE5\u4F5C\u56DE\u5831" : req.source.kind === "dm" ? "\u79C1\u8A0A\u7684\u5DE5\u4F5C\u56DE\u5831" : "\u8A0E\u8AD6\u4E32\u7684\u5DE5\u4F5C\u56DE\u5831";
    if (last) ts.lastSeenMessageId = last.id;
    saveState();
  }
  log("post", `posted to ${where} (${room?.id ?? target.id}) message=${first.id}${req.forkFrom ? ` fork-from=${req.forkFrom.sessionId}` : ""} ${brief(text, 120)}`);
  return { ok: true, url: first.url, where, channelId: target.id, ...room ? { threadId: room.id } : {}, messageId: first.id };
}

// src/discord/takeover.ts
import { statSync as statSync2 } from "node:fs";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { ChannelType as ChannelType2, ThreadAutoArchiveDuration as ThreadAutoArchiveDuration2 } from "discord.js";

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

// src/discord/takeover.ts
var QUEUE_MAX = 20;
var TAKEN_OVER_TEXT = "\u{1F5A5}\uFE0F \u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\uFF0C\u7D50\u675F\u5F8C\u6703\u63A5\u56DE\u3002\u9019\u5247\u8A0A\u606F\u5DF2\u8A18\u4E0B\uFF0C\u4EA4\u9084\u5F8C\u6703\u63A5\u8457\u8655\u7406\u3002";
var BACK_FROM_COMPUTER_NOTE = "\uFF08\u4E3B\u4EBA\u525B\u624D\u5728\u96FB\u8166\u4E0A\u7684 Claude Code \u63A5\u624B\u4E86\u9019\u6BB5\u5C0D\u8A71\uFF0C\u4E0A\u9762\u6709\u4E00\u6BB5\u662F\u5728\u96FB\u8166\u4E0A\u9032\u884C\u7684\uFF1B\u73FE\u5728\u56DE\u5230 Discord\u3002\u7167\u5E38\u53EA\u7528 reply \u56DE\u8986\u9019\u88E1\u7684\u4EBA\u3002\uFF09";
var HANDED_OVER_NOTE = "\uFF08\u9019\u6BB5\u5C0D\u8A71\u662F\u4E3B\u4EBA\u5F9E\u96FB\u8166\u4E0A\u7684 Claude Code \u4EA4\u7D66 Discord \u7684\uFF1A\u4E0A\u9762\u662F\u5728\u96FB\u8166\u4E0A\u7684\u5C0D\u8A71\uFF0C\u73FE\u5728\u4E3B\u4EBA\u6539\u5728 Discord \u4E0A\u7E7C\u7E8C\u3002\u5F9E\u9019\u88E1\u958B\u59CB\uFF0C\u4F60\u7684\u4E00\u822C\u6587\u5B57\u8F38\u51FA\u6C92\u6709\u4EBA\u770B\u5F97\u5230\uFF0C\u8981\u8B93\u4EBA\u770B\u5230\u4E00\u5F8B\u7528 reply\u3002\uFF09";
async function noteTakenOver(c, trigger, status, kind) {
  const ts = convState(c);
  const tk = ts.takeover;
  const keep = kind === "normal" && !tk.queued.includes(trigger.id) && tk.queued.length < QUEUE_MAX;
  if (keep) {
    tk.queued.push(trigger.id);
    saveState();
  }
  log("takeover", `${c.key} ${kind} ${trigger.id} while taken over${keep ? ` (kept, ${tk.queued.length} waiting)` : ""}`);
  await status.set("waiting");
  await trigger.react("\u{1F5A5}\uFE0F").catch(() => {
  });
  const text = keep ? TAKEN_OVER_TEXT : "\u{1F5A5}\uFE0F \u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\uFF0C\u9019\u500B\u52D5\u4F5C\u7B49\u4EA4\u9084\u5F8C\u518D\u505A\u4E00\u6B21\u3002";
  try {
    await trigger.reply({ content: text, allowedMentions: { parse: [] } });
  } catch {
    await c.room.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {
    });
  }
}
var fail = (error) => ({ ok: false, error });
function label(c) {
  return c.kind === "dm" ? "\u79C1\u8A0A" : `\u8A0E\u8AD6\u4E32\u300C${c.room.name}\u300D`;
}
async function takeOver(client2, key) {
  const c = await convFor(client2, key);
  if (!c) return fail(`\u627E\u4E0D\u5230\u5C0D\u8A71 ${key}\uFF08\u8A0E\u8AD6\u4E32\u8981\u5728\u7D81\u5B9A\u7684\u983B\u9053\u5E95\u4E0B\uFF1B\u79C1\u8A0A\u8981\u958B\u555F\uFF09`);
  const ts = convState(c);
  if (!ts.sessionId) return fail(`${label(c)}\u9084\u6C92\u6709\u5C0D\u8A71\uFF08session\uFF09\uFF0C\u6C92\u6709\u6771\u897F\u53EF\u4EE5\u63A5\u624B`);
  const ch = effective(c, ts);
  const info = () => ({ key, kind: c.kind, name: label(c), sessionId: ts.sessionId, cwd: ch.cwd, launcher: ch.launcher, ...c.kind === "thread" ? { url: c.room.url } : {} });
  if (ts.takeover) return { ok: true, ...info() };
  if (liveSession(key)?.busy || isPending(key)) return fail(`Claude \u6B63\u5728${label(c)}\u88E1\u5DE5\u4F5C\u3002\u8ACB\u7B49\u9019\u4E00\u8F2A\u7D50\u675F\uFF0C\u6216\u5728 Discord \u4E0A\u6309 \u{1F6D1}\uFF0F\u7528 /stop \u505C\u4E0B\u4F86\u518D\u63A5\u624B`);
  ts.takeover = { at: (/* @__PURE__ */ new Date()).toISOString(), sessionId: ts.sessionId, cwd: ch.cwd, queued: [] };
  saveState();
  hold(key);
  await release(key, "takeover");
  log("takeover", `${key} taken over on the computer session=${ts.sessionId} cwd=${ch.cwd}`);
  const owner = botOwner(loadConfig().discord.owner_id, client2.user.id);
  const text = c.kind === "dm" ? "\u{1F5A5}\uFE0F \u4F60\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E86\u9019\u6BB5\u79C1\u8A0A\u5C0D\u8A71\u3002\u96FB\u8166\u4E0A\u505A\u5B8C\u5F8C\u7528 /channelcollab:release \u4EA4\u9084\uFF1B\u5728\u9019\u88E1\u50B3\u7684\u8A0A\u606F\u6703\u8A18\u4E0B\uFF0C\u4EA4\u9084\u5F8C\u63A5\u8457\u8655\u7406\uFF08\u5FD8\u4E86\u4EA4\u9084\u6642\uFF0C\u5728\u9019\u88E1\u6253 /takeback \u5F37\u5236\u63A5\u56DE\uFF09\u3002" : `\u{1F5A5}\uFE0F ${owner ? `<@${owner}>` : "\u4E3B\u4EBA"} \u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E86\u9019\u6BB5\u5C0D\u8A71\uFF0C\u7D50\u675F\u5F8C\u6703\u63A5\u56DE\u3002\u671F\u9593\u5728\u9019\u88E1\u7684\u8A0A\u606F\u6703\u5148\u8A18\u4E0B\u3002`;
  await c.room.send({ content: text, allowedMentions: { parse: [] } }).catch((e) => log("takeover", `${key} notice failed: ${e.message}`));
  return { ok: true, ...info() };
}
async function giveBack(client2, key, opts = {}) {
  const c = await convFor(client2, key);
  if (!c) return fail(`\u627E\u4E0D\u5230\u5C0D\u8A71 ${key}`);
  const ts = convState(c);
  const tk = ts.takeover;
  if (!tk) return fail(`${label(c)}\u6C92\u6709\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D`);
  if (opts.sessionId && opts.sessionId !== ts.sessionId) {
    log("takeover", `${key} session ${ts.sessionId} -> ${opts.sessionId} (from the computer)`);
    ts.sessionId = opts.sessionId;
  }
  ts.takeover = void 0;
  ts.pendingNote = ts.pendingNote ? `${ts.pendingNote}
${BACK_FROM_COMPUTER_NOTE}` : BACK_FROM_COMPUTER_NOTE;
  saveState();
  unhold(key);
  log("takeover", `${key} ${opts.forced ? `taken back on Discord by ${opts.by ?? "?"}` : "released by the computer"} session=${ts.sessionId} kept=${tk.queued.length}`);
  const text = opts.forced ? `\u2705 \u5DF2\u5F37\u5236\u63A5\u56DE\u7D66 Bot${opts.by ? `\uFF08${opts.by}\uFF09` : ""}\u3002\u26A0\uFE0F \u96FB\u8166\u4E0A\u7684\u5C0D\u8A71\u8ACB\u5148\u95DC\u9589\uFF0C\u907F\u514D\u5169\u908A\u540C\u6642\u5BEB\u5165\u540C\u4E00\u6BB5\u5C0D\u8A71\u3002` : "\u2705 \u5DF2\u4EA4\u9084\u7D66 Bot\u3002";
  await c.room.send({ content: `${text}${tk.queued.length ? `\u63A5\u8457\u8655\u7406\u671F\u9593\u8A18\u4E0B\u7684 ${tk.queued.length} \u5247\u8A0A\u606F\u3002` : ""}`, allowedMentions: { parse: [] } }).catch(() => {
  });
  await replay(c, tk.queued);
  return { ok: true, kept: tk.queued.length, sessionId: ts.sessionId, name: label(c) };
}
async function replay(c, ids) {
  const ownerId = botOwner(loadConfig().discord.owner_id, c.selfId);
  for (const id of ids) {
    const m = await c.room.messages.fetch(id).catch(() => null);
    if (!m) continue;
    await m.reactions.cache.get("\u{1F5A5}\uFE0F")?.users.remove(c.selfId).catch(() => {
    });
    const who = c.kind === "dm" ? { ownerId } : { ownerId, requesterId: m.author.bot ? void 0 : m.author.id };
    const status = new StatusReactions(m);
    await status.set("received");
    const { queued } = enqueue(c.key, () => runTurn(c, m, status, who));
    if (queued) await status.set("waiting");
  }
}
function sessionRows(config2, max = 15) {
  const rows2 = [];
  const dmBase = (() => {
    try {
      return resolveDm(config2);
    } catch {
      return void 0;
    }
  })();
  const add = (key, kind, ts, cwd, launcher, name) => {
    if (!ts.sessionId || !cwd) return;
    rows2.push({ key, kind, name, at: ts.lastAt ?? ts.createdAt, summary: (ts.last ?? ts.first ?? "").slice(0, 100), sessionId: ts.sessionId, cwd: ts.cwd ?? cwd, launcher, takenOver: !!ts.takeover, busy: !!liveSession(key)?.busy || isPending(key) });
  };
  if (dmBase) add(DM_KEY, "dm", getDm(), dmBase.cwd, dmBase.launcher, "\u79C1\u8A0A");
  for (const [id, t] of allThreads()) {
    const b = config2.channels[t.channelId];
    if (b) add(id, "thread", t, b.cwd, b.launcher ?? "", t.name ?? `\u8A0E\u8AD6\u4E32 ${id}`);
  }
  return rows2.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, max);
}
async function handOff(client2, req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.sessionId)) return fail(`session ID \u683C\u5F0F\u4E0D\u5C0D\uFF1A${req.sessionId}`);
  const info = await getSessionInfo(req.sessionId).catch(() => void 0);
  if (!info) return fail(`\u5728\u9019\u53F0\u96FB\u8166\u7684 Claude Code \u5C0D\u8A71\u7D00\u9304\u88E1\u627E\u4E0D\u5230 session ${req.sessionId}\uFF08Bot \u548C\u96FB\u8166\u4E0A\u7684 Claude Code \u8981\u7528\u540C\u4E00\u500B\u8A2D\u5B9A\u8CC7\u6599\u593E\uFF09`);
  const cwd = sessionFolder(info.cwd, req.cwd);
  if (!cwd) return fail("\u4E0D\u77E5\u9053\u9019\u6BB5\u5C0D\u8A71\u7684\u5DE5\u4F5C\u8CC7\u6599\u593E\uFF0C\u8ACB\u52A0 --cwd");
  const config2 = loadConfig();
  const ownerId = botOwner(config2.discord.owner_id, client2.user.id);
  const summary = (req.summary ?? "").trim();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const first = (summary || info.summary || "").replace(/\s+/g, " ").slice(0, 120);
  const target = req.target && req.target !== "dm" ? req.target : void 0;
  if (!target) {
    const dm = resolveDm(config2);
    if (!dm || !ownerId) return fail("\u79C1\u8A0A\u6C92\u6709\u958B\u555F\uFF08\u6216\u6C92\u6709\u8A2D\u5B9A\u4E3B\u4EBA\uFF09\uFF0C\u4E0D\u80FD\u4EA4\u5230\u79C1\u8A0A\uFF1B\u53EF\u4EE5\u6539\u4EA4\u5230\u7D81\u5B9A\u7684\u983B\u9053\uFF08--channel\uFF09");
    const cur = getDm();
    if (cur.takeover) return fail("\u76EE\u524D\u7684\u79C1\u8A0A\u5C0D\u8A71\u6B63\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\uFF0C\u8ACB\u5148\u4EA4\u9084\uFF08release\uFF09");
    if (liveSession(DM_KEY)?.busy || isPending(DM_KEY)) return fail("Claude \u6B63\u5728\u79C1\u8A0A\u88E1\u5DE5\u4F5C\uFF0C\u8ACB\u7B49\u5B83\u505A\u5B8C\uFF08\u6216\u5728\u79C1\u8A0A\u7528 /stop\uFF09\u518D\u4EA4\u68D2");
    await release(DM_KEY, "handoff");
    switchDm({ channelId: DM_KEY, sessionId: req.sessionId, cwd, source: "\u5F9E\u96FB\u8166\u4EA4\u68D2", lastCostTotal: 0, resumeCostBase: 0, createdAt: now, lastAt: now, first, last: first, pendingNote: HANDED_OVER_NOTE });
    const cwdNote2 = sameFolder(cwd, dm.cwd) ? void 0 : `\u9019\u6BB5\u5C0D\u8A71\u7684\u5DE5\u4F5C\u8CC7\u6599\u593E\u662F \`${cwd}\`\uFF0C\u548C\u79C1\u8A0A\u5E73\u5E38\u7684 \`${dm.cwd}\` \u4E0D\u540C\uFF1B\u9019\u6B21\u7167\u9019\u6BB5\u5C0D\u8A71\u7684\u8CC7\u6599\u593E\u8DD1\uFF0C/clear \u4E4B\u5F8C\u56DE\u5230\u5E73\u5E38\u7684\u3002`;
    const room = await (await client2.users.fetch(ownerId)).createDM();
    const text2 = handoffText(summary, cwd, cwdNote2, "/clear \u958B\u65B0\u7684\u5C0D\u8A71\uFF1B\u539F\u672C\u7684\u79C1\u8A0A\u5C0D\u8A71\u53EF\u4EE5\u7528 /resume \u63A5\u56DE\u3002");
    for (const chunk of splitMessage(text2)) await room.send({ content: chunk, allowedMentions: { parse: [] } });
    log("handoff", `session ${req.sessionId} -> dm cwd=${cwd}`);
    return { ok: true, where: "\u79C1\u8A0A", cwd, ...cwdNote2 ? { cwdNote: cwdNote2 } : {}, launcher: dm.launcher };
  }
  const t = resolveTarget(boundTargets(client2, config2), target);
  if (!t.ok) return t;
  const ch = await client2.channels.fetch(t.id).catch(() => null);
  if (!ch || !("threads" in ch) || !("guildId" in ch)) return fail(`Bot \u770B\u4E0D\u5230\u983B\u9053 ${t.id}\uFF0C\u6216\u90A3\u500B\u983B\u9053\u4E0D\u80FD\u958B\u8A0E\u8AD6\u4E32`);
  const name = (req.title?.trim() || info.customTitle || info.summary || "\u5F9E\u96FB\u8166\u4EA4\u68D2").replace(/\s+/g, " ").slice(0, 100);
  const channelCwd = config2.channels[t.id].cwd;
  const cwdNote = sameFolder(cwd, channelCwd) ? void 0 : `\u9019\u6BB5\u5C0D\u8A71\u7684\u5DE5\u4F5C\u8CC7\u6599\u593E\u662F \`${cwd}\`\uFF0C\u548C\u9019\u500B\u983B\u9053\u5E73\u5E38\u7684 \`${channelCwd}\` \u4E0D\u540C\uFF1B\u9019\u500B\u8A0E\u8AD6\u4E32\u7167\u9019\u6BB5\u5C0D\u8A71\u7684\u8CC7\u6599\u593E\u8DD1\u3002`;
  const text = handoffText(summary, cwd, cwdNote, "");
  const chunks = splitMessage(`\u{1F4BB} ${ownerId ? `<@${ownerId}>` : "\u4E3B\u4EBA"} \u5F9E\u96FB\u8166\u4EA4\u68D2\u904E\u4F86
${text}`);
  let thread;
  let last;
  if (ch.type === ChannelType2.GuildForum) {
    thread = await ch.threads.create({ name, message: { content: chunks.shift(), allowedMentions: { parse: [] } } });
  } else if (ch.type === ChannelType2.GuildText || ch.type === ChannelType2.GuildAnnouncement) {
    thread = await ch.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration2.OneDay });
  } else return fail(`\u983B\u9053 ${t.id} \u4E0D\u80FD\u958B\u8A0E\u8AD6\u4E32`);
  for (const chunk of chunks) last = await thread.send({ content: chunk, allowedMentions: { parse: [] } });
  const ts = getThread(thread.id) ?? registerThread(thread.id, t.id, thread.name);
  Object.assign(ts, { sessionId: req.sessionId, cwd, source: "\u5F9E\u96FB\u8166\u4EA4\u68D2", lastAt: now, first, last: first, pendingNote: HANDED_OVER_NOTE, ...last ? { lastSeenMessageId: last.id } : {} });
  saveState();
  log("handoff", `session ${req.sessionId} -> thread ${thread.id} "${brief(name, 60)}" cwd=${cwd}`);
  return { ok: true, where: `\u8A0E\u8AD6\u4E32\u300C${name}\u300D`, url: thread.url, cwd, ...cwdNote ? { cwdNote } : {}, launcher: config2.channels[t.id].launcher ?? "" };
}
function sessionFolder(recorded, hint) {
  const isDir = (p) => {
    try {
      return !!p && statSync2(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (isDir(recorded)) return recorded;
  if (isDir(hint)) return hint;
  return recorded ?? hint;
}
var sameFolder = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
function handoffText(summary, cwd, cwdNote, more) {
  return [
    "\u{1F4BB} **\u5F9E\u96FB\u8166\u4EA4\u68D2\u904E\u4F86\u7684\u5C0D\u8A71**",
    summary || "\uFF08\u6C92\u6709\u9644\u6458\u8981\uFF09",
    "",
    `\u5DE5\u4F5C\u8CC7\u6599\u593E\uFF1A\`${cwd}\``,
    ...cwdNote ? [cwdNote] : [],
    `\u4E4B\u5F8C\u5728\u9019\u88E1\u50B3\u8A0A\u606F\uFF0C\u5C31\u6703\u63A5\u8457\u96FB\u8166\u4E0A\u7684\u540C\u4E00\u6BB5\u5C0D\u8A71\u3002${more}`,
    "\u26A0\uFE0F \u96FB\u8166\u4E0A\u7684\u90A3\u500B\u5C0D\u8A71\u8ACB\u95DC\u6389\uFF08\u6216\u4E0D\u8981\u518D\u5728\u90A3\u88E1\u7E7C\u7E8C\uFF09\uFF0C\u907F\u514D\u5169\u908A\u540C\u6642\u5BEB\u5165\u3002"
  ].join("\n");
}

// src/discord/attachments.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import path8 from "node:path";
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function safeName(name) {
  const base = path8.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_");
  return base.slice(-120) || "file";
}
async function saveAttachments(message, threadId) {
  const saved = /* @__PURE__ */ new Map();
  if (!message.attachments.size) return saved;
  const dir = path8.join(INBOX_DIR, threadId);
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
      const file = path8.join(dir, `${message.id}-${safeName(a.name)}`);
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
  const tags = [m.author.username];
  if (m.author.bot) {
    tags.push("Bot");
    const r = roster.bots.find((b) => b.botId === m.author.id);
    if (r) {
      const who = [r.ownerName ? `${r.ownerName} \u7684` : "", r.role ? roleName(r.role) : r.ownerName ? "Bot" : ""].join("");
      tags.push([who, `ID ${r.botId}`].filter(Boolean).join("\uFF0C"));
    }
  } else {
    tags.push(`ID ${m.author.id}`);
    const p = rosterPeople(roster).find((x) => x.discordId === m.author.id);
    if (p) tags.push(`\u540D\u518A\uFF1A${p.name}${p.role ? `\uFF0C${roleName(p.role)}` : ""}`);
  }
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
  return [...fetched.values()].filter((m) => !m.system).filter((m) => m.author.bot || !parseCommand(m.content)).filter((m) => !afterId || BigInt(m.id) > BigInt(afterId) && m.author.id !== me).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}
async function buildPrompt(opts) {
  const { thread, trigger } = opts;
  const history = await recent(thread, trigger, opts.history, opts.afterId);
  const roster = loadRosterFile();
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
function buildDmPrompt(trigger, attachments, roster = loadRosterFile()) {
  return [`\u3010\u767C\u8A71\u8005\u3011${speaker(trigger, roster)}\uFF08\u4F60\u7684\u4E3B\u4EBA\uFF09`, "\u3010\u4F4D\u7F6E\u3011Discord \u79C1\u8A0A\uFF08\u4F60\u548C\u4E3B\u4EBA\u4E00\u5C0D\u4E00\uFF09", "\u3010\u672C\u5247\u8A0A\u606F\u3011", body(trigger, attachments)].join("\n");
}

// src/discord/prompts.ts
import {
  ActionRowBuilder as ActionRowBuilder3,
  ButtonBuilder as ButtonBuilder2,
  ButtonStyle as ButtonStyle2,
  MessageFlags as MessageFlags3,
  ModalBuilder as ModalBuilder2,
  StringSelectMenuBuilder,
  TextInputBuilder as TextInputBuilder2,
  TextInputStyle as TextInputStyle2
} from "discord.js";

// src/discord/pin-ui.ts
import { ActionRowBuilder as ActionRowBuilder2, MessageFlags as MessageFlags2, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
var LOCK_NOTICE = `\u{1F512} PIN \u9023\u7E8C\u8F38\u932F ${MAX_FAILURES} \u6B21\uFF0C\u5DF2\u9396\u5B9A\uFF1A\u6838\u51C6\u6B0A\u9650\u548C\u79C1\u8A0A\u90FD\u66AB\u505C\u3002\u8ACB\u5728\u96FB\u8166\u4E0A\u57F7\u884C channelcollab \u7684 unlock\uFF08\u6216\u91CD\u555F Bot\uFF09\u89E3\u9664\u3002`;
var LOCKED_REPLY = "\u{1F512} \u5DF2\u9396\u5B9A\uFF08PIN \u8F38\u932F\u592A\u591A\u6B21\uFF09\u3002\u8ACB\u5728\u96FB\u8166\u4E0A\u57F7\u884C unlock \u6216\u91CD\u555F Bot \u89E3\u9664\u3002";
function pinModal(customId, title) {
  return new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45)).addComponents(
    new ActionRowBuilder2().addComponents(
      new TextInputBuilder().setCustomId("pin").setLabel("PIN\uFF08\u8F38\u5165\u6846\u4E0D\u6703\u906E\u4F4F\uFF0C\u6CE8\u610F\u65C1\u4EBA\uFF09").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(32)
    )
  );
}
var unlockMinutes = () => Math.round((pinGate.state().unlockedUntil - Date.now()) / 6e4);
async function checkPin(i, announce) {
  const r = pinGate.attempt(i.fields.getTextInputValue("pin"));
  if (r.result === "ok") {
    log("pin", `correct PIN from ${i.user.username}; no PIN needed for ${unlockMinutes()} min`);
    return true;
  }
  if (r.result === "not-set") {
    log("pin", `no PIN set any more; ${i.user.username} passes`);
    return true;
  }
  if (r.result === "wrong") {
    log("pin", `wrong PIN from ${i.user.username} (${r.left} tries left)`);
    await i.reply({ content: `\u274C PIN \u4E0D\u5C0D\uFF0C\u9084\u53EF\u4EE5\u518D\u8A66 ${r.left} \u6B21\uFF08\u9023\u7E8C\u932F ${MAX_FAILURES} \u6B21\u6703\u9396\u5B9A\uFF09\u3002`, flags: MessageFlags2.Ephemeral });
    return false;
  }
  log("pin", r.justLocked ? `wrong PIN from ${i.user.username}; locked after ${MAX_FAILURES} wrong PINs` : `attempt by ${i.user.username} while locked`);
  await i.reply({ content: r.justLocked ? LOCK_NOTICE : LOCKED_REPLY, flags: MessageFlags2.Ephemeral });
  if (r.justLocked) await announce?.(LOCK_NOTICE)?.catch((e) => log("pin", `lock notice failed: ${e.message}`));
  return false;
}
async function pinOkFollowUp(i) {
  const min = unlockMinutes();
  await i.followUp({ content: `\u{1F513} PIN \u6B63\u78BA${min > 0 ? `\uFF0C\u63A5\u4E0B\u4F86\u7D04 ${min} \u5206\u9418\u5167\u6838\u51C6\u548C\u79C1\u8A0A\u4E0D\u7528\u518D\u8F38\u5165` : ""}\u3002`, flags: MessageFlags2.Ephemeral }).catch(() => {
  });
}

// src/discord/prompts.ts
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
  const str2 = (k2) => typeof input[k2] === "string" ? input[k2] : "";
  if (name.endsWith("__post_to_channel")) {
    const where = `${str2("channel")}${str2("thread") ? ` \u7684\u8A0E\u8AD6\u4E32 ${str2("thread")}` : ""}${input.new_thread ? ` \u7684\u65B0\u8A0E\u8AD6\u4E32\u300C${clip(str2("thread_title") || "\uFF08\u6C92\u6709\u6A19\u984C\uFF09", 80)}\u300D` : ""}`;
    const files = Array.isArray(input.files) && input.files.length ? `
\u9644\u6A94\uFF1A${input.files.map((f) => `\`${f}\``).join("\u3001")}` : "";
    return `\u8981\u8CBC\u5230\u5718\u968A\u983B\u9053 **${clip(where, 200)}**\uFF1A
${fence(clipLines(str2("text"), 15, 900))}${files}`;
  }
  if (name === "Bash" || name === "PowerShell") {
    const desc = str2("description");
    return `${desc ? `${clip(desc, 200)}
` : ""}${fence(clipLines(str2("command"), 20, 900), name === "Bash" ? "sh" : "powershell")}`;
  }
  if (name === "Edit" || name === "MultiEdit") {
    const edits = name === "Edit" ? [{ old_string: str2("old_string"), new_string: str2("new_string") }] : input.edits ?? [];
    const diff = edits.slice(0, 3).map((e) => [...clipLines(e.old_string, 8, 400).split("\n").map((l) => `- ${l}`), ...clipLines(e.new_string, 8, 400).split("\n").map((l) => `+ ${l}`)].join("\n")).join("\n\u2026\n");
    return `\`${str2("file_path")}\`${edits.length > 3 ? `\uFF08\u5171 ${edits.length} \u8655\uFF0C\u53EA\u5217\u524D 3 \u8655\uFF09` : ""}
${fence(diff, "diff")}`;
  }
  if (name === "Write") {
    const content = str2("content");
    return `\`${str2("file_path")}\`\uFF08${content.split("\n").length} \u884C\uFF09
${fence(clipLines(content, 10, 600))}`;
  }
  const p = str2("file_path") || str2("notebook_path") || str2("path");
  if (p) return `\`${p}\``;
  if (name === "WebFetch") return `${str2("url")}`;
  return fence(brief(input, 600));
}
function rows(...builders) {
  return builders.map((b) => new ActionRowBuilder3().addComponents(...b));
}
async function edit(p, extra, keepComponents = false) {
  const content = clip(`${p.base}
${extra}`, MAX_CONTENT);
  await p.message?.edit({ content, ...keepComponents ? {} : { components: [] }, allowedMentions: { parse: [] } }).catch((e) => log("prompt", `edit failed: ${e.message}`));
}
function settleOnce(id, entry, timeoutMs, signal, onTimeout, onAbort) {
  pending2.set(id, entry);
  let finish2;
  const result = new Promise((r) => finish2 = r);
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
    finish2(v);
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
  const blocked = req.blockedReason?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  const why = req.blockedReason !== void 0 ? `
\u{1F916} \u81EA\u52D5\u6A21\u5F0F\u64CB\u4E0B\u4E86\u9019\u500B\u52D5\u4F5C${blocked ? `\uFF0C\u539F\u56E0\uFF1A${clip(blocked, 300)}` : ""}\u3002\u6309\u300C\u5141\u8A31\u300D\u5C31\u6703\u7167\u539F\u6A23\u57F7\u884C\u3002` : "";
  const base = `\u{1F510} **\u6B0A\u9650\u8ACB\u6C42** \`${req.toolName}\`\u3000<@${who.ownerId}> \u8ACB\u78BA\u8A8D\uFF08${minutes(timeoutMs)}\u5167\u6C92\u6709\u56DE\u61C9\u6703\u5148\u8DF3\u904E\uFF0C\u6392\u5165\u5F85\u6838\u51C6\u6E05\u55AE\uFF0C\u4E4B\u5F8C\u9084\u53EF\u4EE5\u6838\u51C6\uFF09${pinGate.required ? "\u3000\u6309\u300C\u5141\u8A31\u300D\u8981\u8F38\u5165 PIN" : ""}${why}
${summarizeTool(req.toolName, req.input)}`;
  const p = { kind: "permission", who, base: clip(base, MAX_CONTENT - 200), toolName: req.toolName, done: () => {
  } };
  const s = settleOnce(
    id,
    p,
    timeoutMs,
    req.signal,
    () => ({ a: { behavior: "deny", message: DEFER_MESSAGE, deferred: true }, note: `\u231B \u4E3B\u4EBA ${minutes(timeoutMs)}\u5167\u6C92\u6709\u56DE\u61C9\uFF0C\u5DF2\u6392\u5165\u5F85\u6838\u51C6\u6E05\u55AE` }),
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
    (x, i) => new ActionRowBuilder3().addComponents(
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
  else await i.reply({ content: "\u5DF2\u8A18\u9304\u3002", flags: MessageFlags3.Ephemeral });
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
function allowNote(userId, action, toolName) {
  return action === "always" ? `\u2705 <@${userId}> \u5DF2\u5141\u8A31\uFF0C\u9019\u500B session \u4E4B\u5F8C\u7684 \`${toolName}\` \u4E0D\u518D\u8A62\u554F` : `\u2705 <@${userId}> \u5DF2\u5141\u8A31`;
}
function denyText(kind, who) {
  if (kind === "permission") return "\u53EA\u6709 Bot \u64C1\u6709\u8005\u53EF\u4EE5\u6838\u51C6\u3002";
  const names = [who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
  return `\u53EA\u6709 ${names.join(" \u6216 ")} \u53EF\u4EE5${kind === "stop" ? "\u505C\u6B62\u9019\u4E00\u8F2A" : "\u56DE\u7B54"}\u3002`;
}
async function lookup(i, id) {
  const p = pending2.get(id);
  if (!p) {
    await i.reply({ content: "\u9019\u500B\u8ACB\u6C42\u5DF2\u7D93\u8655\u7406\u904E\uFF0C\u6216\u5DF2\u5931\u6548\uFF08\u4F8B\u5982 Bot \u91CD\u555F\u904E\uFF09\u3002", flags: MessageFlags3.Ephemeral });
    return void 0;
  }
  if (!canAct(p.kind, i.user.id, p.who)) {
    log("prompt", `${p.kind} ${id} refused ${i.user.username} (${i.user.id})`);
    await i.reply({ content: denyText(p.kind, p.who), flags: MessageFlags3.Ephemeral, allowedMentions: { parse: [] } });
    return void 0;
  }
  return p;
}
function isPromptInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
  return /^(perm|permdeny|permpin|ask|askother|stop):/.test(i.customId);
}
async function handlePromptInteraction(i) {
  if (i.isButton() && i.customId.startsWith("perm:")) {
    const [, id, action] = i.customId.split(":");
    const p = await lookup(i, id);
    if (!p || p.kind !== "permission") return;
    log("prompt", `permission ${id} ${action} clicked by ${i.user.username}`);
    if (action === "deny") {
      await i.showModal(
        new ModalBuilder2().setCustomId(`permdeny:${id}`).setTitle(clip(`\u62D2\u7D55 ${p.toolName}`, 45)).addComponents(
          new ActionRowBuilder3().addComponents(
            new TextInputBuilder2().setCustomId("reason").setLabel("\u62D2\u7D55\u7406\u7531\uFF08\u9078\u586B\uFF0C\u6703\u8F49\u544A Claude\uFF09").setStyle(TextInputStyle2.Paragraph).setRequired(false).setMaxLength(1e3)
          )
        )
      );
      return;
    }
    const step = approvalStep(true, pinGate);
    if (step === "locked") {
      await i.reply({ content: LOCKED_REPLY, flags: MessageFlags3.Ephemeral });
      return;
    }
    if (step === "pin") {
      await i.showModal(pinModal(`permpin:${id}:${action}`, `\u6838\u51C6 ${p.toolName}`));
      return;
    }
    const note = allowNote(i.user.id, action, p.toolName);
    await i.update({ content: clip(`${p.base}
${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
    p.message = void 0;
    p.done({ behavior: action === "always" ? "always" : "allow" }, note);
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("permpin:")) {
    const [, id, action] = i.customId.split(":");
    const p = await lookup(i, id);
    if (!p || p.kind !== "permission") return;
    const announce = (text) => i.channel?.isSendable() ? i.channel.send({ content: text, allowedMentions: { parse: [] } }) : Promise.resolve();
    if (!await checkPin(i, announce)) return;
    const note = allowNote(i.user.id, action, p.toolName);
    if (i.isFromMessage()) {
      await i.update({ content: clip(`${p.base}
${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
      p.message = void 0;
    } else await i.deferUpdate();
    await pinOkFollowUp(i);
    log("prompt", `permission ${id} ${action} by ${i.user.username} after PIN`);
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
        new ModalBuilder2().setCustomId(`askother:${id}:${index}:${i.values.filter((v) => v !== OTHER).join(",")}`).setTitle(clip(x.header || "\u5176\u4ED6", 45)).addComponents(
          new ActionRowBuilder3().addComponents(
            new TextInputBuilder2().setCustomId("answer").setLabel(clip(x.question, 45)).setStyle(TextInputStyle2.Paragraph).setRequired(true).setMaxLength(1e3)
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

// src/discord/conversation.ts
var FALLBACK_MAX = 500;
var STOP_BUTTON_DELAY_MS = 5e3;
function convState(c) {
  return c.kind === "dm" ? getDm() : getConversation(c.key);
}
function effective(c, ts = convState(c)) {
  const cwd = ts.cwd ?? c.base.cwd;
  const effort = isEffort(ts.effort) ? ts.effort : c.base.effort;
  return { ...c.base, cwd, model: ts.model ?? c.base.model, ...effort ? { effort } : {}, permissionMode: ts.plan ? "plan" : c.base.permissionMode, basePermissionMode: c.base.permissionMode };
}
var running = /* @__PURE__ */ new Map();
async function convFor(client2, key) {
  const config2 = loadConfig();
  if (key === DM_KEY) {
    const base2 = resolveDm(config2);
    const owner = botOwner(config2.discord.owner_id, client2.user.id);
    if (!base2 || !owner) return void 0;
    const room2 = await (await client2.users.fetch(owner)).createDM();
    return { key, kind: "dm", room: room2, base: base2, selfId: client2.user.id };
  }
  const ts = getThread(key);
  const base = ts && resolveChannel(config2, ts.channelId);
  const room = base ? await client2.channels.fetch(key).catch(() => null) : null;
  if (!base || !room?.isThread()) return void 0;
  return { key, kind: "thread", room, base, selfId: client2.user.id };
}
async function checkContext(c, session, ts) {
  const u = await session.contextUsage().catch(() => void 0);
  if (!u) return void 0;
  ts.ctx = { pct: u.pct, ...u.tokens !== void 0 ? { tokens: u.tokens } : {}, ...u.max !== void 0 ? { max: u.max } : {}, at: (/* @__PURE__ */ new Date()).toISOString() };
  const alert = contextAlert(u.pct, ts.ctxNotified ?? []);
  ts.ctxNotified = alert.notified;
  saveState();
  log("context", `${c.key} ${u.pct}% (${u.tokens ?? "?"}/${u.max ?? "?"})${alert.notify ? ` notify ${alert.notify}%` : ""}`);
  if (alert.notify) await c.room.send({ content: contextNotice(u.pct, c.kind), allowedMentions: { parse: [] } }).catch((e) => log("error", `context notice ${c.key}: ${e.message}`));
  return u.pct;
}
async function runTurn(c, trigger, status, who, input = {}) {
  const kind = input.kind ?? "normal";
  const room = c.room;
  if (convState(c).takeover) return noteTakenOver(c, trigger, status, kind);
  let progress;
  running.set(c.key, who);
  try {
    await status.set("running");
    const ts = convState(c);
    if (!ts.sessionId && ts.forkFrom) {
      const from = ts.forkFrom;
      const fork = await forkSession(from.sessionId, { dir: from.cwd });
      ts.sessionId = fork.sessionId;
      ts.cwd = from.cwd;
      ts.forkFrom = void 0;
      saveState();
      log("thread", `${c.key} forked report session ${from.sessionId} -> ${fork.sessionId} cwd=${from.cwd}`);
    }
    const channel = effective(c, ts);
    let prompt = input.prompt;
    if (prompt === void 0) {
      const attachments = await saveAttachments(trigger, c.key);
      prompt = c.kind === "dm" ? buildDmPrompt(trigger, attachments) : await buildPrompt({ thread: room, trigger, history: channel.history, afterId: ts.sessionId ? ts.lastSeenMessageId : void 0, attachments });
      ts.lastPrompt = prompt;
      const text = trigger.cleanContent.replace(/\s+/g, " ").trim().slice(0, 120);
      if (text) {
        ts.first ??= text;
        ts.last = text;
      }
    }
    if (ts.pendingNote && kind !== "compact" && !prompt.startsWith("/")) {
      prompt = `${ts.pendingNote}

${prompt}`;
      ts.pendingNote = void 0;
    }
    const deferred = [];
    const before = ts.ctx?.pct;
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
    const client2 = trigger.client;
    let targets = "";
    try {
      targets = targetsLine(boundTargets(client2, loadConfig()));
    } catch {
    }
    const session = await acquire(c.key, c.selfId, channel, ts.sessionId, ts.resumeCostBase ?? ts.lastCostTotal, c.kind, targets);
    progress = stopControl(room, who, STOP_BUTTON_DELAY_MS, (by) => void session.interrupt(by));
    const turn = await session.run(prompt, {
      sendReply: async (text, files) => {
        const chunks = splitReply(text, contextFooter(convState(c).ctx?.pct));
        if (!chunks.length && files.length) chunks.push("");
        for (const [i, chunk] of chunks.entries()) {
          const attach = i === chunks.length - 1 ? files.map((f) => ({ attachment: f, name: path9.basename(f) })) : [];
          lastReply = await room.send({ ...chunk ? { content: chunk } : {}, files: attach, allowedMentions: { parse: c.kind === "dm" ? [] : ["users"] } });
        }
      },
      askPermission: (req) => waiting(async () => {
        try {
          const answer = await askPermission(room, req, who, channel.ownerWaitMs);
          if (answer.behavior === "deny" && answer.deferred) deferred.push(deferItem(req.toolName, req.input));
          if (answer.behavior === "always") {
            ts.alwaysAllow = [.../* @__PURE__ */ new Set([...ts.alwaysAllow ?? [], req.toolName])];
            saveState();
          }
          return answer;
        } catch (e) {
          log("error", `permission prompt ${c.key}: ${e.message}`);
          return { behavior: "deny", message: `\u7121\u6CD5\u5728 Discord \u4E0A\u8A62\u554F\u4E3B\u4EBA\uFF08${e.message}\uFF09\uFF0C\u5DF2\u62D2\u7D55\u3002` };
        }
      }),
      askQuestion: (questions, signal) => waiting(
        () => askQuestion(room, questions, who, channel.permissionTimeoutMs, signal).catch((e) => {
          log("error", `question prompt ${c.key}: ${e.message}`);
          return void 0;
        })
      ),
      notice: async (text) => {
        await room.send({ content: text, allowedMentions: { parse: [] } });
      },
      postToChannel: async (a) => {
        const r = await postReport(client2, {
          channel: a.channel,
          text: a.text,
          files: a.files,
          thread: a.thread,
          newThread: a.newThread,
          source: c.kind === "dm" ? { kind: "dm" } : { kind: "thread", threadId: c.key },
          // A new report thread continues from this conversation's session (forked on its first trigger).
          ...session.sessionId ? { forkFrom: { sessionId: session.sessionId, cwd: channel.cwd } } : {}
        });
        return r.ok ? { ok: true, url: r.url, where: r.where } : r;
      }
    }, { preapproved: input.preapproved, ownerTriggered: c.kind === "dm" || !!who.ownerId && who.requesterId === who.ownerId });
    const progressMessage = await progress.end();
    if (deferred.length && who.ownerId) {
      await sendApprovalBatch(c, deferred, who).catch((e) => log("error", `approval card ${c.key}: ${e.stack ?? e}`));
    }
    if (turn.sessionId) ts.sessionId = turn.sessionId;
    ts.lastCostTotal = turn.costTotal;
    if (kind === "normal") ts.lastSeenMessageId = trigger.id;
    ts.lastAt = (/* @__PURE__ */ new Date()).toISOString();
    saveState();
    const notice = async (content) => progressMessage ? await progressMessage.edit({ content, components: [], allowedMentions: { parse: [] } }) : await room.send({ content, allowedMentions: { parse: [] } });
    if (turn.timedOut || turn.subtype === "error_max_turns") {
      const n = turn.timedOut ? timeoutNotice(channel.turnTimeoutMs, c.kind, who) : maxTurnsNotice(channel.maxTurns, c.kind, who);
      log(turn.timedOut ? "timeout" : "max-turns", `${c.key} turn stopped at the ${turn.timedOut ? `${limitLabel(channel.turnTimeoutMs)} time` : `${channel.maxTurns}-step`} limit subtype=${turn.subtype} replies=${turn.replies}`);
      await progressMessage?.delete().catch(() => {
      });
      const msg = await room.send({ content: n.content, allowedMentions: { users: n.users } });
      await attachDetails(msg, rememberTurn(c.key, turn));
      await status.set("failed");
      await checkContext(c, session, ts);
      return;
    }
    if (turn.stoppedBy) {
      log("stopped", `${c.key} by ${turn.stoppedBy} subtype=${turn.subtype}`);
      const msg = await notice(`\u23F9\uFE0F \u5DF2\u7531 ${turn.stoppedBy} \u505C\u6B62\u3002\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u9019\u6BB5\u5C0D\u8A71\u3002`);
      await attachDetails(msg, rememberTurn(c.key, turn));
      await status.set("stopped");
      await checkContext(c, session, ts);
      return;
    }
    if (kind === "compact") {
      const after = turn.ok ? await checkContext(c, session, ts) : void 0;
      const text = turn.ok ? `\u{1F5DC}\uFE0F \u5DF2\u58D3\u7E2E\u4E0A\u4E0B\u6587${before !== void 0 && after !== void 0 ? `\uFF1A${before}% \u2192 ${after}%` : after !== void 0 ? `\uFF0C\u73FE\u5728 ${after}%` : ""}\u3002` : explainFailure({ subtype: turn.subtype, error: turn.error, apiError: turn.apiError }, "\u9019\u6BB5\u5C0D\u8A71\u6C92\u6709\u88AB\u58D3\u7E2E\u3002");
      log(turn.ok ? "compact" : "fallback", `${c.key} ${brief(text, 200)}`);
      await attachDetails(await notice(text), rememberTurn(c.key, turn));
      await status.set(turn.ok ? "done" : "failed");
      return;
    }
    if ((kind === "normal" || kind === "approved") && turn.ok && turn.replies === 0 && trigger.author.bot) {
      log("silent", `${c.key} no reply to bot ${trigger.author.username} ${brief(turn.lastText, 200)}`);
      await progressMessage?.delete().catch(() => {
      });
      await status.set("done");
      await checkContext(c, session, ts);
      return;
    }
    if (!turn.ok || turn.replies === 0 || !lastReply) {
      const text = turn.ok ? `\uFF08\u6C92\u6709\u547C\u53EB reply\uFF0C\u4EE5\u4E0B\u70BA\u81EA\u52D5\u6458\u8981\uFF09
${turn.lastText.trim().slice(0, FALLBACK_MAX) || "\uFF08\u6C92\u6709\u8F38\u51FA\uFF09"}` : explainFailure({ subtype: turn.subtype, error: turn.error, apiError: turn.apiError }, c.kind === "dm" ? "\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u9019\u6BB5\u5C0D\u8A71\u3002" : "\u4E0B\u6B21\u89F8\u767C\u6642\u6703\u63A5\u56DE\u9019\u6BB5\u5C0D\u8A71\u3002");
      log("fallback", `${c.key} ${brief(text, 200)}`);
      lastReply = await notice(text);
    } else {
      await progressMessage?.delete().catch(() => {
      });
    }
    await attachDetails(lastReply, rememberTurn(c.key, turn));
    await status.set(turn.ok ? "done" : "failed");
    await checkContext(c, session, ts);
  } catch (e) {
    log("error", `run ${c.key}: ${e.stack ?? e}`);
    await (await progress?.end())?.delete().catch(() => {
    });
    await room.send({ content: explainFailure({ subtype: "error", error: e.message }), allowedMentions: { parse: [] } }).catch(() => {
    });
    await status.set("failed");
  } finally {
    if (running.get(c.key) === who) running.delete(c.key);
  }
}

// src/discord/approvals-ui.ts
var MAX_CONTENT2 = 1900;
var clip2 = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
var newId2 = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
function cardText(b) {
  const where = b.kind === "dm" ? "\u79C1\u8A0A" : `\u8A0E\u8AD6\u4E32 <#${b.convKey}>`;
  const who = b.requesterId ? `<@${b.requesterId}>` : "\u5176\u4ED6 Bot";
  const each = Math.max(200, Math.floor(1300 / b.items.length));
  const items = b.items.map((x, i) => `**${i + 1}. \`${x.toolName}\`**
${clip2(summarizeTool(x.toolName, x.input), each)}`);
  const pin = pinGate.configured ? "\u6309\u300C\u5141\u8A31\u300D\u8981\u8F38\u5165 PIN\u3002" : "";
  return clip2(`\u23F3 **\u5F85\u6838\u51C6**\uFF08${where}\uFF0C\u9700\u6C42\u4F86\u81EA ${who}\uFF09
Claude \u505A\u5230\u4E00\u534A\uFF0C\u4E0B\u9762\u7684\u52D5\u4F5C\u8981\u4F60\u6838\u51C6\uFF1B\u6838\u51C6\u5F8C Bot \u6703\u63A5\u8457\u505A\u3002

${items.join("\n")}

\u6709\u6548\u5230 ${shortTime(b.expiresAt)}\u3002${pin}`, MAX_CONTENT2 - 200);
}
function cardButtons(b) {
  const row = new ActionRowBuilder4().addComponents(new ButtonBuilder3().setCustomId(`appr:${b.id}:all`).setLabel("\u5168\u90E8\u5141\u8A31").setStyle(ButtonStyle3.Success));
  if (b.items.length > 1) row.addComponents(new ButtonBuilder3().setCustomId(`appr:${b.id}:pick`).setLabel("\u9010\u9805\u9078\u64C7").setStyle(ButtonStyle3.Primary));
  row.addComponents(new ButtonBuilder3().setCustomId(`appr:${b.id}:deny`).setLabel("\u5168\u90E8\u62D2\u7D55").setStyle(ButtonStyle3.Danger));
  return [row];
}
async function sendApprovalBatch(c, items, who) {
  const ownerId = who.ownerId;
  const b = newBatch({ id: newId2(), convKey: c.key, kind: c.kind, requesterId: who.requesterId, items });
  const payload = { content: cardText(b), components: cardButtons(b), allowedMentions: { parse: [] } };
  const { where, sent } = await deliverCard(
    {
      // In a direct message conversation the card simply goes there.
      dm: c.kind === "dm" ? void 0 : async () => (await c.room.client.users.fetch(ownerId)).send(payload),
      thread: () => c.room.send(payload)
    },
    (e) => log("approval", `${b.id} direct message to the owner failed (${e.message}); card goes to the thread`)
  );
  b.card = { channelId: sent.channelId, messageId: sent.id, where: c.kind === "dm" ? "dm" : where };
  if (c.kind === "thread") {
    const n = await c.room.send({ content: noticeText(b, ownerId, where), allowedMentions: { users: [ownerId] } });
    b.notice = { channelId: n.channelId, messageId: n.id };
  }
  putBatch(b);
  log("approval", `${b.id} ${c.key} ${b.items.length} deferred call(s) [${b.items.map((x) => x.toolName).join(", ")}] card=${b.card.where}`);
  return b;
}
async function fetchStored(client2, ref) {
  if (!ref) return void 0;
  const ch = await client2.channels.fetch(ref.channelId).catch(() => null);
  if (!ch?.isTextBased()) return void 0;
  return await ch.messages.fetch(ref.messageId).catch(() => void 0) ?? void 0;
}
async function refresh(client2, b, outcome, skipCard = false) {
  const ownerId = botOwner(loadConfig().discord.owner_id, client2.user.id) ?? "";
  if (!skipCard) await (await fetchStored(client2, b.card))?.edit({ content: clip2(`${cardText(b)}
${outcome}`, MAX_CONTENT2), components: [], allowedMentions: { parse: [] } }).catch(() => {
  });
  await (await fetchStored(client2, b.notice))?.edit({ content: noticeText(b, ownerId, b.card?.where ?? "thread"), allowedMentions: { parse: [] } }).catch(() => {
  });
}
async function continueAfter(client2, b, allow, deny) {
  const c = await convFor(client2, b.convKey);
  if (!c) {
    log("approval", `${b.id} conversation ${b.convKey} is no longer available`);
    return;
  }
  if (!allow.length) {
    convState(c).pendingNote = deniedNote(deny);
    saveState();
    return;
  }
  const trigger = await fetchStored(client2, b.notice ?? b.card) ?? await c.room.send({ content: "\u25B6\uFE0F \u63A5\u8457\u505A\u4E3B\u4EBA\u6838\u51C6\u7684\u52D5\u4F5C\u3002", allowedMentions: { parse: [] } });
  const ownerId = botOwner(loadConfig().discord.owner_id, client2.user.id);
  const who = { ownerId, requesterId: b.requesterId };
  const status = new StatusReactions(trigger);
  await status.set("received");
  log("approval", `${b.id} continue ${b.convKey} with ${allow.length} approved call(s)`);
  enqueue(c.key, () => runTurn(c, trigger, status, who, { prompt: approvedPrompt(allow, deny), kind: "approved", preapproved: deferredKeys(allow) }));
}
async function finish(i, b, choice, viaPin) {
  const d = decide2(b, choice);
  putBatch(b);
  const by = i.user.displayName || i.user.username;
  const outcome = outcomeText(d, by);
  log("approval", `${b.id} ${d.result === "decided" ? d.status : d.result} by ${i.user.username}${viaPin ? " after PIN" : ""}`);
  const onCard = i.message?.id === b.card?.messageId;
  if (onCard && (i.isButton() || i.isModalSubmit() && i.isFromMessage())) {
    await i.update({ content: clip2(`${cardText(b)}
${outcome}`, MAX_CONTENT2), components: [], allowedMentions: { parse: [] } });
  } else if (i.isStringSelectMenu() || i.isModalSubmit() && i.isFromMessage()) {
    await i.update({ content: outcome, components: [] });
  } else {
    await i.reply({ content: outcome, flags: MessageFlags4.Ephemeral });
  }
  if (viaPin && i.isModalSubmit()) await pinOkFollowUp(i);
  await refresh(i.client, b, outcome, onCard);
  if (d.result === "decided") await continueAfter(i.client, b, d.allow, d.deny);
}
function isApprovalInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
  return /^(appr|apprpick|apprpin):/.test(i.customId);
}
var parseChoice = (s) => s === "all" ? "all" : s === "none" ? "none" : s.split(".").map(Number);
async function handleApprovalInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return;
  const [kind, id, arg] = i.customId.split(":");
  const b = getBatch(id);
  if (!b) {
    await i.reply({ content: "\u627E\u4E0D\u5230\u9019\u4EFD\u5F85\u6838\u51C6\u6E05\u55AE\uFF08\u53EF\u80FD\u5DF2\u7D93\u904E\u671F\u5F88\u4E45\uFF09\u3002", flags: MessageFlags4.Ephemeral });
    return;
  }
  const ownerId = botOwner(loadConfig().discord.owner_id, i.client.user.id);
  if (!canAct("permission", i.user.id, { ownerId })) {
    log("approval", `${id} refused ${i.user.username} (${i.user.id})`);
    await i.reply({ content: "\u53EA\u6709 Bot \u64C1\u6709\u8005\u53EF\u4EE5\u6838\u51C6\u3002", flags: MessageFlags4.Ephemeral });
    return;
  }
  if (b.status !== "pending" || Date.now() >= b.expiresAt) {
    const d = decide2(b, "none");
    putBatch(b);
    if (d.result === "expired") await refresh(i.client, b, outcomeText(d, ""));
    await i.reply({ content: outcomeText(d, ""), flags: MessageFlags4.Ephemeral });
    return;
  }
  if (i.isButton() && kind === "appr") {
    if (arg === "deny") return finish(i, b, "none", false);
    if (arg === "pick") {
      await i.reply({
        content: "\u9078\u8981\u5141\u8A31\u7684\u52D5\u4F5C\uFF08\u6C92\u9078\u7684\u6703\u62D2\u7D55\uFF09\uFF1A",
        flags: MessageFlags4.Ephemeral,
        components: [
          new ActionRowBuilder4().addComponents(
            new StringSelectMenuBuilder2().setCustomId(`apprpick:${b.id}`).setMinValues(1).setMaxValues(b.items.length).setPlaceholder("\u9078\u64C7\u8981\u5141\u8A31\u7684\u52D5\u4F5C").addOptions(b.items.map((x, n) => ({ label: clip2(`${n + 1}. ${x.toolName}`, 100), value: String(n), description: clip2(JSON.stringify(x.input), 100) })))
          )
        ]
      });
      return;
    }
    return approve(i, b, "all");
  }
  if (i.isStringSelectMenu() && kind === "apprpick") return approve(i, b, i.values.map(Number));
  if (i.isModalSubmit() && kind === "apprpin") {
    const announce = (text) => i.channel?.isSendable() ? i.channel.send({ content: text, allowedMentions: { parse: [] } }) : Promise.resolve();
    if (!await checkPin(i, announce)) return;
    return finish(i, b, parseChoice(arg), true);
  }
}
async function approve(i, b, choice) {
  const step = approvalStep(true, pinGate);
  if (step === "locked") {
    await i.reply({ content: LOCKED_REPLY, flags: MessageFlags4.Ephemeral });
    return;
  }
  if (step === "pin") {
    const arg = choice === "all" || choice === "none" ? choice : choice.join(".");
    await i.showModal(pinModal(`apprpin:${b.id}:${arg}`, "\u6838\u51C6\u5F85\u6838\u51C6\u7684\u52D5\u4F5C"));
    return;
  }
  return finish(i, b, choice, false);
}

// src/discord/command-run.ts
import { forkSession as forkSession2 } from "@anthropic-ai/claude-agent-sdk";
import {
  ActionRowBuilder as ActionRowBuilder5,
  ButtonBuilder as ButtonBuilder4,
  ButtonStyle as ButtonStyle4,
  MessageFlags as MessageFlags5,
  StringSelectMenuBuilder as StringSelectMenuBuilder3
} from "discord.js";
var MODE_NAMES = {
  default: "\u4E00\u822C\uFF08\u6539\u6A94\u3001\u57F7\u884C\u6307\u4EE4\u8981\u4E3B\u4EBA\u6838\u51C6\uFF09",
  acceptEdits: "\u81EA\u52D5\u6539\u6A94\uFF08\u57F7\u884C\u6307\u4EE4\u8981\u4E3B\u4EBA\u6838\u51C6\uFF09",
  plan: "\u8A08\u756B\u6A21\u5F0F\uFF08\u53EA\u8A0E\u8AD6\u4E0D\u52D5\u624B\uFF09",
  dontAsk: "\u4E0D\u8A62\u554F\uFF08\u6539\u6A94\u3001\u57F7\u884C\u6307\u4EE4\u4E00\u5F8B\u62D2\u7D55\uFF09",
  auto: "\u81EA\u52D5\uFF08Claude Code \u81EA\u52D5\u5224\u65B7\uFF0C\u64CB\u4E0B\u7684\u624D\u554F\u4E3B\u4EBA\uFF09"
};
var modeName = (m) => MODE_NAMES[m] ?? m;
var k = (n) => n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
var menus = /* @__PURE__ */ new Map();
var seq3 = 0;
function remember(conv, who, slash, candidates) {
  const now = Date.now();
  for (const [id2, m] of menus) if (now - m.at > 15 * 60 * 1e3) menus.delete(id2);
  const id = `${now.toString(36)}${(++seq3).toString(36)}`;
  menus.set(id, { conv, who, slash, candidates, at: now });
  return id;
}
async function applyModel(c, model) {
  const ts = convState(c);
  ts.model = model;
  saveState();
  const s = liveSession(c.key);
  if (s?.usable) {
    try {
      await s.setModel(model);
    } catch (e) {
      log("command", `${c.key} setModel ${model} failed: ${e.message}`);
      return `\u26A0\uFE0F \u5DF2\u8A18\u4E0B **${model}**\uFF0C\u4F46\u76EE\u524D\u7684 session \u5207\u63DB\u5931\u6557\uFF0C\u4E0B\u4E00\u6BB5\u5C0D\u8A71\u958B\u59CB\u751F\u6548\u3002`;
    }
  }
  log("command", `${c.key} model -> ${model}${s?.usable ? " (live)" : ""}`);
  return `\u{1F501} \u6A21\u578B\u5DF2\u5207\u63DB\u70BA **${model}**\uFF0C\u63A5\u4E0B\u4F86\u7684\u56DE\u61C9\u5C31\u7528\u5B83\u3002`;
}
async function applyEffort(c, level2) {
  const ts = convState(c);
  ts.effort = level2 ?? void 0;
  saveState();
  const shown = level2 ?? `\u9810\u8A2D${effective(c, ts).effort ? `\uFF08\u7D81\u5B9A\u7684 ${effective(c, ts).effort}\uFF09` : ""}`;
  const s = liveSession(c.key);
  if (s?.usable) {
    try {
      await s.setEffort(level2 ?? effective(c, ts).effort ?? null);
    } catch (e) {
      log("command", `${c.key} setEffort ${level2} failed: ${e.message}`);
      if (!s.busy && !isPending(c.key)) await release(c.key, "effort");
      return `\u26A0\uFE0F \u5DF2\u8A18\u4E0B\u52AA\u529B\u7A0B\u5EA6 **${shown}**\uFF0C\u4F46\u76EE\u524D\u7684 session \u6C92\u8FA6\u6CD5\u76F4\u63A5\u5207\u63DB\uFF0C\u4E0B\u4E00\u5247\u8A0A\u606F\u958B\u59CB\u751F\u6548\u3002`;
    }
  }
  log("command", `${c.key} effort -> ${level2 ?? "default"}${s?.usable ? " (live)" : ""}`);
  return `\u{1F9E0} \u52AA\u529B\u7A0B\u5EA6\u5DF2\u8A2D\u70BA **${shown}**\uFF0C\u63A5\u4E0B\u4F86\u7684\u56DE\u61C9\u5C31\u7528\u5B83\u3002`;
}
async function statusText(c) {
  const ts = convState(c);
  const ch = effective(c, ts);
  const s = liveSession(c.key);
  const pin = pinGate.state();
  const lines = [
    `\u{1F4CA} **\u72C0\u614B**\uFF08${c.kind === "dm" ? "\u79C1\u8A0A" : "\u9019\u500B\u8A0E\u8AD6\u4E32"}\uFF09`,
    `\u30FB\u5DE5\u4F5C\u76EE\u9304\uFF1A\`${s?.cwd ?? ch.cwd}\``,
    `\u30FB\u6A21\u578B\uFF1A${ts.model ?? ch.model ?? "Claude Code \u9810\u8A2D"}${s?.model ? `\uFF08\u5BE6\u969B\uFF1A${s.model}\uFF09` : ""}`,
    `\u30FB\u52AA\u529B\u7A0B\u5EA6\uFF1A${ts.effort ?? ch.effort ?? "Claude Code \u9810\u8A2D"}${s?.effortActual ? `\uFF08\u5BE6\u969B\uFF1A${s.effortActual}\uFF09` : ""}`,
    `\u30FB\u6B0A\u9650\u6A21\u5F0F\uFF1A${modeName(s?.mode ?? ch.permissionMode)}${ts.plan ? "\uFF0C\u7528 !plan \u53EF\u5207\u56DE" : ""}`,
    `\u30FB\u5C0D\u8A71\uFF1A${s?.usable ? `session \u5DF2\u958B ${duration(Date.now() - s.startedAt)}${s.busy ? "\uFF0C\u6B63\u5728\u5DE5\u4F5C" : "\uFF0C\u9592\u7F6E\u4E2D"}` : ts.sessionId ? "\u5DF2\u66AB\u505C\uFF08\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u56DE\uFF09" : "\u9084\u6C92\u6709\u5C0D\u8A71"}`,
    ...ts.source ? [`\u30FB\u4F86\u6E90\uFF1A${ts.source}`] : [],
    ...ts.takeover ? [`\u30FB\u{1F5A5}\uFE0F \u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\uFF08${shortTime(ts.takeover.at)} \u8D77\uFF0C\u8A18\u4E0B ${ts.takeover.queued.length} \u5247\u8A0A\u606F\uFF09\uFF1B\u96FB\u8166\u4E0A\u7528 /channelcollab:release \u4EA4\u9084\uFF0C\u6216\u5728\u9019\u88E1\u7528 /takeback \u5F37\u5236\u63A5\u56DE`] : [],
    `\u30FB\u55AE\u8F2A\u5DE5\u4F5C\u4E0A\u9650\uFF1A${ch.turnTimeoutMs ? `${limitLabel(ch.turnTimeoutMs)}\uFF08\u7B49\u4EBA\u6309\u6309\u9215\u7684\u6642\u9593\u4E0D\u7B97\uFF09` : "\u4E0D\u9650\uFF08\u8981\u505C\u6B62\u8ACB\u6309 \u{1F6D1} \u6216\u7528 /stop\uFF09"}`,
    `\u30FB\u55AE\u8F2A\u6B65\u6578\u4E0A\u9650\uFF1A${ch.maxTurns ? `${ch.maxTurns} \u6B65` : "\u4E0D\u9650"}`,
    `\u30FB\u672C\u6BB5\u5C0D\u8A71\u82B1\u8CBB\uFF1A\u7D04 $${ts.lastCostTotal.toFixed(2)}`,
    `\u30FB\u4E0A\u4E0B\u6587\uFF1A${ts.ctx ? `${ts.ctx.pct}%${ts.ctx.tokens && ts.ctx.max ? `\uFF08${k(ts.ctx.tokens)} / ${k(ts.ctx.max)} tokens\uFF09` : ""}` : "\u672A\u77E5\uFF08\u8DD1\u904E\u4E00\u8F2A\u5F8C\u624D\u77E5\u9053\uFF09"}`,
    `\u30FB\u984D\u5EA6\uFF1A${rateSummary(latestRateLimit())}`,
    `\u30FBPIN\uFF1A${!pin.configured ? "\u672A\u8A2D\u5B9A" : pin.locked ? "\u{1F512} \u5DF2\u9396\u5B9A" : pin.unlockedUntil ? `\u514D\u8F38\u5165\u5230 ${shortTime(pin.unlockedUntil)}` : "\u6838\u51C6\u6642\u8981\u8F38\u5165"}`
  ];
  return lines.join("\n");
}
async function queueTurn(c, io, who, prompt, kind, label2) {
  const trigger = await io.anchor(label2);
  const status = new StatusReactions(trigger);
  await status.set("received");
  const { queued } = enqueue(c.key, () => runTurn(c, trigger, status, who, { prompt, kind }));
  if (queued) await status.set("waiting");
}
function skillListText(list, slash) {
  if (!list?.length) return `${NO_LIST_TEXT}\u3002`;
  const shown = list.slice(0, 40).map((s) => `\`${s.name}\`${s.hint ? ` ${s.hint}` : ""}${s.description ? `\u3000${s.description.replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
  const more = list.length > shown.length ? `
\u2026\u9084\u6709 ${list.length - shown.length} \u500B` : "";
  return `**\u53EF\u4EE5\u7528\u7684 skill\uFF0F\u81EA\u8A02\u6307\u4EE4**\uFF08${slash ? "`/skill` \u9078\u540D\u7A31" : "`!skill <\u540D\u7A31> [\u53C3\u6578]`"}\uFF09
${shown.join("\n")}${more}`;
}
function resumeCandidates() {
  const config2 = loadConfig();
  const dmCwd = resolveDm(config2)?.cwd ?? "";
  const out = [];
  for (const d of dmHistory()) {
    if (!d.sessionId) continue;
    out.push({ kind: "dm", id: d.sessionId, sessionId: d.sessionId, cwd: d.cwd ?? dmCwd, at: d.lastAt ?? d.createdAt, source: d.source ?? "\u79C1\u8A0A", summary: d.last ?? d.first ?? d.source ?? "" });
  }
  for (const [id, t] of allThreads()) {
    const cwd = config2.channels[t.channelId] ? t.cwd ?? config2.channels[t.channelId].cwd : void 0;
    if (!t.sessionId || !cwd) continue;
    out.push({ kind: "thread", id, sessionId: t.sessionId, cwd, at: t.lastAt ?? t.createdAt, source: t.name ?? `\u8A0E\u8AD6\u4E32 ${id}`, summary: t.last ?? t.first ?? t.name ?? "" });
  }
  return resumeList(out);
}
async function runCommand(cmd, c, io, who) {
  const ts = convState(c);
  const p = io.slash ? "/" : "!";
  log("command", `${c.key} ${p}${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ""}${cmd.rest ? ` ${brief(cmd.rest, 80)}` : ""} by ${io.actor.name}`);
  switch (cmd.name) {
    case "help":
      await io.tell(helpText(c.kind));
      return;
    case "status":
      await io.tell(await statusText(c));
      return;
    case "stop": {
      const s = liveSession(c.key);
      if (s?.busy && await s.interrupt(io.actor.name)) await io.ack("\u23F9\uFE0F", `\u23F9\uFE0F ${io.actor.name} \u505C\u6B62\u4E86\u9019\u4E00\u8F2A\u3002`);
      else await io.tell("\u76EE\u524D\u6C92\u6709\u5728\u57F7\u884C\u7684\u5DE5\u4F5C\u3002");
      return;
    }
    case "model": {
      if (cmd.arg) {
        const model = normalizeModel(cmd.arg);
        if (model) await io.note(await applyModel(c, model));
        else await io.tell(`\u4E0D\u8A8D\u5F97\u300C${cmd.arg}\u300D\u3002\u53EF\u4EE5\u7528 haiku\u3001sonnet\u3001opus\u3002`);
        return;
      }
      const id = remember(c, who, io.slash);
      const current = ts.model ?? effective(c, ts).model ?? "Claude Code \u9810\u8A2D";
      await io.tell(`\u76EE\u524D\u7684\u6A21\u578B\uFF1A**${current}**\u3002\u8981\u63DB\u6210\u54EA\u4E00\u500B\uFF1F`, [
        new ActionRowBuilder5().addComponents(
          ...MODEL_CHOICES.map((m) => new ButtonBuilder4().setCustomId(`ccmd:model:${id}:${m.alias}`).setLabel(`${m.label}\uFF08${m.note}\uFF09`).setStyle(m.alias === current ? ButtonStyle4.Primary : ButtonStyle4.Secondary))
        )
      ]);
      return;
    }
    case "effort": {
      if (cmd.arg) {
        const level2 = normalizeEffort(cmd.arg);
        if (level2 !== void 0) await io.note(await applyEffort(c, level2));
        else await io.tell(`\u4E0D\u8A8D\u5F97\u300C${cmd.arg}\u300D\u3002\u53EF\u4EE5\u7528 ${EFFORT_CHOICES.map((e) => e.level).join("\u3001")}\uFF0C\u6216 default \u56DE\u5230\u9810\u8A2D\u3002`);
        return;
      }
      const id = remember(c, who, io.slash);
      const current = ts.effort ?? effective(c, ts).effort;
      const rows2 = [
        new ActionRowBuilder5().addComponents(
          ...EFFORT_CHOICES.map((e) => new ButtonBuilder4().setCustomId(`ccmd:effort:${id}:${e.level}`).setLabel(`${e.label}\uFF08${e.note}\uFF09`).setStyle(e.level === current ? ButtonStyle4.Primary : ButtonStyle4.Secondary))
        ),
        new ActionRowBuilder5().addComponents(new ButtonBuilder4().setCustomId(`ccmd:effort:${id}:default`).setLabel("\u56DE\u5230\u9810\u8A2D").setStyle(current ? ButtonStyle4.Secondary : ButtonStyle4.Primary))
      ];
      await io.tell(`\u76EE\u524D\u7684\u52AA\u529B\u7A0B\u5EA6\uFF1A**${current ?? "Claude Code \u9810\u8A2D"}**\u3002\u8981\u63DB\u6210\u54EA\u4E00\u500B\uFF1F`, rows2);
      return;
    }
    case "takeback": {
      if (!ts.takeover) return void await io.tell("\u9019\u6BB5\u5C0D\u8A71\u6C92\u6709\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\uFF0C\u4E0D\u9700\u8981\u63A5\u56DE\u3002");
      const r = await giveBack(io.client, c.key, { forced: true, by: io.actor.name });
      if (!r.ok) await io.tell(`\u274C \u63A5\u56DE\u5931\u6557\uFF1A${r.error}`);
      else if (io.slash) await io.tell("\u2705 \u5DF2\u63A5\u56DE\u3002");
      return;
    }
    case "plan": {
      const next = !ts.plan;
      const mode = next ? "plan" : c.base.permissionMode;
      const s = liveSession(c.key);
      if (s?.usable) {
        try {
          await s.setMode(mode);
        } catch (e) {
          log("command", `${c.key} setMode ${mode} failed: ${e.message}`);
          await io.tell("\u26A0\uFE0F \u5207\u63DB\u5931\u6557\uFF0C\u6A21\u5F0F\u6C92\u6709\u6539\u8B8A\u3002");
          return;
        }
      }
      ts.plan = next || void 0;
      saveState();
      await io.note(next ? `\u{1F4DD} \u5DF2\u5207\u5230\u8A08\u756B\u6A21\u5F0F\uFF1AClaude \u53EA\u8A0E\u8AD6\u3001\u4E0D\u6539\u6A94\u4E5F\u4E0D\u57F7\u884C\u6307\u4EE4\u3002\u518D\u7528\u4E00\u6B21 ${p}plan \u5207\u56DE\uFF08${modeName(c.base.permissionMode)}\uFF09\u3002` : `\u25B6\uFE0F \u5DF2\u5207\u56DE${modeName(mode)}\uFF0CClaude \u53EF\u4EE5\u52D5\u624B\u4E86\u3002`);
      return;
    }
    case "compact":
      if (!ts.sessionId) return void await io.tell("\u9084\u6C92\u6709\u5C0D\u8A71\uFF0C\u4E0D\u9700\u8981\u58D3\u7E2E\u3002");
      await queueTurn(c, io, who, "/compact", "compact", `\u{1F5DC}\uFE0F ${io.actor.name} \u8981\u6C42\u58D3\u7E2E\u4E0A\u4E0B\u6587\u3002`);
      return;
    case "retry":
      if (!ts.lastPrompt) return void await io.tell("\u6C92\u6709\u53EF\u4EE5\u91CD\u9001\u7684\u8A0A\u606F\u3002");
      await queueTurn(c, io, who, ts.lastPrompt, "retry", `\u{1F501} ${io.actor.name} \u8981\u6C42\u628A\u4E0A\u4E00\u5247\u8A0A\u606F\u91CD\u9001\u4E00\u6B21\u3002`);
      return;
    case "skill": {
      const list = skillsFor(effective(c, ts).cwd);
      if (!cmd.arg) return void await io.tell(skillListText(list, io.slash));
      const r = skillPrompt(list, cmd.arg, cmd.rest);
      if (!r.ok) {
        log("command", `${c.key} ${p}skill ${brief(cmd.arg, 60)} refused (${r.reason})`);
        await io.tell(r.reason === "no-list" ? `${NO_LIST_TEXT}\u3002` : `\u6C92\u6709\u53EB\u300C${cmd.arg.slice(0, 60)}\u300D\u7684 skill\u3002${io.slash ? "\u8ACB\u5F9E\u9078\u55AE\u9078\u4E00\u500B\u3002" : "\u6253 `!skill` \u770B\u6E05\u55AE\u3002"}`);
        return;
      }
      ts.lastPrompt = r.prompt;
      saveState();
      await queueTurn(c, io, who, r.prompt, "skill", `\u{1F9E9} ${io.actor.name} \u57F7\u884C \`${r.prompt.slice(0, 200)}\``);
      return;
    }
    case "clear": {
      if (ts.takeover) return void await io.tell(`\u{1F5A5}\uFE0F \u9019\u6BB5\u5C0D\u8A71\u6B63\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\u3002\u5148\u5728\u96FB\u8166\u4E0A\u4EA4\u9084\uFF08/channelcollab:release\uFF09\uFF0C\u6216\u7528 ${p}takeback \u63A5\u56DE\uFF0C\u518D\u7528 ${p}clear\u3002`);
      if (liveSession(c.key)?.busy || isPending(c.key)) return void await io.tell(`Claude \u9084\u5728\u8655\u7406\uFF0C\u5148\u7528 ${p}stop \u505C\u4E0B\u4F86\uFF0C\u518D\u7528 ${p}clear\u3002`);
      await release(c.key, "clear");
      switchDm();
      await io.note(`\u{1F195} \u5DF2\u7D50\u675F\u76EE\u524D\u7684\u5C0D\u8A71\uFF08\u4E4B\u5F8C\u53EF\u4EE5\u7528 ${p}resume \u63A5\u56DE\uFF09\u3002\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u958B\u65B0\u7684\u5C0D\u8A71\u3002`);
      return;
    }
    case "resume": {
      if (ts.takeover) return void await io.tell(`\u{1F5A5}\uFE0F \u76EE\u524D\u7684\u79C1\u8A0A\u5C0D\u8A71\u6B63\u5728\u96FB\u8166\u4E0A\u63A5\u624B\u4E2D\u3002\u5148\u4EA4\u9084\u6216\u7528 ${p}takeback \u63A5\u56DE\uFF0C\u518D\u63A5\u56DE\u5225\u7684\u5C0D\u8A71\u3002`);
      const list = resumeCandidates();
      if (!list.length) return void await io.tell("\u9084\u6C92\u6709\u53EF\u4EE5\u63A5\u56DE\u7684\u5C0D\u8A71\u3002");
      for (const cand of list) {
        if (cand.kind !== "thread" || getThread(cand.id)?.name) continue;
        const ch = await io.client.channels.fetch(cand.id).catch(() => null);
        if (ch && "name" in ch && ch.name) {
          cand.source = ch.name;
          if (!cand.summary || cand.summary.startsWith("\u8A0E\u8AD6\u4E32 ")) cand.summary = ch.name;
          getThread(cand.id).name = ch.name;
        }
      }
      saveState();
      const id = remember(c, who, io.slash, list);
      await io.tell("\u8981\u63A5\u56DE\u54EA\u4E00\u6BB5\u5C0D\u8A71\uFF1F\uFF08\u8A0E\u8AD6\u4E32\u7684\u5C0D\u8A71\u6703\u8907\u88FD\u4E00\u4EFD\u5206\u652F\u4F86\u63A5\uFF0C\u4E0D\u5F71\u97FF\u8A0E\u8AD6\u4E32\u672C\u8EAB\uFF09", [
        new ActionRowBuilder5().addComponents(
          new StringSelectMenuBuilder3().setCustomId(`ccmd:resume:${id}`).setPlaceholder("\u9078\u4E00\u6BB5\u5C0D\u8A71").addOptions(list.map((cand, n) => ({ ...resumeOption(cand), value: String(n) })))
        )
      ]);
      return;
    }
  }
}
function messageIO(message) {
  const reply = async (content, components) => {
    await message.reply({ content, ...components ? { components } : {}, allowedMentions: { parse: [] } });
  };
  return {
    actor: { id: message.author.id, name: message.author.displayName || message.author.username },
    client: message.client,
    slash: false,
    tell: reply,
    note: reply,
    ack: async (emoji) => void await message.react(emoji).catch(() => {
    }),
    anchor: async () => message
  };
}
async function publicNote(c, content) {
  await c.room.send({ content, allowedMentions: { parse: [] } }).catch((e) => log("command", `${c.key} note failed: ${e.message}`));
}
function isCommandInteraction(i) {
  return (i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith("ccmd:");
}
async function handleCommandInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  const [, what, id, arg] = i.customId.split(":");
  const m = menus.get(id);
  if (!m) {
    await i.reply({ content: "\u9019\u500B\u9078\u55AE\u5DF2\u7D93\u5931\u6548\uFF08\u8D85\u904E 15 \u5206\u9418\u6216 Bot \u91CD\u555F\u904E\uFF09\uFF0C\u8ACB\u91CD\u6253\u4E00\u6B21\u6307\u4EE4\u3002", flags: MessageFlags5.Ephemeral });
    return;
  }
  if (!canAct("stop", i.user.id, m.who)) {
    await i.reply({ content: "\u53EA\u6709 Bot \u7684\u4E3B\u4EBA\u6216\u63D0\u51FA\u9700\u6C42\u7684\u4EBA\u53EF\u4EE5\u7528\u9019\u500B\u9078\u55AE\u3002", flags: MessageFlags5.Ephemeral });
    return;
  }
  if (what === "model" && i.isButton()) {
    menus.delete(id);
    const text = await applyModel(m.conv, arg);
    await i.update({ content: text, components: [] });
    if (m.slash) await publicNote(m.conv, `${text}\uFF08${i.user.displayName || i.user.username}\uFF09`);
    return;
  }
  if (what === "effort" && i.isButton()) {
    menus.delete(id);
    const text = await applyEffort(m.conv, normalizeEffort(arg) ?? null);
    await i.update({ content: text, components: [] });
    if (m.slash) await publicNote(m.conv, `${text}\uFF08${i.user.displayName || i.user.username}\uFF09`);
    return;
  }
  if (what === "resume" && i.isStringSelectMenu()) {
    const pick = m.candidates?.[Number(i.values[0])];
    if (!pick) return;
    if (liveSession(DM_KEY)?.busy || isPending(DM_KEY)) {
      await i.reply({ content: "Claude \u9084\u5728\u8655\u7406\uFF0C\u5148\u7528 /stop\uFF08\u6216 !stop\uFF09\u505C\u4E0B\u4F86\u518D\u63A5\u56DE\u3002", flags: MessageFlags5.Ephemeral });
      return;
    }
    menus.delete(id);
    await i.update({ content: "\u23F3 \u63A5\u56DE\u4E2D\u2026", components: [] });
    try {
      const text = await resumeInto(i.client, pick);
      await i.editReply({ content: text });
      if (m.slash) await publicNote(m.conv, text);
    } catch (e) {
      log("error", `resume ${pick.sessionId}: ${e.stack ?? e}`);
      await i.editReply({ content: `\u274C \u63A5\u56DE\u5931\u6557\uFF1A${e.message.slice(0, 200)}` });
    }
  }
}
async function resumeInto(_client, pick) {
  await release(DM_KEY, "resume");
  if (pick.kind === "dm") {
    const rec = dmHistory().find((h) => h.sessionId === pick.sessionId);
    switchDm(rec);
    log("command", `dm resumed ${pick.sessionId}`);
    return `\u21A9\uFE0F \u5DF2\u63A5\u56DE ${shortTime(pick.at)} \u7684\u79C1\u8A0A\u5C0D\u8A71\u3002\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u804A\u3002`;
  }
  const t = getThread(pick.id);
  const fork = await forkSession2(pick.sessionId, { dir: pick.cwd });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  switchDm({
    channelId: DM_KEY,
    sessionId: fork.sessionId,
    cwd: pick.cwd,
    source: `\u8A0E\u8AD6\u4E32\u300C${pick.source}\u300D\u7684\u5206\u652F`,
    lastCostTotal: t?.lastCostTotal ?? 0,
    resumeCostBase: t?.resumeCostBase ?? t?.lastCostTotal ?? 0,
    createdAt: now,
    lastAt: now,
    first: `\uFF08\u63A5\u7E8C\u8A0E\u8AD6\u4E32\u300C${pick.source}\u300D\uFF09`,
    ...t?.model ? { model: t.model } : {}
  });
  log("command", `dm forked thread ${pick.id} session ${pick.sessionId} -> ${fork.sessionId} cwd=${pick.cwd}`);
  return `\u21A9\uFE0F \u5DF2\u5F9E\u8A0E\u8AD6\u4E32\u300C${pick.source}\u300D\u8907\u88FD\u4E00\u4EFD\u5C0D\u8A71\u63A5\u56DE\uFF08\u8A0E\u8AD6\u4E32\u672C\u8EAB\u4E0D\u53D7\u5F71\u97FF\uFF09\u3002\u5DE5\u4F5C\u76EE\u9304\uFF1A\`${pick.cwd}\`\u3002\u4E0B\u4E00\u5247\u8A0A\u606F\u6703\u63A5\u8457\u804A\u3002`;
}

// src/discord/slash.ts
import {
  ActionRowBuilder as ActionRowBuilder6,
  ButtonBuilder as ButtonBuilder5,
  ButtonStyle as ButtonStyle5,
  MessageFlags as MessageFlags6
} from "discord.js";
async function starterHuman(thread) {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  return starter && !starter.author.bot ? starter.author.id : void 0;
}
async function threadWho(thread, ownerId) {
  return { ownerId, requesterId: running.get(thread.id)?.requesterId ?? await starterHuman(thread) };
}
async function registerSlashCommands(client2) {
  const defs = slashDefinitions();
  try {
    const r = await client2.application.commands.set(defs.map((d) => ({ toJSON: () => d })));
    log("commands", `registered ${r.size} global slash commands: ${[...r.values()].map((c) => `/${c.name}`).join(" ")}`);
  } catch (e) {
    log("commands", `slash command registration failed: ${e.message}`);
  }
}
async function place(i, cmd, config2, light = false) {
  const me = i.client.user.id;
  const ownerId = botOwner(config2.discord.owner_id, me);
  const base = { cmd, actorId: i.user.id, ownerId, locked: pinGate.locked };
  if (!i.inGuild()) {
    let dm;
    try {
      dm = resolveDm(config2);
    } catch (e) {
      log("config", e.message);
    }
    const facts2 = { ...base, where: "dm", dmEnabled: !!dm, pinSet: pinGate.configured, pinUnlocked: pinGate.unlocked };
    const ok = !commandGate(facts2);
    const cwd = dm ? getDm().cwd ?? dm.cwd : void 0;
    return { where: "dm", facts: facts2, who: { ownerId }, cwd, conv: ok && !light ? await convFor(i.client, DM_KEY) : void 0 };
  }
  const ch = i.channel ?? (light ? null : await i.client.channels.fetch(i.channelId).catch(() => null));
  const inThread = !!ch?.isThread();
  const baseId = inThread ? ch.parentId ?? "" : i.channelId;
  let channel;
  try {
    channel = resolveChannel(config2, baseId);
  } catch (e) {
    log("config", e.message);
  }
  const bound = !!channel && (!config2.discord.guild_id || i.guildId === config2.discord.guild_id);
  const notAllowed = config2.access.roster_only && !allowedTrigger(i.user.id, ownerId, loadRosterFile());
  const who = inThread && bound && !notAllowed ? light ? { ownerId, requesterId: running.get(ch.id)?.requesterId } : await threadWho(ch, ownerId) : { ownerId };
  const facts = { ...base, where: inThread ? "thread" : "channel", bound, notAllowed, requesterId: who.requesterId };
  if (commandGate(facts) || !inThread || !channel) return { where: inThread ? "thread" : "channel", facts, who };
  const thread = ch;
  return { where: "thread", facts, who, cwd: channel.cwd, conv: { key: thread.id, kind: "thread", room: thread, base: channel, selfId: me } };
}
function slashIO(i) {
  let answered = false;
  const publicNote2 = async (content) => {
    const m = await i.followUp({ content, allowedMentions: { parse: [] } });
    return m;
  };
  return {
    actor: { id: i.user.id, name: i.user.displayName || i.user.username },
    client: i.client,
    slash: true,
    tell: async (content, components) => {
      answered = true;
      await i.editReply({ content, ...components ? { components } : {}, allowedMentions: { parse: [] } });
    },
    note: async (content) => void await publicNote2(content),
    ack: async (_emoji, content) => void await publicNote2(content),
    anchor: publicNote2,
    // The ephemeral "thinking…" placeholder is removed when only public notes were posted.
    finish: async () => {
      if (!answered) await i.deleteReply().catch(() => {
      });
    }
  };
}
function refusalText(r, p) {
  return gateText(r, { cmd: p.facts.cmd, ownerId: p.who.ownerId, requesterId: p.who.requesterId, slash: true });
}
var unlockRow = () => new ActionRowBuilder6().addComponents(new ButtonBuilder5().setCustomId("dmunlock").setLabel("\u89E3\u9396").setEmoji("\u{1F513}").setStyle(ButtonStyle5.Primary));
async function handleSlashCommand(i) {
  if (i.applicationId !== i.client.application.id) return;
  await i.deferReply({ flags: MessageFlags6.Ephemeral });
  const cmd = commandFromSlash(i.commandName, { name: i.options.getString("name") ?? void 0, args: i.options.getString("args") ?? void 0, level: i.options.getString("level") ?? void 0 });
  if (!cmd) return void await i.editReply({ content: "\u9019\u96BB Bot \u4E0D\u8A8D\u5F97\u9019\u500B\u6307\u4EE4\u3002" });
  let config2;
  try {
    config2 = loadConfig();
  } catch (e) {
    log("config", e.message);
    return void await i.editReply({ content: "Bot \u7684\u8A2D\u5B9A\u6A94\u8B80\u4E0D\u5230\uFF0C\u8ACB\u4E3B\u4EBA\u5728\u96FB\u8166\u4E0A\u7528 /channelcollab:status \u6AA2\u67E5\u3002" });
  }
  const p = await place(i, cmd.name, config2);
  const refusal = commandGate(p.facts);
  if (refusal) {
    log("command", `/${cmd.name} refused ${i.user.username} (${i.user.id}) ${refusal} channel=${i.channelId ?? "dm"}`);
    await i.editReply({ content: refusalText(refusal, p), ...refusal === "dm-pin-needed" ? { components: [unlockRow()] } : {}, allowedMentions: { parse: [] } });
    return;
  }
  if (!p.conv) return void await i.editReply({ content: "\u627E\u4E0D\u5230\u9019\u6BB5\u5C0D\u8A71\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002" });
  if (p.conv.kind === "thread") {
    const thread = p.conv.room;
    if (!getThread(thread.id)) {
      registerThread(thread.id, thread.parentId ?? "", thread.name);
      log("thread", `adopted ${thread.id} "${thread.name}" (slash command)`);
    }
  }
  const who = p.where === "dm" ? { ownerId: p.who.ownerId } : { ownerId: p.who.ownerId, requesterId: i.user.id === p.who.ownerId ? p.who.requesterId : i.user.id };
  const io = slashIO(i);
  await runCommand(cmd, p.conv, io, who);
  await io.finish();
}
async function handleSlashAutocomplete(i) {
  if (i.applicationId !== i.client.application.id || i.commandName !== "skill") return;
  let config2;
  try {
    config2 = loadConfig();
  } catch {
    return void await i.respond([]);
  }
  const p = await place(i, "skill", config2, true);
  const r = commandGate(p.facts);
  if (r && r !== "not-actor" || !p.cwd) return void await i.respond([]);
  await i.respond(skillChoices(skillsFor(p.cwd), String(i.options.getFocused() ?? "")));
}

// src/discord/bot.ts
function threadName(message) {
  const text = message.content.replace(/<@[!&]?\d+>/g, "").replace(/\s+/g, " ").trim();
  return (text || "Claude \u4EFB\u52D9").slice(0, 60);
}
function roleMentions(message) {
  return [...message.mentions.roles.values()].map((r) => ({ id: r.id, botId: r.tags?.botId ?? null }));
}
function mentionsBot(message, exceptId) {
  return message.mentions.users.some((u) => u.bot && u.id !== exceptId) || message.inGuild() && mentionsOtherBotRole(roleMentions(message), exceptId);
}
async function openThread(message) {
  try {
    return await message.startThread({ name: threadName(message), autoArchiveDuration: ThreadAutoArchiveDuration3.OneDay });
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
function createBot() {
  const client2 = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    // A direct message channel is often not cached yet; without this its messages never arrive.
    partials: [Partials.Channel]
  });
  client2.on(Events.MessageCreate, (message) => {
    onMessage(message).catch((e) => log("error", `message ${message.id}: ${e.stack ?? e}`));
  });
  client2.once(Events.ClientReady, (c) => {
    let config2;
    try {
      config2 = loadConfig();
    } catch {
    }
    const configured = config2?.discord.owner_id;
    const owner = botOwner(configured, c.user.id);
    log("owner", owner ? `${owner} (${configured ? "discord.owner_id" : "roster"})` : "none: set discord.owner_id, or permission requests are denied");
    const roster = loadRosterFile();
    log("roster", `${roster.bots.length} bots, ${roster.members.length} members from ${ROSTER_PATH}`);
    const dm = config2 && resolveDm(config2);
    log("dm", `intent DirectMessages on; ${dm ? `dm configured cwd=${dm.cwd} mode=${dm.permissionMode} model=${dm.model ?? "-"} launcher=${dm.launcher || "builtin"}${pinGate.configured ? "" : " (closed until a PIN is set)"}` : "dm not configured (direct messages closed)"}`);
    log("security", `pin=${pinGate.configured ? "set" : "not set"} unlock_minutes=${config2?.security.pin_unlock_minutes ?? "-"} roster_only=${config2?.access.roster_only ?? "-"} owner_wait_minutes=${config2?.defaults.owner_wait_minutes ?? "-"}`);
    const channels = Object.keys(config2?.channels ?? {}).length;
    log("mode", channels && dm ? `channels (${channels}) and direct messages` : channels ? `channels only (${channels})` : dm ? "direct messages only (no channel bound)" : "nothing configured: bind a channel or turn on direct messages");
    void registerSlashCommands(c);
  });
  client2.on(Events.InteractionCreate, (i) => {
    onInteraction(i).catch((e) => log("error", `interaction ${"customId" in i ? i.customId : i.type}: ${e.stack ?? e}`));
  });
  return client2;
}
async function onInteraction(i) {
  if (i.isChatInputCommand()) await handleSlashCommand(i);
  else if (i.isAutocomplete()) await handleSlashAutocomplete(i);
  else if (i.isButton() && isDetailsButton(i.customId)) {
    log("details", `${i.customId} clicked by ${i.user.username}`);
    await handleDetailsClick(i);
  } else if (isPromptInteraction(i)) await handlePromptInteraction(i);
  else if (isApprovalInteraction(i)) await handleApprovalInteraction(i);
  else if (isCommandInteraction(i)) await handleCommandInteraction(i);
  else if ((i.isButton() || i.isModalSubmit()) && /^dmunlock/.test(i.customId)) await handleDmUnlock(i);
}
async function onMessage(message) {
  const me = message.client.user.id;
  if (message.author.id === me) return;
  if (pinGate.locked) {
    log("ignore", `${message.id} locked (wrong PINs) author=${message.author.username}`);
    return;
  }
  if (!message.inGuild()) return onDirectMessage(message);
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
  const mentionsMe = mentionsSelf({ userIds: message.mentions.users.keys(), roles: roleMentions(message) }, me, message.guild.members.me?.roles.botRole?.id);
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
  const mentions = [...message.mentions.users.keys(), ...message.mentions.roles.keys()].join(",");
  if (decision.action === "ignore") {
    if (decision.reason !== "unbound-channel") log("ignore", `${message.id} ${decision.reason} channel=${ch.id} owner=${ownerId ?? "-"} author=${message.author.username} mentions=[${mentions}] text=${brief(message.content, 80)}`);
    return;
  }
  if (!channel) return;
  const botOwnerId = botOwner(config2.discord.owner_id, me);
  if (config2.access.roster_only && !allowedTrigger(message.author.id, botOwnerId, loadRosterFile())) {
    log("ignore", `${message.id} not-allowed author=${message.author.username} (${message.author.id}) channel=${ch.id}`);
    return;
  }
  const cmd = fromBot ? void 0 : parseCommand(message.content);
  if (cmd && decision.action === "open-thread") {
    await message.reply({ content: gateText("not-thread", { cmd: cmd.name }), allowedMentions: { parse: [] } });
    return;
  }
  let thread;
  if (decision.action === "open-thread") {
    if (ch.type !== ChannelType3.GuildText) {
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
  const known = getThread(thread.id);
  if (!known) {
    registerThread(thread.id, baseChannelId, thread.name);
    if (ownerId !== me) log("thread", `adopted ${thread.id} "${thread.name}" owner=${ownerId ?? "-"}`);
  } else if (known.name !== thread.name) {
    known.name = thread.name;
    saveState();
  }
  const conv = { key: thread.id, kind: "thread", room: thread, base: channel, selfId: me };
  if (cmd) return threadCommand(cmd, conv, thread, message, botOwnerId);
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
    ownerId: botOwnerId,
    // A bot cannot click, and naming it in a prompt could trigger it.
    requesterId: fromBot ? void 0 : message.author.id
  };
  const { queued } = enqueue(thread.id, () => runTurn(conv, message, status, who));
  if (queued) {
    log("queue", `${message.id} waiting for thread ${thread.id}`);
    await status.set("waiting");
  }
}
async function threadCommand(cmd, conv, thread, message, ownerId) {
  const who = await threadWho(thread, ownerId);
  const refusal = commandGate({ cmd: cmd.name, where: "thread", actorId: message.author.id, ownerId, locked: pinGate.locked, bound: true, notAllowed: false, requesterId: who.requesterId });
  if (refusal) {
    log("command", `${conv.key} !${cmd.name} refused ${message.author.username} (${refusal})`);
    await message.reply({ content: gateText(refusal, { cmd: cmd.name, ownerId, requesterId: who.requesterId }), allowedMentions: { parse: [] } });
    return;
  }
  await runCommand(cmd, conv, messageIO(message), { ownerId, requesterId: message.author.id === ownerId ? who.requesterId : message.author.id });
}
var refused = /* @__PURE__ */ new Map();
var held2 = [];
var HELD_MAX = 20;
var unlockPrompted = 0;
async function dmChannel(message) {
  const ch = message.channel.partial ? await message.channel.fetch().catch(() => void 0) : message.channel;
  return ch?.type === ChannelType3.DM ? ch : void 0;
}
async function onDirectMessage(message) {
  if (message.author.bot) return;
  const room = await dmChannel(message);
  if (!room) return;
  const me = message.client.user.id;
  let config2;
  try {
    config2 = loadConfig();
  } catch (e) {
    log("config", e.message);
    return;
  }
  const ownerId = botOwner(config2.discord.owner_id, me);
  let dm;
  try {
    dm = resolveDm(config2);
  } catch (e) {
    log("config", e.message);
  }
  const access = dmAccess({ authorId: message.author.id, ownerId, dmEnabled: !!dm });
  const answer = async (text) => {
    if (throttle(refused, message.author.id)) await room.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {
    });
  };
  if (access === "not-owner") {
    log("ignore", `${message.id} dm-not-owner author=${message.author.username} (${message.author.id})`);
    return answer("\u9019\u96BB Bot \u53EA\u63A5\u53D7\u4E3B\u4EBA\u79C1\u8A0A\u3002");
  }
  if (access === "disabled" || !dm) {
    log("ignore", `${message.id} dm-disabled`);
    return answer("\u79C1\u8A0A\u672A\u958B\u555F\uFF1A\u8ACB\u5728\u96FB\u8166\u4E0A\u7528 /channelcollab:bind \u958B\u555F\u79C1\u8A0A\uFF08\u8981\u5148\u8A2D\u5B9A PIN\uFF09\u3002");
  }
  if (!pinGate.configured) {
    log("ignore", `${message.id} dm-no-pin`);
    return answer(NO_PIN_TEXT);
  }
  if (!pinGate.unlocked) {
    if (held2.length < HELD_MAX) held2.push(message);
    log("dm", `${message.id} held until the PIN is entered (${held2.length} waiting)`);
    await message.react("\u{1F512}").catch(() => {
    });
    if (Date.now() - unlockPrompted > 60 * 1e3) {
      unlockPrompted = Date.now();
      await room.send({
        content: `\u{1F512} \u79C1\u8A0A\u8981\u5148\u8F38\u5165 PIN \u89E3\u9396\uFF08\u89E3\u9396\u5F8C ${config2.security.pin_unlock_minutes} \u5206\u9418\u5167\u4E0D\u7528\u518D\u8F38\u5165\uFF09\u3002\u525B\u525B\u7684\u8A0A\u606F\u6703\u5728\u89E3\u9396\u5F8C\u63A5\u8457\u8655\u7406\u3002`,
        components: [new ActionRowBuilder7().addComponents(new ButtonBuilder6().setCustomId("dmunlock").setLabel("\u89E3\u9396").setEmoji("\u{1F513}").setStyle(ButtonStyle6.Primary))]
      });
    }
    return;
  }
  await handleDm(message, dm, ownerId);
}
async function handleDm(message, dm, ownerId) {
  const room = await dmChannel(message);
  if (!room) return;
  const conv = { key: DM_KEY, kind: "dm", room, base: dm, selfId: message.client.user.id };
  const who = { ownerId };
  const cmd = parseCommand(message.content);
  if (cmd) return runCommand(cmd, conv, messageIO(message), who);
  log("trigger", `${message.id} dm author=${message.author.username} text=${brief(message.content, 120)}`);
  const status = new StatusReactions(message);
  await status.set("received");
  const { queued } = enqueue(DM_KEY, () => runTurn(conv, message, status, who));
  if (queued) {
    log("queue", `${message.id} waiting for dm`);
    await status.set("waiting");
  }
}
async function handleDmUnlock(i) {
  if (!i.isButton() && !i.isModalSubmit()) return;
  const config2 = loadConfig();
  const ownerId = botOwner(config2.discord.owner_id, i.client.user.id);
  if (!canAct("permission", i.user.id, { ownerId })) {
    await i.reply({ content: "\u53EA\u6709 Bot \u7684\u4E3B\u4EBA\u53EF\u4EE5\u89E3\u9396\u3002", flags: MessageFlags7.Ephemeral });
    return;
  }
  if (pinGate.locked) {
    await i.reply({ content: LOCKED_REPLY, flags: MessageFlags7.Ephemeral });
    return;
  }
  if (i.isButton()) {
    if (pinGate.unlocked) {
      await i.update({ content: "\u{1F513} \u5DF2\u7D93\u89E3\u9396\u4E86\u3002", components: [] });
      return;
    }
    await i.showModal(pinModal("dmunlockpin", "\u89E3\u9396\u79C1\u8A0A"));
    return;
  }
  const announce = (text) => i.channel?.isSendable() ? i.channel.send({ content: text, allowedMentions: { parse: [] } }) : Promise.resolve();
  if (!await checkPin(i, announce)) return;
  if (i.isFromMessage()) await i.update({ content: "\u{1F513} \u5DF2\u89E3\u9396\u3002", components: [] });
  else await i.deferUpdate();
  await pinOkFollowUp(i);
  const dm = resolveDm(config2);
  const waiting = held2.splice(0);
  log("dm", `unlocked; handling ${waiting.length} held message(s)`);
  if (!dm || !ownerId) return;
  for (const m of waiting) {
    await m.reactions.cache.get("\u{1F512}")?.users.remove(i.client.user.id).catch(() => {
    });
    await handleDm(m, dm, ownerId).catch((e) => log("error", `held dm ${m.id}: ${e.stack ?? e}`));
  }
}

// src/discord/control.ts
import { existsSync as existsSync5, realpathSync as realpathSync2, statSync as statSync3 } from "node:fs";
import path10 from "node:path";
import { getSessionInfo as getSessionInfo2 } from "@anthropic-ai/claude-agent-sdk";
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
function checkLocalFiles(files, zonesHome = DATA_DIR) {
  const ok = [];
  const rejected = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f !== "string" || !f) continue;
    try {
      const real = realpathSync2(path10.resolve(f));
      const zone = forbiddenPath(real, path10.dirname(real), { homes: [zonesHome], allow: [] });
      if (zone) rejected.push(`${f}\uFF1A\u7981\u5340\uFF08${zone}\uFF09\uFF0C\u4E0D\u80FD\u9644`);
      else if (!existsSync5(real) || !statSync3(real).isFile()) rejected.push(`${f}\uFF1A\u4E0D\u662F\u6A94\u6848`);
      else ok.push(real);
    } catch {
      rejected.push(`${f}\uFF1A\u627E\u4E0D\u5230`);
    }
  }
  if (ok.length > 10) rejected.push(...ok.splice(10).map((f) => `${f}\uFF1A\u4E00\u5247\u8A0A\u606F\u6700\u591A 10 \u500B\u6A94\u6848`));
  return { ok, rejected };
}
function controlHandlers(getClient) {
  const ready = () => {
    const c = getClient();
    if (!c?.isReady()) throw new Error("Bot \u9084\u6C92\u767B\u5165 Discord\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66");
    return c;
  };
  return {
    /** Who the bot is and where it can post: for the skills to list bots and channels. */
    async info() {
      const client2 = ready();
      const config2 = loadConfig();
      let dm = false;
      try {
        dm = !!resolveDm(config2);
      } catch {
      }
      return { ok: true, bot: { tag: client2.user.tag, id: client2.user.id }, channels: boundTargets(client2, config2), dm };
    },
    async post(a) {
      const client2 = ready();
      const text = typeof a.text === "string" ? a.text : "";
      const files = checkLocalFiles(a.files);
      if (files.rejected.length && !files.ok.length && !text.trim()) return { ok: false, error: files.rejected.join("\uFF1B") };
      let sessionId = str(a.sessionId);
      let cwd = str(a.cwd);
      if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
        const info = await getSessionInfo2(sessionId).catch(() => void 0);
        if (info) cwd = sessionFolder(info.cwd, cwd);
        else sessionId = void 0;
      }
      const r = await postReport(client2, {
        channel: str(a.channel) ?? "",
        text,
        files: files.ok,
        thread: str(a.thread),
        newThread: str(a.newThread),
        source: { kind: "cli" },
        // A new thread then continues from the computer's session (forked on its first trigger).
        ...sessionId && cwd && /^[0-9a-f-]{36}$/i.test(sessionId) ? { forkFrom: { sessionId, cwd } } : {}
      });
      log("control", `post ${r.ok ? `ok ${r.url}` : `failed: ${r.error}`}`);
      return { ...r, ...files.rejected.length ? { rejected: files.rejected } : {} };
    },
    async sessions() {
      ready();
      return { ok: true, sessions: sessionRows(loadConfig()) };
    },
    async takeover(a) {
      const key = str(a.key);
      if (!key) return { ok: false, error: "\u8981\u6307\u5B9A\u5C0D\u8A71\uFF08\u8A0E\u8AD6\u4E32 ID \u6216 dm\uFF09" };
      return takeOver(ready(), key);
    },
    async release(a) {
      const key = str(a.key);
      if (!key) return { ok: false, error: "\u8981\u6307\u5B9A\u5C0D\u8A71\uFF08\u8A0E\u8AD6\u4E32 ID \u6216 dm\uFF09" };
      return giveBack(ready(), key, { sessionId: str(a.sessionId) });
    },
    async handoff(a) {
      const sessionId = str(a.sessionId);
      if (!sessionId) return { ok: false, error: "\u8981\u7D66 session ID" };
      return handOff(ready(), { sessionId, cwd: str(a.cwd), target: str(a.target), title: str(a.title), summary: typeof a.summary === "string" ? a.summary : void 0 });
    }
  };
}

// src/ipc/control.ts
import net from "node:net";
var MAX_REQUEST_BYTES = 1024 * 1024;
function parseControlLine(line2) {
  const text = line2.trim();
  if (!text) return void 0;
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text);
      if (o && typeof o === "object" && typeof o.cmd === "string") {
        const { cmd, ...args } = o;
        return { cmd, args };
      }
    } catch {
    }
    return void 0;
  }
  return /^[a-z][a-z-]*$/.test(text) ? { cmd: text, args: {} } : void 0;
}
function createControlServer(handlers) {
  return net.createServer((socket) => {
    socket.on("error", () => {
    });
    socket.setEncoding("utf8");
    let buf = "";
    let done = false;
    socket.on("data", (d) => {
      if (done) return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length < MAX_REQUEST_BYTES) return;
      done = true;
      const req = nl < 0 ? void 0 : parseControlLine(buf.slice(0, nl));
      if (!req) return void socket.end(nl < 0 ? '{"ok":false,"error":"request too long"}\n' : "unknown command\n");
      const h = handlers[req.cmd];
      if (!h) return void socket.end("unknown command\n");
      h(req.args).then((r) => socket.end(`${typeof r === "string" ? r : JSON.stringify(r)}
`)).catch((e) => {
        log("control", `${req.cmd} failed: ${e.stack ?? e}`);
        socket.end(`${JSON.stringify({ ok: false, error: e.message })}
`);
      });
    });
  });
}

// src/main.ts
var DRAIN_MS = 5e3;
var config = loadConfig();
loadState();
log("start", `pid=${process.pid} home=${DATA_DIR} pipe=${STOP_PIPE} guild=${config.discord.guild_id ?? "-"} bound channels=${Object.keys(config.channels).join(", ") || "(none)"}`);
var client;
var stopServer = createControlServer({
  async stop() {
    setImmediate(() => void shutdown("stop command"));
    return `stopping pid=${process.pid}`;
  },
  // `unlock` from the control script: clear the lock after too many wrong PINs (only this HOME's bot).
  async unlock() {
    const was = pinGate.locked;
    pinGate.reset();
    log("pin", was ? "unlocked from the computer" : "unlock requested (was not locked)");
    return was ? "unlocked" : "not-locked";
  },
  async "pin-state"() {
    return pinGate.state();
  },
  // 0.1.8: report to a channel, list / take over / release conversations, hand one over (PLAN §21).
  ...controlHandlers(() => client)
});
await new Promise((resolve2) => {
  stopServer.once("error", (e) => {
    log("start", `cannot listen on ${STOP_PIPE} (${e.code}); is another bot running? exiting`);
    process.exit(1);
  });
  stopServer.listen(STOP_PIPE, resolve2);
});
client = createBot();
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
    await client?.destroy();
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
