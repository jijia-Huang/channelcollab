/**
 * Discord side: decides whether a message triggers a run, opens the thread,
 * queues the run, shows status reactions, posts replies, and routes the
 * buttons and menus of prompts that wait for a person.
 */
import path from 'node:path';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Message,
} from 'discord.js';
import { loadConfig, resolveChannel, type ResolvedChannel } from '../config.js';
import { brief, log } from '../log.js';
import { enqueue } from '../router/queue.js';
import { countHops, decide } from '../router/trigger.js';
import { acquire } from '../runner/pool.js';
import { botOwner, loadRoster, ROSTER_PATH } from '../roster.js';
import { getThread, registerThread, saveState } from '../store/state.js';
import { saveAttachments } from './attachments.js';
import { attachDetails, handleDetailsClick, isDetailsButton, rememberTurn } from './details.js';
import { buildPrompt } from './prompt.js';
import { askPermission, askQuestion, handlePromptInteraction, isPromptInteraction, stopControl, type Who } from './prompts.js';
import { StatusReactions } from './status.js';

const DISCORD_LIMIT = 2000;
const FALLBACK_MAX = 500;
/** A turn still running after this long gets a progress message with 🛑. */
const STOP_BUTTON_DELAY_MS = 5000;

/** Split on line breaks where possible so each piece fits one Discord message. */
function splitMessage(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function threadName(message: Message): string {
  const text = message.content.replace(/<@[!&]?\d+>/g, '').replace(/\s+/g, ' ').trim();
  return (text || 'Claude 任務').slice(0, 60);
}

/** The message @-mentions a bot other than `exceptId`. */
function mentionsBot(message: Message, exceptId: string): boolean {
  return message.mentions.users.some((u) => u.bot && u.id !== exceptId);
}

/**
 * Open a thread from a main-channel message. When several bots are mentioned
 * they race; the loser joins the thread the winner opened.
 */
async function openThread(message: Message<true>): Promise<AnyThreadChannel> {
  try {
    return await message.startThread({ name: threadName(message), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
  } catch (e) {
    const opened = message.channel.isTextBased() && 'threads' in message.channel ? await message.channel.threads.fetch(message.id).catch(() => null) : null;
    if (!opened) throw e;
    return opened;
  }
}

/** How many messages are read back at most when counting hops. */
const HOP_SCAN_PAGES = 5;

/**
 * Hops for a bot trigger, from the thread history (newest first, trigger
 * included) up to the last human message; see countHops. Also returns that
 * human, to address the over-limit notice to.
 */
async function threadHops(thread: AnyThreadChannel, trigger: Message, maxHops: number): Promise<{ hops: number; humanId?: string }> {
  const toHop = (m: Message) => ({ isSystem: m.system, fromBot: m.author.bot, mentionsBot: mentionsBot(m, m.author.id), authorId: m.author.id });
  const list = [toHop(trigger)];
  let before = trigger.id;
  for (let page = 0; ; page++) {
    const r = countHops(list);
    if (r.human || r.hops > maxHops || page === HOP_SCAN_PAGES) return { hops: r.hops, humanId: r.human?.authorId ?? (await starterHuman(thread)) };
    const batch = [...(await thread.messages.fetch({ limit: 100, before })).values()].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    if (!batch.length) return { hops: r.hops, humanId: await starterHuman(thread) };
    list.push(...batch.map(toHop));
    before = batch.at(-1)!.id;
  }
}

/** A thread opened from a message keeps that message in the parent channel; its author, if human. */
async function starterHuman(thread: AnyThreadChannel): Promise<string | undefined> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  return starter && !starter.author.bot ? starter.author.id : undefined;
}

export function createBot(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.MessageCreate, (message) => {
    onMessage(message).catch((e) => log('error', `message ${message.id}: ${(e as Error).stack ?? e}`));
  });

  client.once(Events.ClientReady, (c) => {
    let configured: string | undefined;
    try {
      configured = loadConfig().discord.owner_id;
    } catch {}
    const owner = botOwner(configured, c.user.id);
    log('owner', owner ? `${owner} (${configured ? 'discord.owner_id' : 'roster'})` : 'none: set discord.owner_id, or permission requests are denied');
    log('roster', `${loadRoster().length} bots from ${ROSTER_PATH}`);
  });

  client.on(Events.InteractionCreate, (i) => {
    if (i.isButton() && isDetailsButton(i.customId)) {
      log('details', `${i.customId} clicked by ${i.user.username}`);
      handleDetailsClick(i).catch((e) => log('error', `details ${i.customId}: ${(e as Error).message}`));
    } else if (isPromptInteraction(i)) {
      handlePromptInteraction(i).catch((e) => log('error', `prompt interaction: ${(e as Error).stack ?? e}`));
    }
  });

  return client;
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  const me = message.client.user.id;
  if (message.author.id === me) return;

  let config;
  let channel: ResolvedChannel | undefined;
  const ch = message.channel;
  const inThread = ch.isThread();
  const baseChannelId = inThread ? (ch.parentId ?? '') : ch.id;
  try {
    config = loadConfig();
    channel = resolveChannel(config, baseChannelId);
  } catch (e) {
    log('config', (e as Error).message);
    return;
  }
  if (config.discord.guild_id && message.guildId !== config.discord.guild_id) return;

  const fromBot = message.author.bot;
  const mentionsMe = message.mentions.users.has(me);
  // Who opened the thread comes from Discord, so every bot reads the same answer.
  let ownerId: string | null = null;
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
    openedByMe: ownerId === me,
  });
  const mentions = [...message.mentions.users.keys()].join(',');
  if (decision.action === 'ignore') {
    // Unbound channels stay silent in the log too; everything else says why it was skipped.
    if (decision.reason !== 'unbound-channel') log('ignore', `${message.id} ${decision.reason} channel=${ch.id} owner=${ownerId ?? '-'} author=${message.author.username} mentions=[${mentions}] text=${brief(message.content, 80)}`);
    return;
  }
  if (!channel) return;

  let thread: AnyThreadChannel;
  if (decision.action === 'open-thread') {
    if (ch.type !== ChannelType.GuildText) {
      log('ignore', `${message.id} unsupported-channel-type type=${ch.type}`);
      return;
    }
    const existing = message.thread;
    thread = existing ?? (await openThread(message));
    ownerId = thread.ownerId;
    log('thread', `${ownerId === me ? 'opened' : 'joined'} ${thread.id} "${thread.name}" from message ${message.id} owner=${ownerId ?? '-'}`);
  } else {
    thread = ch as AnyThreadChannel;
  }
  if (!getThread(thread.id)) {
    registerThread(thread.id, baseChannelId);
    if (ownerId !== me) log('thread', `adopted ${thread.id} "${thread.name}" owner=${ownerId ?? '-'}`);
  }

  // A human resets the count; a bot trigger is counted from the thread history.
  const hop = fromBot && decision.action === 'run' ? await threadHops(thread, message, channel.maxHops) : { hops: 0 };
  if (hop.hops > channel.maxHops) {
    log('ignore', `${message.id} max-hops hops=${hop.hops} max=${channel.maxHops} thread=${thread.id} author=${message.author.username}`);
    const human = hop.humanId ? `<@${hop.humanId}> ` : '';
    // No bot is mentioned here, so the notice itself is not another hop.
    await thread.send({
      content: `${human}Bot 之間已連續轉手 ${hop.hops - 1} 次，達到上限 ${channel.maxHops}，這則不再處理，請人類接手。`,
      allowedMentions: { users: hop.humanId ? [hop.humanId] : [] },
    });
    return;
  }

  log('trigger', `${message.id} thread=${thread.id} owner=${ownerId ?? '-'} author=${message.author.username}${fromBot ? '(bot)' : ''} mentions=[${mentions}] hops=${hop.hops} text=${brief(message.content, 120)}`);
  const status = new StatusReactions(message);
  await status.set('received');
  const who: Who = {
    ownerId: botOwner(config.discord.owner_id, me),
    // A bot cannot click, and naming it in a prompt could trigger it.
    requesterId: fromBot ? undefined : message.author.id,
  };
  const { queued } = enqueue(thread.id, () => runInThread(thread, message, channel, status, who));
  if (queued) {
    log('queue', `${message.id} waiting for thread ${thread.id}`);
    await status.set('waiting');
  }
}

