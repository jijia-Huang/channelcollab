/**
 * Discord side: decides whether a message triggers a run (threads under bound
 * channels, and the owner's direct messages), opens the thread, runs `!`
 * commands, queues turns, and routes the buttons and menus.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type DMChannel,
  type Interaction,
  type Message,
} from 'discord.js';
import { loadConfig, resolveChannel, resolveDm, type Config, type ResolvedChannel } from '../config.js';
import { brief, log } from '../log.js';
import { enqueue } from '../router/queue.js';
import { countHops, decide } from '../router/trigger.js';
import { canAct } from '../runner/policy.js';
import { botOwner, loadRosterFile, ROSTER_PATH } from '../roster.js';
import { allowedTrigger } from '../security/access.js';
import { pinGate } from '../security/pin.js';
import { DM_KEY, getThread, registerThread, saveState } from '../store/state.js';
import { handleApprovalInteraction, isApprovalInteraction } from './approvals-ui.js';
import { handleCommandInteraction, isCommandInteraction, runCommand } from './command-run.js';
import { COMMANDS, dmAccess, mentionsOtherBotRole, mentionsSelf, parseCommand, throttle, type Command, type RoleMention } from './commands.js';
import { runTurn, running, type Conv } from './conversation.js';
import { handleDetailsClick, isDetailsButton } from './details.js';
import { checkPin, LOCKED_REPLY, pinModal, pinOkFollowUp } from './pin-ui.js';
import { handlePromptInteraction, isPromptInteraction, type Who } from './prompts.js';
import { StatusReactions } from './status.js';

function threadName(message: Message): string {
  const text = message.content.replace(/<@[!&]?\d+>/g, '').replace(/\s+/g, ' ').trim();
  return (text || 'Claude 任務').slice(0, 60);
}

/** Roles mentioned in a guild message, with the bot each managed bot role belongs to. */
function roleMentions(message: Message): RoleMention[] {
  return [...message.mentions.roles.values()].map((r) => ({ id: r.id, botId: r.tags?.botId ?? null }));
}

/** The message @-mentions a bot other than `exceptId` (as a user, or through that bot's managed role). */
function mentionsBot(message: Message, exceptId: string): boolean {
  return message.mentions.users.some((u) => u.bot && u.id !== exceptId) || (message.inGuild() && mentionsOtherBotRole(roleMentions(message), exceptId));
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    // A direct message channel is often not cached yet; without this its messages never arrive.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, (message) => {
    onMessage(message).catch((e) => log('error', `message ${message.id}: ${(e as Error).stack ?? e}`));
  });

  client.once(Events.ClientReady, (c) => {
    let config: Config | undefined;
    try {
      config = loadConfig();
    } catch {}
    const configured = config?.discord.owner_id;
    const owner = botOwner(configured, c.user.id);
    log('owner', owner ? `${owner} (${configured ? 'discord.owner_id' : 'roster'})` : 'none: set discord.owner_id, or permission requests are denied');
    const roster = loadRosterFile();
    log('roster', `${roster.bots.length} bots, ${roster.members.length} members from ${ROSTER_PATH}`);
    const dm = config && resolveDm(config);
    log('dm', `intent DirectMessages on; ${dm ? `dm configured cwd=${dm.cwd} mode=${dm.permissionMode} model=${dm.model ?? '-'} launcher=${dm.launcher || 'builtin'}${pinGate.configured ? '' : ' (closed until a PIN is set)'}` : 'dm not configured (direct messages closed)'}`);
    log('security', `pin=${pinGate.configured ? 'set' : 'not set'} unlock_minutes=${config?.security.pin_unlock_minutes ?? '-'} roster_only=${config?.access.roster_only ?? '-'} owner_wait_minutes=${config?.defaults.owner_wait_minutes ?? '-'}`);
  });

  client.on(Events.InteractionCreate, (i) => {
    onInteraction(i).catch((e) => log('error', `interaction ${'customId' in i ? i.customId : i.type}: ${(e as Error).stack ?? e}`));
  });

  return client;
}

async function onInteraction(i: Interaction): Promise<void> {
  if (i.isButton() && isDetailsButton(i.customId)) {
    log('details', `${i.customId} clicked by ${i.user.username}`);
    await handleDetailsClick(i);
  } else if (isPromptInteraction(i)) await handlePromptInteraction(i);
  else if (isApprovalInteraction(i)) await handleApprovalInteraction(i);
  else if (isCommandInteraction(i)) await handleCommandInteraction(i);
  else if ((i.isButton() || i.isModalSubmit()) && /^dmunlock/.test(i.customId)) await handleDmUnlock(i);
}

