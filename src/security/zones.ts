/**
 * Hard no-go zones (PLAN §8): paths no tool call may touch in any permission
 * mode, and no button can open. Checked first in the PreToolUse hook, before
 * Claude Code's own permission logic (and its auto mode classifier).
 *
 * - channelcollab's HOME folders (this bot's HOME and any `.channelcollab*`
 *   folder): config.json with the Discord token, hand-off files, the PIN hash.
 *   The session's own attachment folder inside HOME is the one exception.
 * - `.ssh` folders, `.env` / `.env.*` files, Claude's login (`.credentials.json`).
 * - In commands: running channelcollab's own scripts (channelcollab.mjs,
 *   create-bot.mjs, ctl.mjs), which change bindings, the PIN or the allowlist.
 *
 * File tools are matched on their resolved path, case and slashes normalized.
 * Shell commands (Bash, PowerShell) and other tools' text are only scanned for
 * these names: a best effort, since a command can build a path in ways no
 * scan can follow.
 */
import path from 'node:path';

export type Zones = {
  /** channelcollab HOME folders that are off limits (besides any `.channelcollab*`). */
  homes: string[];
  /** Folders inside a no-go zone that stay usable (the session's attachment folder). */
  allow: string[];
};

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Grep', 'Glob', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
/** Inputs that are patterns, not paths: scanned as text. */
const PATTERN_KEYS = ['pattern', 'glob'];

/** Lower case, forward slashes, no trailing slash, no \\?\ prefix. */
export function normPath(p: string): string {
  return p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function under(abs: string, root: string): boolean {
  const r = normPath(root);
  return abs === r || abs.startsWith(`${r}/`);
}

const WHY = {
  home: 'channelcollab 的資料夾（Bot 設定、token、PIN）',
  ssh: 'SSH 金鑰資料夾（.ssh）',
  env: '.env 環境變數檔（常放密碼與金鑰）',
  cred: 'Claude 的登入資料（.credentials.json）',
  ctl: 'channelcollab 的總控腳本（改設定、PIN、白名單、token 都要主人在電腦上自己做）',
};

/** Why `p` (relative to `base`) is off limits, or undefined. */
export function forbiddenPath(p: string, base: string, z: Zones): string | undefined {
  const abs = normPath(path.resolve(base, p));
  if (z.allow.some((a) => under(abs, a))) return undefined;
  const parts = abs.split('/');
  if (z.homes.some((h) => under(abs, h)) || parts.some((s) => s.startsWith('.channelcollab'))) return WHY.home;
  if (parts.includes('.ssh')) return WHY.ssh;
  const name = parts.at(-1) ?? '';
  if (/^\.env(\..+)?$/.test(name)) return WHY.env;
  if (name === '.credentials.json') return WHY.cred;
  return undefined;
}

/** Best-effort scan of free text (a shell command, a glob pattern) for the same places. */
export function forbiddenText(text: string, z: Zones): string | undefined {
  let t = normPath(text);
  // The allowed folder is cut out before scanning, so climbing out of it must not hide the rest.
  if (z.allow.some((a) => t.includes(`${normPath(a)}/..`))) return WHY.home;
  for (const a of z.allow) t = t.split(normPath(a)).join(' ');
  if (z.homes.some((h) => t.includes(normPath(h))) || t.includes('.channelcollab')) return WHY.home;
  if (/(^|[^\w.-])\.ssh([^\w-]|$)/.test(t)) return WHY.ssh;
  if (/(^|[\s"'`/=:(,;|&<>*])\.env(\.[\w.*-]+)?(?=$|[\s"'`;|&)<>,}*])/.test(t)) return WHY.env;
  if (t.includes('.credentials.json')) return WHY.cred;
  if (/(^|[^\w-])(channelcollab|create-bot|ctl)\.mjs([^\w-]|$)/.test(t)) return WHY.ctl;
  return undefined;
}

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

/**
 * Why this tool call touches a no-go zone, or undefined. `ownPrefix` tools
 * (reply) are checked on the files they attach only.
 */
export function forbiddenUse(name: string, input: Record<string, unknown>, cwd: string, z: Zones, ownPrefix: string): string | undefined {
  if (name.startsWith(ownPrefix)) {
    const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string') : [];
    for (const f of files) {
      const why = forbiddenPath(f, cwd, z);
      if (why) return why;
    }
    return undefined;
  }
  if (SHELL_TOOLS.has(name)) return typeof input.command === 'string' ? forbiddenText(input.command, z) : undefined;
  if (FILE_TOOLS.has(name)) {
    for (const k of PATH_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v) {
        const why = forbiddenPath(v, cwd, z);
        if (why) return why;
      }
    }
    for (const k of PATTERN_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v) {
        const why = forbiddenText(v, z);
        if (why) return why;
      }
    }
    return undefined;
  }
  // Other MCP tools: scan every string they were given.
  if (name.startsWith('mcp__')) {
    for (const s of strings(input)) {
      const why = forbiddenText(s, z);
      if (why) return why;
    }
  }
  return undefined;
}

export function zoneDenyMessage(why: string): string {
  return `🚫 這個動作碰到 channelcollab 的禁區：${why}。任何權限模式都不能讀寫這裡，主人的按鈕也解不開。不要再試，也不要換別的方法繞過；真的需要的話，請主人自己在電腦上處理。`;
}
