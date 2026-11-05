/**
 * Posting a report to a team channel (0.1.8, PLAN §21): Claude's
 * post_to_channel tool and the control script's `post` (from Claude Code on
 * the computer, over the named pipe) both come here.
 *
 * Only channels this bot is bound to (or threads under them) can be posted to;
 * the message says whose work it reports. A new thread is opened by the bot,
 * so it handles that thread like one it opened itself; when the report came
 * from a session, the thread's first trigger forks that session so the thread
 * continues from what was reported (conversation.ts).
 */
import path from 'node:path';
import { ChannelType, ThreadAutoArchiveDuration, type AnyThreadChannel, type Client, type Message } from 'discord.js';
import { loadConfig, type Config } from '../config.js';
import { brief, log } from '../log.js';
import { botOwner } from '../roster.js';
import { getThread, registerThread, saveState } from '../store/state.js';
import { splitMessage } from './commands.js';

export type Target = { id: string; name: string };

/** Where a report comes from, for the line that says whose work it is. */
export type ReportSource = { kind: 'dm' } | { kind: 'thread'; threadId: string } | { kind: 'cli' };

export type PostRequest = {
  /** A bound channel: its ID, its name, `#name` or `<#ID>`. */
  channel: string;
  text: string;
  /** Local files, already checked by the caller. */
  files?: string[];
  /** An existing thread under that channel. */
  thread?: string;
  /** Open a new thread with this title. */
  newThread?: string;
  source: ReportSource;
  /** The session that wrote the report: a new thread continues from a fork of it. */
  forkFrom?: { sessionId: string; cwd: string };
};

export type PostResult =
  | { ok: true; url: string; where: string; channelId: string; threadId?: string; messageId: string }
  | { ok: false; error: string };

/** The bound channels with their Discord names (from the cache; the ID when the name is not known). */
export function boundTargets(client: Client, config: Config): Target[] {
  return Object.keys(config.channels).map((id) => {
    const ch = client.channels.cache.get(id);
    return { id, name: ch && 'name' in ch && ch.name ? ch.name : '' };
  });
}

/** One line for the prompt and the tool description: 「#name（ID 1）、#other（ID 2）」. */
export function targetsLine(targets: Target[]): string {
  return targets.map((t) => (t.name ? `#${t.name}（ID ${t.id}）` : `頻道 ID ${t.id}`)).join('、');
}