async function onMessage(message: Message): Promise<void> {
  const me = message.client.user.id;
  if (message.author.id === me) return;
  // Locked after too many wrong PINs: the whole bot pauses until `unlock` on the computer or a restart.
  if (pinGate.locked) {
    log('ignore', `${message.id} locked (wrong PINs) author=${message.author.username}`);
    return;
  }
  if (!message.inGuild()) return onDirectMessage(message);

  let config: Config;
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
  // Picking the bot in Discord's mention list often inserts its managed role instead of the bot itself; both count.
  const mentionsMe = mentionsSelf({ userIds: message.mentions.users.keys(), roles: roleMentions(message) }, me, message.guild.members.me?.roles.botRole?.id);
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
  const mentions = [...message.mentions.users.keys(), ...message.mentions.roles.keys()].join(',');
  if (decision.action === 'ignore') {
    // Unbound channels stay silent in the log too; everything else says why it was skipped.
    if (decision.reason !== 'unbound-channel') log('ignore', `${message.id} ${decision.reason} channel=${ch.id} owner=${ownerId ?? '-'} author=${message.author.username} mentions=[${mentions}] text=${brief(message.content, 80)}`);
    return;
  }
  if (!channel) return;

  const botOwnerId = botOwner(config.discord.owner_id, me);
  // Allowlist: only the owner and people / bots in the roster. Others are ignored without a reply.
  if (config.access.roster_only && !allowedTrigger(message.author.id, botOwnerId, loadRosterFile())) {
    log('ignore', `${message.id} not-allowed author=${message.author.username} (${message.author.id}) channel=${ch.id}`);
    return;
  }

  const cmd = fromBot ? undefined : parseCommand(message.content);
  if (cmd && decision.action === 'open-thread') {
    await message.reply({ content: '指令請在討論串裡（或私訊 Bot）使用。', allowedMentions: { parse: [] } });
    return;
  }

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
  const known = getThread(thread.id);
  if (!known) {
    registerThread(thread.id, baseChannelId, thread.name);
    if (ownerId !== me) log('thread', `adopted ${thread.id} "${thread.name}" owner=${ownerId ?? '-'}`);
  } else if (known.name !== thread.name) {
    known.name = thread.name;
    saveState();
  }
  const conv: Conv = { key: thread.id, kind: 'thread', room: thread, base: channel, selfId: me };

  if (cmd) return threadCommand(cmd, conv, thread, message, botOwnerId);

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
    ownerId: botOwnerId,
    // A bot cannot click, and naming it in a prompt could trigger it.
    requesterId: fromBot ? undefined : message.author.id,
  };
  const { queued } = enqueue(thread.id, () => runTurn(conv, message, status, who));
  if (queued) {
    log('queue', `${message.id} waiting for thread ${thread.id}`);
    await status.set('waiting');
  }
}

