/**
 * Approve later, Discord side (runner/approvals.ts has the rules): the card
 * sent to the owner, the short notice in the thread, the buttons (all / pick /
 * deny all, owner only, PIN as for any approval) and the follow-up turn.
 * Batches live in state.json, so these buttons survive a restart until they expire.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { loadConfig } from '../config.js';
import { log } from '../log.js';
import { enqueue } from '../router/queue.js';
import { approvedPrompt, decide, deferredKeys, deliverCard, deniedNote, newBatch, noticeText, outcomeText, type Batch, type Choice, type DeferredItem } from '../runner/approvals.js';
import { canAct } from '../runner/policy.js';
import { botOwner } from '../roster.js';
import { approvalStep, pinGate } from '../security/pin.js';
import { getBatch, putBatch, saveState } from '../store/state.js';
import { shortTime } from './commands.js';
import { convFor, convState, runTurn, type Conv } from './conversation.js';
import { checkPin, LOCKED_REPLY, pinModal, pinOkFollowUp } from './pin-ui.js';
import { summarizeTool, type Who } from './prompts.js';
import { StatusReactions } from './status.js';

const MAX_CONTENT = 1900;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function cardText(b: Batch): string {
  const where = b.kind === 'dm' ? '私訊' : `討論串 <#${b.convKey}>`;
  const who = b.requesterId ? `<@${b.requesterId}>` : '其他 Bot';
  const each = Math.max(200, Math.floor(1300 / b.items.length));
  const items = b.items.map((x, i) => `**${i + 1}. \`${x.toolName}\`**\n${clip(summarizeTool(x.toolName, x.input), each)}`);
  const pin = pinGate.configured ? '按「允許」要輸入 PIN。' : '';
  return clip(`⏳ **待核准**（${where}，需求來自 ${who}）\nClaude 做到一半，下面的動作要你核准；核准後 Bot 會接著做。\n\n${items.join('\n')}\n\n有效到 ${shortTime(b.expiresAt)}。${pin}`, MAX_CONTENT - 200);
}

function cardButtons(b: Batch) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`appr:${b.id}:all`).setLabel('全部允許').setStyle(ButtonStyle.Success));
  if (b.items.length > 1) row.addComponents(new ButtonBuilder().setCustomId(`appr:${b.id}:pick`).setLabel('逐項選擇').setStyle(ButtonStyle.Primary));
  row.addComponents(new ButtonBuilder().setCustomId(`appr:${b.id}:deny`).setLabel('全部拒絕').setStyle(ButtonStyle.Danger));
  return [row];
}

/** Turn end: the deferred calls become a batch; card to the owner (DM, else the thread), short notice in the thread. */
export async function sendApprovalBatch(c: Conv, items: DeferredItem[], who: Who): Promise<Batch> {
  const ownerId = who.ownerId!;
  const b = newBatch({ id: newId(), convKey: c.key, kind: c.kind, requesterId: who.requesterId, items });
  const payload = { content: cardText(b), components: cardButtons(b), allowedMentions: { parse: [] as [] } };
  const { where, sent } = await deliverCard<Message>(
    {
      // In a direct message conversation the card simply goes there.
      dm: c.kind === 'dm' ? undefined : async () => (await c.room.client.users.fetch(ownerId)).send(payload),
      thread: () => c.room.send(payload),
    },
    (e) => log('approval', `${b.id} direct message to the owner failed (${e.message}); card goes to the thread`),
  );
  b.card = { channelId: sent.channelId, messageId: sent.id, where: c.kind === 'dm' ? 'dm' : where };
  if (c.kind === 'thread') {
    const n = await c.room.send({ content: noticeText(b, ownerId, where), allowedMentions: { users: [ownerId] } });
    b.notice = { channelId: n.channelId, messageId: n.id };
  }
  putBatch(b);
  log('approval', `${b.id} ${c.key} ${b.items.length} deferred call(s) [${b.items.map((x) => x.toolName).join(', ')}] card=${b.card.where}`);
  return b;
}

async function fetchStored(client: Client, ref: { channelId: string; messageId: string } | undefined): Promise<Message | undefined> {
  if (!ref) return undefined;
  const ch = await client.channels.fetch(ref.channelId).catch(() => null);
  if (!ch?.isTextBased()) return undefined;
  return (await ch.messages.fetch(ref.messageId).catch(() => undefined)) ?? undefined;
}

