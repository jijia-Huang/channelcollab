/**
 * `!` and `/` commands and other small rules for direct messages and threads
 * (pure: no Discord client, so they can be tested on their own;
 * src/features.test.ts). A slash command becomes the same Command a `!`
 * message does, passes the same gate and runs through the same runCommand.
 */
import { canAct } from '../runner/policy.js';

export type CommandName = 'help' | 'clear' | 'resume' | 'stop' | 'status' | 'model' | 'plan' | 'compact' | 'retry' | 'skill';
/** `rest`: what follows the skill name in `!skill <name> <args>`. */
export type Command = { name: CommandName; arg?: string; rest?: string };

/**
 * dmOnly: only in a direct message with the bot. private: the answer is only
 * for the person who used it (a slash command answers ephemerally); the others
 * change the conversation and leave a short public note.
 */
type Spec = { dmOnly: boolean; takesArg: boolean; private: boolean; desc: string; example?: string };
export const COMMANDS: Record<CommandName, Spec> = {
  help: { dmOnly: false, takesArg: false, private: true, desc: '列出指令' },
  clear: { dmOnly: true, takesArg: false, private: false, desc: '結束目前的對話，下一則訊息開新的' },
  resume: { dmOnly: true, takesArg: false, private: true, desc: '從清單選一段以前的對話接回來' },
  stop: { dmOnly: false, takesArg: false, private: false, desc: '中斷 Claude 正在做的這一輪（同 🛑）' },
  status: { dmOnly: false, takesArg: false, private: true, desc: '工作目錄、模型、模式、花費、上下文和額度' },
  model: { dmOnly: false, takesArg: true, private: false, desc: '換模型（haiku／sonnet／opus）', example: 'sonnet' },
  plan: { dmOnly: false, takesArg: false, private: false, desc: '切到計畫模式（只討論不動手），再用一次切回' },
  compact: { dmOnly: false, takesArg: false, private: false, desc: '壓縮上下文，讓對話可以繼續' },
  retry: { dmOnly: false, takesArg: false, private: false, desc: '把上一則訊息原樣重送一次' },
  skill: { dmOnly: false, takesArg: true, private: false, desc: '執行 Claude Code 的 skill 或自訂指令', example: '<名稱> [參數]' },
};

export const MODEL_CHOICES = [
  { alias: 'haiku', label: 'Haiku', note: '最快、最便宜' },
  { alias: 'sonnet', label: 'Sonnet', note: '均衡（建議）' },
  { alias: 'opus', label: 'Opus', note: '最強、最貴' },
] as const;