/** A command in a thread: the owner, or whoever asked for the running turn (else the thread's starter), like 🛑. */
async function threadCommand(cmd: Command, conv: Conv, thread: AnyThreadChannel, message: Message, ownerId: string | undefined): Promise<void> {
  if (COMMANDS[cmd.name].dmOnly) {
    await message.reply({ content: `\`!${cmd.name}\` 只能在私訊 Bot 時使用。`, allowedMentions: { parse: [] } });
    return;
  }
  const who: Who = { ownerId, requesterId: running.get(conv.key)?.requesterId ?? (await starterHuman(thread)) };
  if (!canAct('stop', message.author.id, who)) {
    log('command', `${conv.key} !${cmd.name} refused ${message.author.username}`);
    const names = [who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
    await message.reply({ content: `只有 ${names.join(' 或 ') || 'Bot 的主人'} 可以在這個討論串用指令。`, allowedMentions: { parse: [] } });
    return;
  }
  await runCommand(cmd, conv, message, { ownerId, requesterId: message.author.id === ownerId ? who.requesterId : message.author.id });
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

/** Refusals in direct messages, at most one per person per 10 minutes. */
const refused = new Map<string, number>();
/** Messages that arrived while the PIN was needed; handled in order once it is entered. */
const held: Message[] = [];
const HELD_MAX = 20;
let unlockPrompted = 0;

/** The message's direct-message channel, fetched when Discord sent it as a partial. */
async function dmChannel(message: Message): Promise<DMChannel | undefined> {
  const ch = message.channel.partial ? await message.channel.fetch().catch(() => undefined) : message.channel;
  return ch?.type === ChannelType.DM ? ch : undefined;
}

async function onDirectMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  const room = await dmChannel(message);
  if (!room) return;
  const me = message.client.user.id;
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    log('config', (e as Error).message);
    return;
  }
  const ownerId = botOwner(config.discord.owner_id, me);
  let dm: ResolvedChannel | undefined;
  try {
    dm = resolveDm(config);
  } catch (e) {
    log('config', (e as Error).message);
  }
  const access = dmAccess({ authorId: message.author.id, ownerId, dmEnabled: !!dm });
  const answer = async (text: string) => {
    if (throttle(refused, message.author.id)) await room.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  };
  if (access === 'not-owner') {
    log('ignore', `${message.id} dm-not-owner author=${message.author.username} (${message.author.id})`);
    return answer('這隻 Bot 只接受主人私訊。');
  }
  if (access === 'disabled' || !dm) {
    log('ignore', `${message.id} dm-disabled`);
    return answer('私訊未開啟：請在電腦上用 /channelcollab:bind 開啟私訊（要先設定 PIN）。');
  }
  if (!pinGate.configured) {
    log('ignore', `${message.id} dm-no-pin`);
    return answer('私訊要先設定 PIN 才能用：請在電腦上執行 channelcollab 的 set-pin（或雙擊桌面的「設定 channelcollab PIN.bat」）。');
  }
  if (!pinGate.unlocked) {
    if (held.length < HELD_MAX) held.push(message);
    log('dm', `${message.id} held until the PIN is entered (${held.length} waiting)`);
    await message.react('🔒').catch(() => {});
    if (Date.now() - unlockPrompted > 60 * 1000) {
      unlockPrompted = Date.now();
      await room.send({
        content: `🔒 私訊要先輸入 PIN 解鎖（解鎖後 ${config.security.pin_unlock_minutes} 分鐘內不用再輸入）。剛剛的訊息會在解鎖後接著處理。`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('dmunlock').setLabel('解鎖').setEmoji('🔓').setStyle(ButtonStyle.Primary))],
      });
    }
    return;
  }
  await handleDm(message, dm, ownerId!);
}

async function handleDm(message: Message, dm: ResolvedChannel, ownerId: string): Promise<void> {
  const room = await dmChannel(message);
  if (!room) return;
  const conv: Conv = { key: DM_KEY, kind: 'dm', room, base: dm, selfId: message.client.user.id };
  const who: Who = { ownerId };
  const cmd = parseCommand(message.content);
  if (cmd) return runCommand(cmd, conv, message, who);
  log('trigger', `${message.id} dm author=${message.author.username} text=${brief(message.content, 120)}`);
  const status = new StatusReactions(message);
  await status.set('received');
  const { queued } = enqueue(DM_KEY, () => runTurn(conv, message, status, who));
  if (queued) {
    log('queue', `${message.id} waiting for dm`);
    await status.set('waiting');
  }
}

async function handleDmUnlock(i: Interaction): Promise<void> {
  if (!i.isButton() && !i.isModalSubmit()) return;
  const config = loadConfig();
  const ownerId = botOwner(config.discord.owner_id, i.client.user.id);
  if (!canAct('permission', i.user.id, { ownerId })) {
    await i.reply({ content: '只有 Bot 的主人可以解鎖。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (pinGate.locked) {
    await i.reply({ content: LOCKED_REPLY, flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isButton()) {
    if (pinGate.unlocked) {
      await i.update({ content: '🔓 已經解鎖了。', components: [] });
      return;
    }
    await i.showModal(pinModal('dmunlockpin', '解鎖私訊'));
    return;
  }
  const announce = (text: string) => (i.channel?.isSendable() ? i.channel.send({ content: text, allowedMentions: { parse: [] } }) : Promise.resolve());
  if (!(await checkPin(i, announce))) return;
  if (i.isFromMessage()) await i.update({ content: '🔓 已解鎖。', components: [] });
  else await i.deferUpdate();
  await pinOkFollowUp(i);
  const dm = resolveDm(config);
  const waiting = held.splice(0);
  log('dm', `unlocked; handling ${waiting.length} held message(s)`);
  if (!dm || !ownerId) return;
  for (const m of waiting) {
    await m.reactions.cache.get('🔒')?.users.remove(i.client.user.id).catch(() => {});
    await handleDm(m, dm, ownerId).catch((e) => log('error', `held dm ${m.id}: ${(e as Error).stack ?? e}`));
  }
}
