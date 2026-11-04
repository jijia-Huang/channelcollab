/**
 * Builds the prompt for one turn (PLAN §6): speaker, location, recent thread
 * messages, and the triggering message. Direct messages: speaker, location and
 * the message only.
 */
import type { Message, ThreadChannel } from 'discord.js';
import { loadRosterFile, roleName, rosterPeople, type Roster } from '../roster.js';
import type { SavedAttachments } from './attachments.js';
import { parseCommand } from './commands.js';

/**
 * 「顯示名稱（username，標籤…）」. Bots in the roster show owner, role and ID;
 * people always show their Discord ID (so the bot can write <@ID>), plus their
 * roster name and role when the roster knows them.
 */
export function speaker(m: Message, roster: Roster): string {
  const name = m.member?.displayName ?? m.author.displayName;
  const tags = [m.author.username];
  if (m.author.bot) {
    tags.push('Bot');
    const r = roster.bots.find((b) => b.botId === m.author.id);
    if (r) {
      const who = [r.ownerName ? `${r.ownerName} 的` : '', r.role ? roleName(r.role) : r.ownerName ? 'Bot' : ''].join('');
      tags.push([who, `ID ${r.botId}`].filter(Boolean).join('，'));
    }
  } else {
    tags.push(`ID ${m.author.id}`);
    const p = rosterPeople(roster).find((x) => x.discordId === m.author.id);
    if (p) tags.push(`名冊：${p.name}${p.role ? `，${roleName(p.role)}` : ''}`);
  }
  return `${name}（${tags.filter(Boolean).join('，')}）`;
}

/** Attachments saved locally show their path (Claude reads them with Read); others keep the Discord link. */
function body(m: Message, saved?: SavedAttachments): string {
  const files = [...m.attachments.values()].map((a) => {
    const s = saved?.get(a.id);
    if (s?.path) return `[附件] ${a.name}（${a.contentType ?? '未知類型'}，${a.size} bytes）本機路徑：${s.path}`;
    return `[附件] ${a.name} ${a.url}${s?.note ? `（${s.note}）` : ''}`;
  });
  return [m.cleanContent, ...files].filter(Boolean).join('\n') || '（空白訊息）';
}

/**
 * Recent thread messages before the trigger, oldest first. When the session
 * already exists only messages newer than `afterId` are included (the session
 * has seen the rest), and the bot's own messages are left out.
 */
async function recent(thread: ThreadChannel, trigger: Message, limit: number, afterId?: string): Promise<Message[]> {
  if (limit <= 0) return [];
  const fetched = await thread.messages.fetch({ limit, before: trigger.id });
  const me = trigger.client.user.id;
  return [...fetched.values()]
    .filter((m) => !m.system)
    // `!` commands are for the bot, not part of the conversation.
    .filter((m) => m.author.bot || !parseCommand(m.content))
    .filter((m) => !afterId || (BigInt(m.id) > BigInt(afterId) && m.author.id !== me))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

export async function buildPrompt(opts: {
  thread: ThreadChannel;
  trigger: Message;
  history: number;
  afterId?: string;
  attachments?: SavedAttachments;
}): Promise<string> {
  const { thread, trigger } = opts;
  const history = await recent(thread, trigger, opts.history, opts.afterId);
  const roster = loadRosterFile();
  const parent = thread.parent?.name ?? thread.parentId;
  const parts = [
    `【發話者】${speaker(trigger, roster)}`,
    `【位置】頻道 #${parent}，討論串「${thread.name}」（ID ${thread.id}）`,
  ];
  if (history.length) {
    parts.push(`【最近訊息】（舊到新，${history.length} 則）`);
    for (const m of history) parts.push(`- ${speaker(m, roster)}：${body(m).replace(/\n/g, '\n  ')}`);
  }
  parts.push('【本則訊息】', body(trigger, opts.attachments));
  return parts.join('\n');
}

/** A direct message from the owner: the session already holds the conversation, so no history. */
export function buildDmPrompt(trigger: Message, attachments?: SavedAttachments, roster: Roster = loadRosterFile()): string {
  return [`【發話者】${speaker(trigger, roster)}（你的主人）`, '【位置】Discord 私訊（你和主人一對一）', '【本則訊息】', body(trigger, attachments)].join('\n');
}