async function runInThread(thread: AnyThreadChannel, trigger: Message, channel: ResolvedChannel, status: StatusReactions, who: Who): Promise<void> {
  let progress: ReturnType<typeof stopControl> | undefined;
  try {
    await status.set('running');
    const ts = getThread(thread.id)!;
    const attachments = await saveAttachments(trigger, thread.id);
    const prompt = await buildPrompt({
      thread,
      trigger,
      history: channel.history,
      afterId: ts.sessionId ? ts.lastSeenMessageId : undefined,
      attachments,
    });

    let lastReply: Message | undefined;
    // ⏳ on the trigger while any prompt waits for someone, back to ⚙️ after.
    let waits = 0;
    const waiting = async <T>(wait: () => Promise<T>): Promise<T> => {
      if (waits++ === 0) await status.set('waiting');
      try {
        return await wait();
      } finally {
        if (--waits === 0) await status.set('running');
      }
    };
    const session = await acquire(thread.id, trigger.client.user.id, channel, ts.sessionId, ts.resumeCostBase ?? ts.lastCostTotal);
    progress = stopControl(thread, who, STOP_BUTTON_DELAY_MS, (by) => void session.interrupt(by));
    const turn = await session.run(prompt, {
      sendReply: async (text, files) => {
        const chunks = splitMessage(text);
        if (!chunks.length && files.length) chunks.push('');
        for (const [i, chunk] of chunks.entries()) {
          const attach = i === chunks.length - 1 ? files.map((f) => ({ attachment: f, name: path.basename(f) })) : [];
          lastReply = await thread.send({ ...(chunk ? { content: chunk } : {}), files: attach, allowedMentions: { parse: ['users'] } });
        }
      },
      askPermission: (req) =>
        waiting(async () => {
          try {
            const answer = await askPermission(thread, req, who, channel.permissionTimeoutMs);
            if (answer.behavior === 'always') {
              ts.alwaysAllow = [...new Set([...(ts.alwaysAllow ?? []), req.toolName])];
              saveState();
            }
            return answer;
          } catch (e) {
            log('error', `permission prompt ${thread.id}: ${(e as Error).message}`);
            return { behavior: 'deny' as const, message: `無法在 Discord 上詢問主人（${(e as Error).message}），已拒絕。` };
          }
        }),
      askQuestion: (questions, signal) =>
        waiting(() =>
          askQuestion(thread, questions, who, channel.permissionTimeoutMs, signal).catch((e) => {
            log('error', `question prompt ${thread.id}: ${(e as Error).message}`);
            return undefined;
          }),
        ),
    });
    const progressMessage = await progress.end();

    if (turn.sessionId) ts.sessionId = turn.sessionId;
    ts.lastCostTotal = turn.costTotal;
    ts.lastSeenMessageId = trigger.id;
    saveState();

    // The progress message is reused for whatever notice the turn ends with, otherwise removed.
    const notice = async (content: string): Promise<Message> =>
      progressMessage
        ? await progressMessage.edit({ content, components: [], allowedMentions: { parse: [] } })
        : await thread.send({ content, allowedMentions: { parse: [] } });

    if (turn.stoppedBy) {
      log('stopped', `${thread.id} by ${turn.stoppedBy} subtype=${turn.subtype}`);
      const msg = await notice(`⏹️ 已由 ${turn.stoppedBy} 停止。下一則訊息會接著這段對話。`);
      await attachDetails(msg, rememberTurn(thread.id, turn));
      await status.set('stopped');
      return;
    }
    // Another bot got no answer on purpose (nothing to do): stay silent instead of
    // posting a summary, which would only add noise to the bot-to-bot exchange.
    if (turn.ok && turn.replies === 0 && trigger.author.bot) {
      log('silent', `${thread.id} no reply to bot ${trigger.author.username} ${brief(turn.lastText, 200)}`);
      await progressMessage?.delete().catch(() => {});
      await status.set('done');
      return;
    }
    if (!turn.ok || turn.replies === 0 || !lastReply) {
      const text = turn.ok
        ? `（沒有呼叫 reply，以下為自動摘要）\n${turn.lastText.trim().slice(0, FALLBACK_MAX) || '（沒有輸出）'}`
        : `執行失敗：${turn.subtype}${turn.error ? `（${turn.error.slice(0, 200)}）` : ''}。下次觸發時會接回這段對話。`;
      log('fallback', `${thread.id} ${brief(text, 200)}`);
      lastReply = await notice(text);
    } else {
      await progressMessage?.delete().catch(() => {});
    }
    await attachDetails(lastReply, rememberTurn(thread.id, turn));
    await status.set(turn.ok ? 'done' : 'failed');
  } catch (e) {
    log('error', `run ${thread.id}: ${(e as Error).stack ?? e}`);
    await (await progress?.end())?.delete().catch(() => {});
    await thread.send({ content: `執行失敗：${(e as Error).message.slice(0, 200)}`, allowedMentions: { parse: [] } }).catch(() => {});
    await status.set('failed');
  }
}
