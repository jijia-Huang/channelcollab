/**
 * Moving a conversation between Discord and Claude Code on the computer
 * (0.1.8, PLAN §21). A channelcollab conversation is a Claude Code session,
 * so the computer continues it with `--resume <session ID>` in the session's
 * own folder; nothing else is involved.
 *
 * - takeover (Discord → computer): the bot closes its process for the
 *   conversation and marks it taken over; until it is released, triggers get
 *   a short answer and are kept, and the bot never opens that session (two
 *   processes on one session fork its transcript and one side's turns are lost:
 *   spike/v017-cli.mjs).
 * - release / takeback: the mark goes away, kept messages are handled in
 *   order, and the next turn resumes the session, now including what was said
 *   on the computer (the session ID does not change on resume).
 * - handoff (computer → Discord): the computer's session becomes the direct
 *   message conversation, or a new thread in a bound channel.
 */
import { statSync } from 'node:fs';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { ChannelType, ThreadAutoArchiveDuration, type AnyThreadChannel, type Client, type Message } from 'discord.js';
import { loadConfig, resolveDm, type Config } from '../config.js';
import { brief, log } from '../log.js';
import { enqueue, isPending } from '../router/queue.js';
import { hold, liveSession, release, unhold } from '../runner/pool.js';
import { botOwner } from '../roster.js';
import { allThreads, DM_KEY, getDm, getThread, registerThread, saveState, switchDm, type ThreadState } from '../store/state.js';
import { splitMessage } from './commands.js';
import { convFor, convState, effective, runTurn, type Conv, type TurnKind } from './conversation.js';
import { boundTargets, resolveTarget } from './post.js';
import type { Who } from './prompts.js';
import { StatusReactions } from './status.js';

/** Messages kept per conversation while it is taken over. */
const QUEUE_MAX = 20;

export const TAKEN_OVER_TEXT = '🖥️ 主人在電腦上接手中，結束後會接回。這則訊息已記下，交還後會接著處理。';

/** What Claude is told in front of the first message after the computer gives the conversation back. */
export const BACK_FROM_COMPUTER_NOTE =
  '（主人剛才在電腦上的 Claude Code 接手了這段對話，上面有一段是在電腦上進行的；現在回到 Discord。照常只用 reply 回覆這裡的人。）';

/** In front of the first message of a conversation handed over from the computer. */
export const HANDED_OVER_NOTE =
  '（這段對話是主人從電腦上的 Claude Code 交給 Discord 的：上面是在電腦上的對話，現在主人改在 Discord 上繼續。從這裡開始，你的一般文字輸出沒有人看得到，要讓人看到一律用 reply。）';

/**
 * runTurn met a taken-over conversation: keep a normal message for after the
 * release and tell the person; anything else (a skill, a retry…) waits for them to ask again.
 */
