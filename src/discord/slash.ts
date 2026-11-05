/**
 * Discord slash commands: registered as global commands on start (bulk
 * overwrite, so a restart never duplicates them) and handled by the same
 * runCommand as `!` commands, after the same gate (commands.ts commandGate).
 * Refusals and private answers are ephemeral; commands that change the
 * conversation leave a short public note there.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type AnyThreadChannel,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type StringSelectMenuBuilder,
} from 'discord.js';
import { loadConfig, resolveChannel, resolveDm, type Config, type ResolvedChannel } from '../config.js';
import { log } from '../log.js';
import { botOwner, loadRosterFile } from '../roster.js';
import { skillChoices } from '../runner/skills.js';
import { allowedTrigger } from '../security/access.js';
import { pinGate } from '../security/pin.js';
import { DM_KEY, getDm, getThread, registerThread, skillsFor } from '../store/state.js';
import { runCommand, type CommandIO } from './command-run.js';
import { commandFromSlash, commandGate, gateText, slashDefinitions, type Command, type GateFacts, type GateRefusal } from './commands.js';
import { convFor, running, type Conv } from './conversation.js';
import type { Who } from './prompts.js';

/** A thread opened from a message keeps that message in the parent channel; its author, if human. */
export async function starterHuman(thread: AnyThreadChannel): Promise<string | undefined> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  return starter && !starter.author.bot ? starter.author.id : undefined;
}

/** Who may use commands in a thread (like 🛑): the owner, or whoever asked for the running turn, else the starter. */
export async function threadWho(thread: AnyThreadChannel, ownerId: string | undefined): Promise<Who> {
  return { ownerId, requesterId: running.get(thread.id)?.requesterId ?? (await starterHuman(thread)) };
}

/** Register this bot's global slash commands (PUT: replaces the whole list). */
export async function registerSlashCommands(client: Client<true>): Promise<void> {
  const defs = slashDefinitions();
  try {
    // JSON as is: discord.js would otherwise drop the snake_case fields (contexts, integration_types).
    const r = await client.application.commands.set(defs.map((d) => ({ toJSON: () => d })));
    log('commands', `registered ${r.size} global slash commands: ${[...r.values()].map((c) => `/${c.name}`).join(' ')}`);
  } catch (e) {
    log('commands', `slash command registration failed: ${(e as Error).message}`);
  }
}

/**
 * Where the interaction happened, and the conversation there when it may run.
 * `light` (autocomplete, which must answer within 3 seconds without deferring):
 * no network calls; the conversation is only described by its folder (`cwd`),
 * and the thread's requester is only known while a turn runs.
 */
type Place = { where: 'dm' | 'thread' | 'channel'; facts: GateFacts; who: Who; conv?: Conv; cwd?: string };

async function place(i: ChatInputCommandInteraction | AutocompleteInteraction, cmd: Command['name'], config: Config, light = false): Promise<Place> {
  const me = i.client.user.id;
  const ownerId = botOwner(config.discord.owner_id, me);
  const base = { cmd, actorId: i.user.id, ownerId, locked: pinGate.locked };
  if (!i.inGuild()) {
    let dm: ResolvedChannel | undefined;
    try {
      dm = resolveDm(config);
    } catch (e) {
      log('config', (e as Error).message);
    }
    const facts: GateFacts = { ...base, where: 'dm', dmEnabled: !!dm, pinSet: pinGate.configured, pinUnlocked: pinGate.unlocked };
    const ok = !commandGate(facts);
    const cwd = dm ? (getDm().cwd ?? dm.cwd) : undefined;
    return { where: 'dm', facts, who: { ownerId }, cwd, conv: ok && !light ? await convFor(i.client, DM_KEY) : undefined };
  }
  const ch = i.channel ?? (light ? null : await i.client.channels.fetch(i.channelId).catch(() => null));
  const inThread = !!ch?.isThread();
  const baseId = inThread ? ((ch as AnyThreadChannel).parentId ?? '') : i.channelId;
  let channel: ResolvedChannel | undefined;
  try {
    channel = resolveChannel(config, baseId);
  } catch (e) {
    log('config', (e as Error).message);
  }
  const bound = !!channel && (!config.discord.guild_id || i.guildId === config.discord.guild_id);
  const notAllowed = config.access.roster_only && !allowedTrigger(i.user.id, ownerId, loadRosterFile());
  const who: Who =
    inThread && bound && !notAllowed ? (light ? { ownerId, requesterId: running.get(ch!.id)?.requesterId } : await threadWho(ch as AnyThreadChannel, ownerId)) : { ownerId };
  const facts: GateFacts = { ...base, where: inThread ? 'thread' : 'channel', bound, notAllowed, requesterId: who.requesterId };
  if (commandGate(facts) || !inThread || !channel) return { where: inThread ? 'thread' : 'channel', facts, who };
  const thread = ch as AnyThreadChannel;
  return { where: 'thread', facts, who, cwd: channel.cwd, conv: { key: thread.id, kind: 'thread', room: thread, base: channel, selfId: me } };
}