/** Which bound channel a request means. Names match without # and case; an ambiguous name is refused. */
export function resolveTarget(targets: Target[], query: string): { ok: true; id: string } | { ok: false; error: string } {
  const list = targets.length ? targetsLine(targets) : '（沒有綁定任何頻道）';
  const q = query.trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').trim();
  if (!q) return { ok: false, error: `沒有指定頻道。可以貼的頻道：${list}` };
  const byId = targets.find((t) => t.id === q);
  if (byId) return { ok: true, id: byId.id };
  const byName = targets.filter((t) => t.name && t.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return { ok: true, id: byName[0].id };
  if (byName.length > 1) return { ok: false, error: `有好幾個頻道叫「${q}」，請改用頻道 ID：${targetsLine(byName)}` };
  return { ok: false, error: `「${q}」不是這隻 Bot 綁定的頻道，只能貼到：${list}` };
}

/** The first line of a report: whose work it is. The owner is named, not notified. */
export function sourceLabel(source: ReportSource, ownerId: string | undefined): string {
  const owner = ownerId ? `<@${ownerId}>` : '主人';
  if (source.kind === 'dm') return `📣 由 ${owner} 的私訊工作回報`;
  if (source.kind === 'thread') return `📣 由討論串 <#${source.threadId}> 的工作回報（${owner} 的 Bot）`;
  return `📣 由 ${owner} 在電腦上的工作回報`;
}

/** People the report text @-mentions (they are notified); the owner, already named in the label, is not. */
export function mentionedUsers(text: string, ownerId: string | undefined): string[] {
  const ids = [...text.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => id !== ownerId);
}

/** Post the report. Never throws: failures come back as `ok: false` with a reason Claude or the script can show. */
export async function postReport(client: Client<true>, req: PostRequest): Promise<PostResult> {
  try {
    return await post(client, req);
  } catch (e) {
    log('post', `failed: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  }
}

async function post(client: Client<true>, req: PostRequest): Promise<PostResult> {
  const config = loadConfig();
  const text = req.text.trim();
  const files = req.files ?? [];
  if (!text && !files.length) return { ok: false, error: '內容是空的' };
  const target = resolveTarget(boundTargets(client, config), req.channel);
  if (!target.ok) return target;
  const ch = await client.channels.fetch(target.id).catch(() => null);
  if (!ch || !('guildId' in ch)) return { ok: false, error: `Bot 看不到頻道 ${target.id}（可能沒有權限或頻道已刪除）` };
  if (config.discord.guild_id && ch.guildId !== config.discord.guild_id) return { ok: false, error: `頻道 ${target.id} 不在設定的伺服器裡` };
  const channelName = 'name' in ch && ch.name ? `#${ch.name}` : `頻道 ${target.id}`;
  const ownerId = botOwner(config.discord.owner_id, client.user.id);
  const chunks = splitMessage(`${sourceLabel(req.source, ownerId)}\n${text}`);
  const users = mentionedUsers(text, ownerId);
  const attach = files.map((f) => ({ attachment: f, name: path.basename(f) }));
  const isForum = ch.type === ChannelType.GuildForum;

  let room: AnyThreadChannel | undefined;
  let where = channelName;
  let first: Message | undefined;
  if (req.thread) {
    const th = await client.channels.fetch(req.thread).catch(() => null);
    if (!th?.isThread() || th.parentId !== target.id) return { ok: false, error: `討論串 ${req.thread} 不在 ${channelName} 底下` };
    room = th;
    where = `${channelName} 的討論串「${th.name}」`;
  } else if (req.newThread) {
    const name = req.newThread.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Claude 回報';
    if (isForum) {
      // A forum post needs its first message at creation.
      const head = chunks.shift()!;
      room = await ch.threads.create({ name, message: { content: head, ...(chunks.length ? {} : { files: attach }), allowedMentions: { users } } });
      first = (await room.fetchStarterMessage().catch(() => null)) ?? undefined;
    } else if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      room = await ch.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
    } else return { ok: false, error: `${channelName} 不能開討論串` };
    where = `${channelName} 的新討論串「${name}」`;
  } else if (isForum) {
    return { ok: false, error: `${channelName} 是論壇頻道，要開新討論串（new_thread）或指定既有的討論串` };
  } else if (!ch.isTextBased() || !('send' in ch)) {
    return { ok: false, error: `${channelName} 不能發文` };
  }

  const dest = room ?? (ch as unknown as { send: AnyThreadChannel['send'] });
  let last = first;
  for (const [i, chunk] of chunks.entries()) {
    const m = await dest.send({ content: chunk, ...(i === chunks.length - 1 && attach.length ? { files: attach } : {}), allowedMentions: { users } });
    first ??= m;
    last = m;
  }
  if (!first) return { ok: false, error: '沒有送出任何訊息' };

  if (req.newThread && room) {
    // The bot opened it, so it is handled like a thread the bot opened from a mention (PLAN §6).
    const ts = getThread(room.id) ?? registerThread(room.id, target.id, room.name);
    if (req.forkFrom) ts.forkFrom = req.forkFrom;
    ts.source = req.source.kind === 'cli' ? '電腦上的工作回報' : req.source.kind === 'dm' ? '私訊的工作回報' : '討論串的工作回報';
    // The report itself is already known to the session it forks from; later history starts after it.
    if (last) ts.lastSeenMessageId = last.id;
    saveState();
  }
  log('post', `posted to ${where} (${room?.id ?? target.id}) message=${first.id}${req.forkFrom ? ` fork-from=${req.forkFrom.sessionId}` : ''} ${brief(text, 120)}`);
  return { ok: true, url: first.url, where, channelId: target.id, ...(room ? { threadId: room.id } : {}), messageId: first.id };
}