export async function noteTakenOver(c: Conv, trigger: Message, status: StatusReactions, kind: TurnKind): Promise<void> {
  const ts = convState(c);
  const tk = ts.takeover!;
  const keep = kind === 'normal' && !tk.queued.includes(trigger.id) && tk.queued.length < QUEUE_MAX;
  if (keep) {
    tk.queued.push(trigger.id);
    saveState();
  }
  log('takeover', `${c.key} ${kind} ${trigger.id} while taken over${keep ? ` (kept, ${tk.queued.length} waiting)` : ''}`);
  await status.set('waiting');
  await trigger.react('🖥️').catch(() => {});
  const text = keep ? TAKEN_OVER_TEXT : '🖥️ 主人在電腦上接手中，這個動作等交還後再做一次。';
  try {
    await trigger.reply({ content: text, allowedMentions: { parse: [] } });
  } catch {
    await c.room.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

export type TakeoverInfo = {
  key: string;
  kind: 'thread' | 'dm';
  name: string;
  sessionId: string;
  cwd: string;
  /** The binding's launcher ('' = the plain claude command). */
  launcher: string;
  url?: string;
};

export type ControlFailure = { ok: false; error: string };

const fail = (error: string): ControlFailure => ({ ok: false, error });

function label(c: Conv): string {
  return c.kind === 'dm' ? '私訊' : `討論串「${(c.room as AnyThreadChannel).name}」`;
}

/** Mark the conversation taken over and close the bot's process for it; resolves once the process is gone. */
export async function takeOver(client: Client<true>, key: string): Promise<({ ok: true } & TakeoverInfo) | ControlFailure> {
  const c = await convFor(client, key);
  if (!c) return fail(`找不到對話 ${key}（討論串要在綁定的頻道底下；私訊要開啟）`);
  const ts = convState(c);
  if (!ts.sessionId) return fail(`${label(c)}還沒有對話（session），沒有東西可以接手`);
  const ch = effective(c, ts);
  const info = (): TakeoverInfo => ({ key, kind: c.kind, name: label(c), sessionId: ts.sessionId!, cwd: ch.cwd, launcher: ch.launcher, ...(c.kind === 'thread' ? { url: (c.room as AnyThreadChannel).url } : {}) });
  if (ts.takeover) return { ok: true, ...info() };
  if (liveSession(key)?.busy || isPending(key)) return fail(`Claude 正在${label(c)}裡工作。請等這一輪結束，或在 Discord 上按 🛑／用 /stop 停下來再接手`);
  // The mark first: a trigger arriving while the process closes is kept instead of starting a turn.
  ts.takeover = { at: new Date().toISOString(), sessionId: ts.sessionId, cwd: ch.cwd, queued: [] };
  saveState();
  hold(key);
  await release(key, 'takeover');
  log('takeover', `${key} taken over on the computer session=${ts.sessionId} cwd=${ch.cwd}`);
  const owner = botOwner(loadConfig().discord.owner_id, client.user.id);
  const text =
    c.kind === 'dm'
      ? '🖥️ 你在電腦上接手了這段私訊對話。電腦上做完後用 /channelcollab:release 交還；在這裡傳的訊息會記下，交還後接著處理（忘了交還時，在這裡打 /takeback 強制接回）。'
      : `🖥️ ${owner ? `<@${owner}>` : '主人'} 在電腦上接手了這段對話，結束後會接回。期間在這裡的訊息會先記下。`;
  await c.room.send({ content: text, allowedMentions: { parse: [] } }).catch((e) => log('takeover', `${key} notice failed: ${(e as Error).message}`));
  return { ok: true, ...info() };
}

/**
 * The computer gives the conversation back (`release`), or the owner takes it
 * back from Discord (`/takeback`). `sessionId`: the session the computer ended
 * with, when it is known (a resume keeps the ID; this covers a fork).
 */
export async function giveBack(client: Client<true>, key: string, opts: { forced?: boolean; by?: string; sessionId?: string } = {}): Promise<{ ok: true; kept: number; sessionId: string; name: string } | ControlFailure> {
  const c = await convFor(client, key);
  if (!c) return fail(`找不到對話 ${key}`);
  const ts = convState(c);
  const tk = ts.takeover;
  if (!tk) return fail(`${label(c)}沒有在電腦上接手中`);
  if (opts.sessionId && opts.sessionId !== ts.sessionId) {
    log('takeover', `${key} session ${ts.sessionId} -> ${opts.sessionId} (from the computer)`);
    ts.sessionId = opts.sessionId;
  }
  ts.takeover = undefined;
  ts.pendingNote = ts.pendingNote ? `${ts.pendingNote}\n${BACK_FROM_COMPUTER_NOTE}` : BACK_FROM_COMPUTER_NOTE;
  saveState();
  unhold(key);
  log('takeover', `${key} ${opts.forced ? `taken back on Discord by ${opts.by ?? '?'}` : 'released by the computer'} session=${ts.sessionId} kept=${tk.queued.length}`);
  const text = opts.forced
    ? `✅ 已強制接回給 Bot${opts.by ? `（${opts.by}）` : ''}。⚠️ 電腦上的對話請先關閉，避免兩邊同時寫入同一段對話。`
    : '✅ 已交還給 Bot。';
  await c.room.send({ content: `${text}${tk.queued.length ? `接著處理期間記下的 ${tk.queued.length} 則訊息。` : ''}`, allowedMentions: { parse: [] } }).catch(() => {});
  await replay(c, tk.queued);
  return { ok: true, kept: tk.queued.length, sessionId: ts.sessionId!, name: label(c) };
}

/** Handle the messages kept while the conversation was on the computer, in order. */
async function replay(c: Conv, ids: string[]): Promise<void> {
  const ownerId = botOwner(loadConfig().discord.owner_id, c.selfId);
  for (const id of ids) {
    const m = await c.room.messages.fetch(id).catch(() => null);
    if (!m) continue;
    await m.reactions.cache.get('🖥️')?.users.remove(c.selfId).catch(() => {});
    const who: Who = c.kind === 'dm' ? { ownerId } : { ownerId, requesterId: m.author.bot ? undefined : m.author.id };
    const status = new StatusReactions(m);
    await status.set('received');
    const { queued } = enqueue(c.key, () => runTurn(c, m, status, who));
    if (queued) await status.set('waiting');
  }
}

export type SessionRow = {
  key: string;
  kind: 'thread' | 'dm';
  name: string;
  at: string;
  summary: string;
  sessionId: string;
  cwd: string;
  launcher: string;
  takenOver: boolean;
  busy: boolean;
};

/** This bot's recent conversations that have a session: the current direct message and the threads, newest first. */
export function sessionRows(config: Config, max = 15): SessionRow[] {
  const rows: SessionRow[] = [];
  const dmBase = (() => {
    try {
      return resolveDm(config);
    } catch {
      return undefined;
    }
  })();
  const add = (key: string, kind: 'thread' | 'dm', ts: ThreadState, cwd: string | undefined, launcher: string, name: string) => {
    if (!ts.sessionId || !cwd) return;
    rows.push({ key, kind, name, at: ts.lastAt ?? ts.createdAt, summary: (ts.last ?? ts.first ?? '').slice(0, 100), sessionId: ts.sessionId, cwd: ts.cwd ?? cwd, launcher, takenOver: !!ts.takeover, busy: !!liveSession(key)?.busy || isPending(key) });
  };
  if (dmBase) add(DM_KEY, 'dm', getDm(), dmBase.cwd, dmBase.launcher, '私訊');
  for (const [id, t] of allThreads()) {
    const b = config.channels[t.channelId];
    if (b) add(id, 'thread', t, b.cwd, b.launcher ?? '', t.name ?? `討論串 ${id}`);
  }
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, max);
}

export type HandoffRequest = {
  sessionId: string;
  /** The computer's folder (used when the session file does not say). */
  cwd?: string;
  /** 'dm' (default), or a bound channel (ID or name) for a new thread. */
  target?: string;
  title?: string;
  summary?: string;
};

/**
 * Take over a session from the computer (computer → Discord): it becomes the
 * direct message conversation, or a new thread in a bound channel. The next
 * message there resumes it, in the session's own folder.
 */
export async function handOff(client: Client<true>, req: HandoffRequest): Promise<{ ok: true; where: string; url?: string; cwd: string; cwdNote?: string; launcher: string } | ControlFailure> {
  if (!/^[0-9a-f-]{36}$/i.test(req.sessionId)) return fail(`session ID 格式不對：${req.sessionId}`);
  const info = await getSessionInfo(req.sessionId).catch(() => undefined);
  if (!info) return fail(`在這台電腦的 Claude Code 對話紀錄裡找不到 session ${req.sessionId}（Bot 和電腦上的 Claude Code 要用同一個設定資料夾）`);
  const cwd = sessionFolder(info.cwd, req.cwd);
  if (!cwd) return fail('不知道這段對話的工作資料夾，請加 --cwd');
  const config = loadConfig();
  const ownerId = botOwner(config.discord.owner_id, client.user.id);
  const summary = (req.summary ?? '').trim();
  const now = new Date().toISOString();
  const first = (summary || info.summary || '').replace(/\s+/g, ' ').slice(0, 120);
  const target = req.target && req.target !== 'dm' ? req.target : undefined;

  if (!target) {
    const dm = resolveDm(config);
    if (!dm || !ownerId) return fail('私訊沒有開啟（或沒有設定主人），不能交到私訊；可以改交到綁定的頻道（--channel）');
    const cur = getDm();
    if (cur.takeover) return fail('目前的私訊對話正在電腦上接手中，請先交還（release）');
    if (liveSession(DM_KEY)?.busy || isPending(DM_KEY)) return fail('Claude 正在私訊裡工作，請等它做完（或在私訊用 /stop）再交棒');
    await release(DM_KEY, 'handoff');
    switchDm({ channelId: DM_KEY, sessionId: req.sessionId, cwd, source: '從電腦交棒', lastCostTotal: 0, resumeCostBase: 0, createdAt: now, lastAt: now, first, last: first, pendingNote: HANDED_OVER_NOTE });
    const cwdNote = sameFolder(cwd, dm.cwd) ? undefined : `這段對話的工作資料夾是 \`${cwd}\`，和私訊平常的 \`${dm.cwd}\` 不同；這次照這段對話的資料夾跑，/clear 之後回到平常的。`;
    const room = await (await client.users.fetch(ownerId)).createDM();
    const text = handoffText(summary, cwd, cwdNote, '/clear 開新的對話；原本的私訊對話可以用 /resume 接回。');
    for (const chunk of splitMessage(text)) await room.send({ content: chunk, allowedMentions: { parse: [] } });
    log('handoff', `session ${req.sessionId} -> dm cwd=${cwd}`);
    return { ok: true, where: '私訊', cwd, ...(cwdNote ? { cwdNote } : {}), launcher: dm.launcher };
  }

  const t = resolveTarget(boundTargets(client, config), target);
  if (!t.ok) return t;
  const ch = await client.channels.fetch(t.id).catch(() => null);
  if (!ch || !('threads' in ch) || !('guildId' in ch)) return fail(`Bot 看不到頻道 ${t.id}，或那個頻道不能開討論串`);
  const name = (req.title?.trim() || info.customTitle || info.summary || '從電腦交棒').replace(/\s+/g, ' ').slice(0, 100);
  const channelCwd = config.channels[t.id].cwd;
  const cwdNote = sameFolder(cwd, channelCwd) ? undefined : `這段對話的工作資料夾是 \`${cwd}\`，和這個頻道平常的 \`${channelCwd}\` 不同；這個討論串照這段對話的資料夾跑。`;
  const text = handoffText(summary, cwd, cwdNote, '');
  const chunks = splitMessage(`💻 ${ownerId ? `<@${ownerId}>` : '主人'} 從電腦交棒過來\n${text}`);
  let thread: AnyThreadChannel;
  let last: Message | undefined;
  if (ch.type === ChannelType.GuildForum) {
    thread = await ch.threads.create({ name, message: { content: chunks.shift()!, allowedMentions: { parse: [] } } });
  } else if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
    thread = await ch.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
  } else return fail(`頻道 ${t.id} 不能開討論串`);
  for (const chunk of chunks) last = await thread.send({ content: chunk, allowedMentions: { parse: [] } });
  const ts = getThread(thread.id) ?? registerThread(thread.id, t.id, thread.name);
  Object.assign(ts, { sessionId: req.sessionId, cwd, source: '從電腦交棒', lastAt: now, first, last: first, pendingNote: HANDED_OVER_NOTE, ...(last ? { lastSeenMessageId: last.id } : {}) });
  saveState();
  log('handoff', `session ${req.sessionId} -> thread ${thread.id} "${brief(name, 60)}" cwd=${cwd}`);
  return { ok: true, where: `討論串「${name}」`, url: thread.url, cwd, ...(cwdNote ? { cwdNote } : {}), launcher: config.channels[t.id].launcher ?? '' };
}

/**
 * The session's folder: the one its record names, else the one the computer sent. Only an existing
 * folder counts (a resume must run there; a record read wrongly, e.g. a path without its backslashes, is not used).
 */
export function sessionFolder(recorded: string | undefined, hint: string | undefined): string | undefined {
  const isDir = (p?: string) => {
    try {
      return !!p && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (isDir(recorded)) return recorded;
  if (isDir(hint)) return hint;
  return recorded ?? hint;
}

const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

function handoffText(summary: string, cwd: string, cwdNote: string | undefined, more: string): string {
  return [
    '💻 **從電腦交棒過來的對話**',
    summary || '（沒有附摘要）',
    '',
    `工作資料夾：\`${cwd}\``,
    ...(cwdNote ? [cwdNote] : []),
    `之後在這裡傳訊息，就會接著電腦上的同一段對話。${more}`,
    '⚠️ 電腦上的那個對話請關掉（或不要再在那裡繼續），避免兩邊同時寫入。',
  ].join('\n');
}