/** The slash side of CommandIO: deferred ephemerally; public notes are follow-ups in the conversation. */
function slashIO(i: ChatInputCommandInteraction): CommandIO & { finish(): Promise<void> } {
  let answered = false;
  const publicNote = async (content: string): Promise<Message> => {
    const m = await i.followUp({ content, allowedMentions: { parse: [] } });
    return m;
  };
  return {
    actor: { id: i.user.id, name: i.user.displayName || i.user.username },
    client: i.client,
    slash: true,
    tell: async (content: string, components?: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]) => {
      answered = true;
      await i.editReply({ content, ...(components ? { components } : {}), allowedMentions: { parse: [] } });
    },
    note: async (content) => void (await publicNote(content)),
    ack: async (_emoji, content) => void (await publicNote(content)),
    anchor: publicNote,
    // The ephemeral "thinking…" placeholder is removed when only public notes were posted.
    finish: async () => {
      if (!answered) await i.deleteReply().catch(() => {});
    },
  };
}

function refusalText(r: GateRefusal, p: Place): string {
  return gateText(r, { cmd: p.facts.cmd, ownerId: p.who.ownerId, requesterId: p.who.requesterId, slash: true });
}

/** Unlock button for a direct message that needs the PIN (handled by bot.ts, customId dmunlock). */
const unlockRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('dmunlock').setLabel('解鎖').setEmoji('🔓').setStyle(ButtonStyle.Primary));

export async function handleSlashCommand(i: ChatInputCommandInteraction): Promise<void> {
  // Several bots in one server register the same names; Discord sends each bot only its own.
  if (i.applicationId !== i.client.application.id) return;
  // Within Discord's 3 seconds; the answer comes later through editReply / followUp.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const cmd = commandFromSlash(i.commandName, { name: i.options.getString('name') ?? undefined, args: i.options.getString('args') ?? undefined, level: i.options.getString('level') ?? undefined });
  if (!cmd) return void (await i.editReply({ content: '這隻 Bot 不認得這個指令。' }));
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    log('config', (e as Error).message);
    return void (await i.editReply({ content: 'Bot 的設定檔讀不到，請主人在電腦上用 /channelcollab:status 檢查。' }));
  }
  const p = await place(i, cmd.name, config);
  const refusal = commandGate(p.facts);
  if (refusal) {
    log('command', `/${cmd.name} refused ${i.user.username} (${i.user.id}) ${refusal} channel=${i.channelId ?? 'dm'}`);
    await i.editReply({ content: refusalText(refusal, p), ...(refusal === 'dm-pin-needed' ? { components: [unlockRow()] } : {}), allowedMentions: { parse: [] } });
    return;
  }
  if (!p.conv) return void (await i.editReply({ content: '找不到這段對話，請稍後再試。' }));
  if (p.conv.kind === 'thread') {
    const thread = p.conv.room as AnyThreadChannel;
    if (!getThread(thread.id)) {
      registerThread(thread.id, (thread.parentId ?? '') as string, thread.name);
      log('thread', `adopted ${thread.id} "${thread.name}" (slash command)`);
    }
  }
  // Same as a `!` command: in a thread the owner keeps the requester; anyone else becomes it.
  const who: Who = p.where === 'dm' ? { ownerId: p.who.ownerId } : { ownerId: p.who.ownerId, requesterId: i.user.id === p.who.ownerId ? p.who.requesterId : i.user.id };
  const io = slashIO(i);
  await runCommand(cmd, p.conv, io, who);
  await io.finish();
}

/** /skill name: the skills of the conversation's working folder, as last reported by a session there. */
export async function handleSlashAutocomplete(i: AutocompleteInteraction): Promise<void> {
  if (i.applicationId !== i.client.application.id || i.commandName !== 'skill') return;
  let config: Config;
  try {
    config = loadConfig();
  } catch {
    return void (await i.respond([]));
  }
  const p = await place(i, 'skill', config, true);
  // Who may run it is checked again when the command is sent; here a thread's requester may not be known yet.
  const r = commandGate(p.facts);
  if ((r && r !== 'not-actor') || !p.cwd) return void (await i.respond([]));
  await i.respond(skillChoices(skillsFor(p.cwd), String(i.options.getFocused() ?? '')));
}