/** Card and thread notice after a decision (or expiry). */
async function refresh(client: Client, b: Batch, outcome: string, skipCard = false): Promise<void> {
  const ownerId = botOwner(loadConfig().discord.owner_id, client.user!.id) ?? '';
  if (!skipCard) await (await fetchStored(client, b.card))?.edit({ content: clip(`${cardText(b)}\n${outcome}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } }).catch(() => {});
  await (await fetchStored(client, b.notice))?.edit({ content: noticeText(b, ownerId, b.card?.where ?? 'thread'), allowedMentions: { parse: [] } }).catch(() => {});
}

/** After the owner decided: approved calls run in a new turn (allowed by retryKey); a full denial is told to Claude with the next message. */
async function continueAfter(client: Client<true>, b: Batch, allow: DeferredItem[], deny: DeferredItem[]): Promise<void> {
  const c = await convFor(client, b.convKey);
  if (!c) {
    log('approval', `${b.id} conversation ${b.convKey} is no longer available`);
    return;
  }
  if (!allow.length) {
    convState(c).pendingNote = deniedNote(deny);
    saveState();
    return;
  }
  const trigger = (await fetchStored(client, b.notice ?? b.card)) ?? (await c.room.send({ content: '▶️ 接著做主人核准的動作。', allowedMentions: { parse: [] } }));
  const ownerId = botOwner(loadConfig().discord.owner_id, client.user.id);
  const who: Who = { ownerId, requesterId: b.requesterId };
  const status = new StatusReactions(trigger);
  await status.set('received');
  log('approval', `${b.id} continue ${b.convKey} with ${allow.length} approved call(s)`);
  enqueue(c.key, () => runTurn(c, trigger, status, who, { prompt: approvedPrompt(allow, deny), kind: 'approved', preapproved: deferredKeys(allow) }));
}

type Answerable = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

async function finish(i: Answerable, b: Batch, choice: Choice, viaPin: boolean): Promise<void> {
  const d = decide(b, choice);
  putBatch(b);
  const by = i.user.displayName || i.user.username;
  const outcome = outcomeText(d, by);
  log('approval', `${b.id} ${d.result === 'decided' ? d.status : d.result} by ${i.user.username}${viaPin ? ' after PIN' : ''}`);
  // Pressed on the card itself: update it in place; otherwise (pick menu, modal) answer privately and edit the card.
  const onCard = i.message?.id === b.card?.messageId;
  if (onCard && (i.isButton() || (i.isModalSubmit() && i.isFromMessage()))) {
    await i.update({ content: clip(`${cardText(b)}\n${outcome}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
  } else if (i.isStringSelectMenu() || (i.isModalSubmit() && i.isFromMessage())) {
    await i.update({ content: outcome, components: [] });
  } else {
    await i.reply({ content: outcome, flags: MessageFlags.Ephemeral });
  }
  if (viaPin && i.isModalSubmit()) await pinOkFollowUp(i);
  await refresh(i.client, b, outcome, onCard);
  if (d.result === 'decided') await continueAfter(i.client, b, d.allow, d.deny);
}

export function isApprovalInteraction(i: Interaction): boolean {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
  return /^(appr|apprpick|apprpin):/.test(i.customId);
}

/** Parse "all" / "none" / "0.2" (0-based indices) from a custom ID. */
const parseChoice = (s: string): Choice => (s === 'all' ? 'all' : s === 'none' ? 'none' : s.split('.').map(Number));

export async function handleApprovalInteraction(i: Interaction): Promise<void> {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return;
  const [kind, id, arg] = i.customId.split(':');
  const b = getBatch(id);
  if (!b) {
    await i.reply({ content: '找不到這份待核准清單（可能已經過期很久）。', flags: MessageFlags.Ephemeral });
    return;
  }
  const ownerId = botOwner(loadConfig().discord.owner_id, i.client.user.id);
  // Owner first: nobody else gets as far as a PIN prompt.
  if (!canAct('permission', i.user.id, { ownerId })) {
    log('approval', `${id} refused ${i.user.username} (${i.user.id})`);
    await i.reply({ content: '只有 Bot 擁有者可以核准。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (b.status !== 'pending' || Date.now() >= b.expiresAt) {
    const d = decide(b, 'none');
    putBatch(b);
    if (d.result === 'expired') await refresh(i.client, b, outcomeText(d, ''));
    await i.reply({ content: outcomeText(d, ''), flags: MessageFlags.Ephemeral });
    return;
  }

  if (i.isButton() && kind === 'appr') {
    if (arg === 'deny') return finish(i, b, 'none', false);
    if (arg === 'pick') {
      await i.reply({
        content: '選要允許的動作（沒選的會拒絕）：',
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`apprpick:${b.id}`)
              .setMinValues(1)
              .setMaxValues(b.items.length)
              .setPlaceholder('選擇要允許的動作')
              .addOptions(b.items.map((x, n) => ({ label: clip(`${n + 1}. ${x.toolName}`, 100), value: String(n), description: clip(JSON.stringify(x.input), 100) }))),
          ),
        ],
      });
      return;
    }
    return approve(i, b, 'all');
  }
  if (i.isStringSelectMenu() && kind === 'apprpick') return approve(i, b, i.values.map(Number));
  if (i.isModalSubmit() && kind === 'apprpin') {
    const announce = (text: string) => (i.channel?.isSendable() ? i.channel.send({ content: text, allowedMentions: { parse: [] } }) : Promise.resolve());
    if (!(await checkPin(i, announce))) return;
    return finish(i, b, parseChoice(arg), true);
  }
}

/** Approving goes through the PIN like any approval. */
async function approve(i: ButtonInteraction | StringSelectMenuInteraction, b: Batch, choice: Choice): Promise<void> {
  const step = approvalStep(true, pinGate);
  if (step === 'locked') {
    await i.reply({ content: LOCKED_REPLY, flags: MessageFlags.Ephemeral });
    return;
  }
  if (step === 'pin') {
    const arg = choice === 'all' || choice === 'none' ? choice : choice.join('.');
    await i.showModal(pinModal(`apprpin:${b.id}:${arg}`, '核准待核准的動作'));
    return;
  }
  return finish(i, b, choice, false);
}
