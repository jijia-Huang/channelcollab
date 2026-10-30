/**
 * The "📄 詳細" button: shows the clicker, and only them, what this turn did.
 * Details are kept in memory; after a restart old buttons report "no record".
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import type { TurnResult } from '../runner/session.js';

const PREFIX = 'detail:';
const MAX_KEPT = 200;
const details = new Map<string, TurnResult>();
let seq = 0;

export function rememberTurn(threadId: string, turn: TurnResult): string {
  const id = `${PREFIX}${threadId}:${++seq}`;
  details.set(id, turn);
  if (details.size > MAX_KEPT) details.delete(details.keys().next().value!);
  return id;
}

export function detailsButton(customId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel('詳細').setEmoji('📄').setStyle(ButtonStyle.Secondary),
  );
}

export async function attachDetails(message: Message, customId: string): Promise<void> {
  await message.edit({ components: [detailsButton(customId)] });
}

export function isDetailsButton(customId: string): boolean {
  return customId.startsWith(PREFIX);
}

function format(t: TurnResult): string {
  const lines = [
    `**這一輪**：${t.ok ? '✅ 完成' : t.stoppedBy ? '⏹️ 已停止' : `❌ ${t.subtype}`}　模型 ${t.model ?? '-'}　${t.numTurns} 步　${(t.durationMs / 1000).toFixed(1)} 秒`,
    `**費用**：本輪 $${t.turnCost.toFixed(4)}（session 累計 $${t.costTotal.toFixed(4)}）`,
    `**Session**：\`${t.sessionId ?? '-'}\``,
  ];
  if (t.stoppedBy) lines.push(`**停止**：由 ${t.stoppedBy} 按 🛑 停止`);
  if (t.denials.length) lines.push(`**被拒絕的工具**：${t.denials.join(', ')}`);
  if (t.error) lines.push(`**錯誤**：${t.error.slice(0, 200)}`);
  lines.push(`**工具動作**（${t.tools.length}）：`);
  for (const [i, u] of t.tools.entries()) lines.push(`${i + 1}. \`${u.name}\` ${u.input.replace(/`/g, "'")}`);
  let text = lines.join('\n');
  if (text.length > 1900) text = `${text.slice(0, 1900)}\n…（已截斷）`;
  return text;
}

export async function handleDetailsClick(i: ButtonInteraction): Promise<void> {
  const t = details.get(i.customId);
  const content = t ? format(t) : '找不到這一輪的紀錄（Bot 可能重啟過）。';
  await i.reply({ content, flags: MessageFlags.Ephemeral });
}