/** Mentions (<@id>, <@!id>, <@&role>) are not part of the command. */
export function stripMentions(text: string): string {
  return text.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A message is a command only when it is nothing but the command (case does
 * not matter); `!model` alone may take one argument. Anything else is an
 * ordinary message.
 */
export function parseCommand(text: string): Command | undefined {
  const clean = stripMentions(text);
  // `!skill` alone lists the skills; `!skill <name> <args...>` runs one.
  const sk = /^!skill(?:\s+(\S+)(?:\s+(.+))?)?$/i.exec(clean);
  if (sk) return { name: 'skill', ...(sk[1] !== undefined ? { arg: sk[1] } : {}), ...(sk[2] !== undefined ? { rest: sk[2] } : {}) };
  const m = /^!([a-z]+)(?:\s+(\S+))?$/i.exec(clean);
  if (!m) return undefined;
  const name = m[1].toLowerCase() as CommandName;
  const spec = COMMANDS[name];
  if (!spec) return undefined;
  if (m[2] !== undefined && !spec.takesArg) return undefined;
  return m[2] !== undefined ? { name, arg: m[2] } : { name };
}

/** A model given to !model: one of the aliases, or a full model name. */
export function normalizeModel(arg: string): string | undefined {
  const a = arg.trim().toLowerCase();
  if (MODEL_CHOICES.some((c) => c.alias === a)) return a;
  return /^claude-[a-z0-9.[\]-]+$/.test(a) ? a : undefined;
}

export function helpText(kind: 'thread' | 'dm'): string {
  const lines = (Object.entries(COMMANDS) as [CommandName, Spec][])
    .filter(([, s]) => kind === 'dm' || !s.dmOnly)
    .map(([n, s]) => `\`/${n}\`${s.example ? ` ${s.example}` : ''}　${s.desc}`);
  const who = kind === 'dm' ? '' : '\n討論串裡只有 Bot 的主人或提出需求的人能用；`/clear`、`/resume` 只能在私訊用。';
  return [
    '**指令**：打 `/` 會跳出選單，同一個伺服器有好幾隻 Bot 時，請選這隻 Bot 底下的指令。',
    '也可以打 `!` 開頭的備用寫法（例如 `!model sonnet`、`!skill <名稱> [參數]`，訊息只打指令才算）。',
    ...lines,
    '`/skill` 的名稱會從清單選；清單是這個工作資料夾上次開對話時 Claude Code 提供的 skill 和自訂指令（還沒開過對話時，先傳一則訊息）。skill 用到的工具一樣要按權限按鈕。',
  ].join('\n') + who;
}

// ---------------------------------------------------------------------------
// Slash commands (Discord application commands)
// ---------------------------------------------------------------------------

/** Discord API values (no discord.js here, to keep this file pure). */
const CHAT_INPUT = 1;
const STRING = 3;
const CONTEXT_GUILD = 0;
const CONTEXT_BOT_DM = 1;
const GUILD_INSTALL = 0;

type SlashOption = { type: number; name: string; description: string; required?: boolean; autocomplete?: boolean; max_length?: number; choices?: { name: string; value: string }[] };
export type SlashDefinition = { type: number; name: string; description: string; contexts: number[]; integration_types: number[]; options?: SlashOption[] };

/**
 * The global commands this bot registers (bulk overwrite on start, so a
 * restart never duplicates them). Direct-message-only commands are offered
 * only in the direct message; the rest in servers (threads included) too.
 */
export function slashDefinitions(): SlashDefinition[] {
  return (Object.entries(COMMANDS) as [CommandName, Spec][]).map(([name, s]) => {
    const def: SlashDefinition = {
      type: CHAT_INPUT,
      name,
      description: s.desc.slice(0, 100),
      contexts: s.dmOnly ? [CONTEXT_BOT_DM] : [CONTEXT_GUILD, CONTEXT_BOT_DM],
      integration_types: [GUILD_INSTALL],
    };
    if (name === 'model') {
      def.options = [{ type: STRING, name: 'name', description: '要換成的模型（不選就顯示按鈕）', required: false, choices: MODEL_CHOICES.map((m) => ({ name: `${m.label}（${m.note}）`, value: m.alias })) }];
    }
    if (name === 'skill') {
      def.options = [
        { type: STRING, name: 'name', description: 'skill 或自訂指令的名稱（從清單選）', required: true, autocomplete: true, max_length: 100 },
        { type: STRING, name: 'args', description: '要交給它的參數（選填）', required: false, max_length: 1500 },
      ];
    }
    return def;
  });
}

/** A slash command's name and options as the same Command a `!` message gives. */
export function commandFromSlash(name: string, options: Record<string, string | undefined> = {}): Command | undefined {
  if (!(name in COMMANDS)) return undefined;
  const n = name as CommandName;
  if (n === 'model') return options.name ? { name: n, arg: options.name } : { name: n };
  if (n === 'skill') return { name: n, ...(options.name ? { arg: options.name } : {}), ...(options.args?.trim() ? { rest: options.args.trim() } : {}) };
  return { name: n };
}

// ---------------------------------------------------------------------------
// Who may use a command where (the same rules for `!` and `/`)
// ---------------------------------------------------------------------------

export type GateRefusal =
  | 'locked'
  | 'unbound'
  | 'not-allowed'
  | 'not-thread'
  | 'dm-only'
  | 'not-actor'
  | 'dm-not-owner'
  | 'dm-disabled'
  | 'dm-no-pin'
  | 'dm-pin-needed';

export type GateFacts = {
  cmd: CommandName;
  where: 'dm' | 'thread' | 'channel';
  actorId: string;
  ownerId?: string;
  /** Locked after too many wrong PINs. */
  locked: boolean;
  /** Server: the channel (or the thread's parent) is bound, in the configured server. */
  bound?: boolean;
  /** Server: the allowlist is on and the actor is not on it. */
  notAllowed?: boolean;
  /** Thread: whoever asked for the running turn, else the thread's starter. */
  requesterId?: string;
  /** Direct message: the dm block is set, a PIN is set, the PIN was entered recently. */
  dmEnabled?: boolean;
  pinSet?: boolean;
  pinUnlocked?: boolean;
};

/** Why a command may not run here, or undefined when it may. */
export function commandGate(f: GateFacts): GateRefusal | undefined {
  if (f.locked) return 'locked';
  if (f.where === 'dm') {
    const a = dmAccess({ authorId: f.actorId, ownerId: f.ownerId, dmEnabled: !!f.dmEnabled });
    if (a === 'not-owner') return 'dm-not-owner';
    if (a === 'disabled') return 'dm-disabled';
    if (!f.pinSet) return 'dm-no-pin';
    if (!f.pinUnlocked) return 'dm-pin-needed';
    return undefined;
  }
  if (!f.bound) return 'unbound';
  if (f.notAllowed) return 'not-allowed';
  if (f.where !== 'thread') return 'not-thread';
  if (COMMANDS[f.cmd].dmOnly) return 'dm-only';
  // Like 🛑: the owner, or whoever asked for the running turn (else the thread's starter).
  if (!canAct('stop', f.actorId, { ownerId: f.ownerId, requesterId: f.requesterId })) return 'not-actor';
  return undefined;
}

/** What to tell the person (a `!` message is answered only for some refusals; see bot.ts). */
export function gateText(r: GateRefusal, f: { cmd: CommandName; ownerId?: string; requesterId?: string; slash?: boolean }): string {
  const c = `${f.slash ? '/' : '!'}${f.cmd}`;
  switch (r) {
    case 'locked':
      return '🔒 已鎖定（PIN 輸錯太多次）。請在電腦上執行 unlock 或重啟 Bot 解除。';
    case 'unbound':
      return '這個頻道沒有綁定這隻 Bot，指令只能在綁定頻道的討論串裡（或私訊 Bot）使用。';
    case 'not-allowed':
      return '你不在這隻 Bot 的白名單裡，請 Bot 的主人把你加進名冊。';
    case 'not-thread':
      return '指令請在討論串裡（或私訊 Bot）使用。';
    case 'dm-only':
      return `\`${c}\` 只能在私訊 Bot 時使用。`;
    case 'not-actor': {
      const names = [f.requesterId, f.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
      return `只有 ${names.join(' 或 ') || 'Bot 的主人'} 可以在這個討論串用指令。`;
    }
    case 'dm-not-owner':
      return '這隻 Bot 只接受主人私訊。';
    case 'dm-disabled':
      return '私訊未開啟：請在電腦上用 /channelcollab:bind 開啟私訊（要先設定 PIN）。';
    case 'dm-no-pin':
      return NO_PIN_TEXT;
    case 'dm-pin-needed':
      return '🔒 私訊要先輸入 PIN 解鎖，解鎖後再用一次指令。';
  }
}

/** Direct messages without a PIN set (the shortcut file names differ per bot, so none is named here). */
export const NO_PIN_TEXT = '私訊要先設定 PIN 才能用：請在電腦上執行 channelcollab 的 set-pin（或在 Claude Code 用 /channelcollab:bind 設定 PIN）。';

/** Who may use a direct message: only the bot's owner, and only when the dm block is set. */
export function dmAccess(f: { authorId: string; ownerId?: string; dmEnabled: boolean }): 'run' | 'not-owner' | 'disabled' {
  if (!f.ownerId || f.authorId !== f.ownerId) return 'not-owner';
  return f.dmEnabled ? 'run' : 'disabled';
}

/** Answer someone at most once per `windowMs` (refusals in direct messages). */
export function throttle(seen: Map<string, number>, key: string, now = Date.now(), windowMs = 10 * 60 * 1000): boolean {
  const last = seen.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  seen.set(key, now);
  return true;
}

export type RoleMention = { id: string; botId?: string | null };

/**
 * Mentioned explicitly: as a user, or through the role Discord created for this
 * bot (its managed bot role, which the mention picker often offers instead).
 * Other roles and @everyone do not count.
 */
export function mentionsSelf(f: { userIds: Iterable<string>; roles: Iterable<RoleMention> }, selfId: string, ownRoleId?: string | null): boolean {
  if ([...f.userIds].includes(selfId)) return true;
  return [...f.roles].some((r) => r.botId === selfId || (!!ownRoleId && r.id === ownRoleId));
}

/** Another bot's managed role is mentioned (counts like mentioning that bot). */
export function mentionsOtherBotRole(roles: Iterable<RoleMention>, selfId: string): boolean {
  return [...roles].some((r) => !!r.botId && r.botId !== selfId);
}

export const DISCORD_LIMIT = 2000;

/** Split on line breaks where possible so each piece fits one Discord message. */
export function splitMessage(text: string, limit = DISCORD_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/** Split a reply and put `footer` on its own line at the end of the last piece only. */
export function splitReply(text: string, footer = ''): string[] {
  const chunks = splitMessage(text);
  if (!footer) return chunks;
  const tail = `\n${footer}`;
  const last = chunks.pop();
  if (last === undefined) return [footer];
  if (last.length + tail.length <= DISCORD_LIMIT) return [...chunks, last + tail];
  const again = splitMessage(last, DISCORD_LIMIT - tail.length);
  again[again.length - 1] += tail;
  return [...chunks, ...again];
}

/** 「3 小時 12 分」 */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return '不到 1 分鐘';
  const h = Math.floor(min / 60);
  return h ? `${h} 小時${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分鐘`;
}

/** 「11/4 14:05」 in this computer's time zone. */
export function shortTime(iso: string | number | undefined): string {
  if (iso === undefined) return '時間不明';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '時間不明';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type ResumeCandidate = {
  kind: 'dm' | 'thread';
  /** DM: the saved session; thread: the thread ID. */
  id: string;
  sessionId: string;
  cwd: string;
  /** ISO time of the last turn. */
  at: string;
  /** 私訊, or the thread's name. */
  source: string;
  summary: string;
};

/** Newest first, at most `max`; one entry per session. */
export function resumeList(candidates: ResumeCandidate[], max = 10): ResumeCandidate[] {
  const seen = new Set<string>();
  return [...candidates]
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .filter((c) => (seen.has(c.sessionId) ? false : (seen.add(c.sessionId), true)))
    .slice(0, max);
}

/** Select menu option text for a candidate (Discord: label and description up to 100 characters). */
export function resumeOption(c: ResumeCandidate): { label: string; description: string } {
  const src = c.kind === 'dm' ? '私訊' : `討論串「${c.source}」`;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return { label: clip(`${shortTime(c.at)}　${src}`, 100), description: clip(c.summary.replace(/\s+/g, ' ').trim() || '（沒有摘要）', 100) };
}
