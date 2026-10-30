/**
 * Builds the prompt for one turn (PLAN §6): speaker, location, recent thread
 * messages, and the triggering message.
 */
import type { Message, ThreadChannel } from 'discord.js';
import { loadRoster, roleName, type RosterBot } from '../roster.js';
import type { SavedAttachments } from './attachments.js';

function speaker(m: Message, roster: RosterBot[]): string {
  const name = m.member?.displayName ?? m.author.displayName;
  const r = m.author.bot ? roster.find((b) => b.botId === m.author.id) : undefined;
  const tags = [m.author.username, m.author.bot ? 'Bot' : '', r ? `${r.ownerName} 的${roleName(r.role)}，ID ${r.botId}` : ''];
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
  const roster = loadRoster();
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
