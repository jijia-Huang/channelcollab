/**
 * `!` commands and other small rules for direct messages and threads (pure:
 * no Discord client, so they can be tested on their own; src/features.test.ts).
 */

export type CommandName = 'help' | 'clear' | 'resume' | 'stop' | 'status' | 'model' | 'plan' | 'compact' | 'retry';
export type Command = { name: CommandName; arg?: string };

type Spec = { dmOnly: boolean; takesArg: boolean; desc: string };
export const COMMANDS: Record<CommandName, Spec> = {
  help: { dmOnly: false, takesArg: false, desc: '列出指令' },
  clear: { dmOnly: true, takesArg: false, desc: '結束目前的對話，下一則訊息開新的' },
  resume: { dmOnly: true, takesArg: false, desc: '從清單選一段以前的對話接回來' },
  stop: { dmOnly: false, takesArg: false, desc: '中斷 Claude 正在做的這一輪（同 🛑）' },
  status: { dmOnly: false, takesArg: false, desc: '工作目錄、模型、模式、花費、上下文和額度' },
  model: { dmOnly: false, takesArg: true, desc: '換模型（haiku／sonnet／opus），例如 !model sonnet' },
  plan: { dmOnly: false, takesArg: false, desc: '切到計畫模式（只討論不動手），再打一次切回' },
  compact: { dmOnly: false, takesArg: false, desc: '壓縮上下文，讓對話可以繼續' },
  retry: { dmOnly: false, takesArg: false, desc: '把上一則訊息原樣重送一次' },
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
  const m = /^!([a-z]+)(?:\s+(\S+))?$/i.exec(stripMentions(text));
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
    .map(([n, s]) => `\`!${n}\`　${s.desc}`);
  const who = kind === 'dm' ? '' : '\n討論串裡只有 Bot 的主人或提出需求的人能用；`!clear`、`!resume` 只能在私訊用。';
  return `**指令**（訊息只打指令才算，大小寫都可以）\n${lines.join('\n')}${who}`;
}

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
