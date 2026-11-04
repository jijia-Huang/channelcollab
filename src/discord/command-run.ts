/**
 * Running `!` commands (parsing and the rules are in commands.ts). Commands
 * that act right away (!stop, !model, !plan, !status, !help, !clear, !resume)
 * never wait in the conversation's queue; !compact and !retry are turns and
 * queue like any message.
 */
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type Client,
  type Interaction,
  type Message,
} from 'discord.js';
import { loadConfig, resolveDm } from '../config.js';
import { log } from '../log.js';
import { enqueue, isPending } from '../router/queue.js';
import { canAct } from '../runner/policy.js';
import { liveSession, release } from '../runner/pool.js';
import { latestRateLimit, rateSummary } from '../runner/usage.js';
import { pinGate } from '../security/pin.js';
import { allThreads, DM_KEY, dmHistory, getThread, saveState, switchDm, type DmState } from '../store/state.js';
import { duration, helpText, MODEL_CHOICES, normalizeModel, resumeList, resumeOption, shortTime, type Command, type ResumeCandidate } from './commands.js';
import { convState, effective, runTurn, type Conv } from './conversation.js';
import type { Who } from './prompts.js';
import { StatusReactions } from './status.js';

type PermissionModeName = string;
const MODE_NAMES: Record<string, string> = {
  default: '一般（改檔、執行指令要主人核准）',
  acceptEdits: '自動改檔（執行指令要主人核准）',
  plan: '計畫模式（只討論不動手）',
  dontAsk: '不詢問（改檔、執行指令一律拒絕）',
  auto: '自動（Claude Code 自動判斷，擋下的才問主人）',
};
const modeName = (m: PermissionModeName) => MODE_NAMES[m] ?? m;
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Pending menus and buttons from commands (model picker, resume list), kept 15 minutes. */
const menus = new Map<string, { conv: Conv; who: Who; candidates?: ResumeCandidate[]; at: number }>();
let seq = 0;
function remember(conv: Conv, who: Who, candidates?: ResumeCandidate[]): string {
  const now = Date.now();
  for (const [id, m] of menus) if (now - m.at > 15 * 60 * 1000) menus.delete(id);
  const id = `${now.toString(36)}${(++seq).toString(36)}`;
  menus.set(id, { conv, who, candidates, at: now });
  return id;
}

const say = (message: Message, content: string) => message.reply({ content, allowedMentions: { parse: [] } });

async function applyModel(c: Conv, model: string): Promise<string> {
  const ts = convState(c);
  ts.model = model;
  saveState();
  const s = liveSession(c.key);
  if (s?.usable) {
    try {
      await s.setModel(model);
    } catch (e) {
      log('command', `${c.key} setModel ${model} failed: ${(e as Error).message}`);
      return `⚠️ 已記下 **${model}**，但目前的 session 切換失敗，下一段對話開始生效。`;
    }
  }
  log('command', `${c.key} model -> ${model}${s?.usable ? ' (live)' : ''}`);
  return `🔁 模型已切換為 **${model}**，接下來的回應就用它。`;
}

async function statusText(c: Conv): Promise<string> {
  const ts = convState(c);
  const ch = effective(c, ts);
  const s = liveSession(c.key);
  const pin = pinGate.state();
  const lines = [
    `📊 **狀態**（${c.kind === 'dm' ? '私訊' : '這個討論串'}）`,
    `・工作目錄：\`${s?.cwd ?? ch.cwd}\``,
    `・模型：${ts.model ?? ch.model ?? 'Claude Code 預設'}${s?.model ? `（實際：${s.model}）` : ''}`,
    `・權限模式：${modeName(s?.mode ?? ch.permissionMode)}${ts.plan ? '，用 !plan 可切回' : ''}`,
    `・對話：${s?.usable ? `session 已開 ${duration(Date.now() - s.startedAt)}${s.busy ? '，正在工作' : '，閒置中'}` : ts.sessionId ? '已暫停（下一則訊息會接回）' : '還沒有對話'}`,
    ...(c.kind === 'dm' && (ts as DmState).source ? [`・來源：${(ts as DmState).source}`] : []),
    `・本段對話花費：約 $${ts.lastCostTotal.toFixed(2)}`,
    `・上下文：${ts.ctx ? `${ts.ctx.pct}%${ts.ctx.tokens && ts.ctx.max ? `（${k(ts.ctx.tokens)} / ${k(ts.ctx.max)} tokens）` : ''}` : '未知（跑過一輪後才知道）'}`,
    `・額度：${rateSummary(latestRateLimit())}`,
    `・PIN：${!pin.configured ? '未設定' : pin.locked ? '🔒 已鎖定' : pin.unlockedUntil ? `免輸入到 ${shortTime(pin.unlockedUntil)}` : '核准時要輸入'}`,
  ];
  return lines.join('\n');
}

/** Turn-shaped commands (!compact, !retry) queue behind whatever is running. */
async function queueTurn(c: Conv, message: Message, who: Who, prompt: string, kind: 'compact' | 'retry'): Promise<void> {
  const status = new StatusReactions(message);
  await status.set('received');
  const { queued } = enqueue(c.key, () => runTurn(c, message, status, who, { prompt, kind }));
  if (queued) await status.set('waiting');
}

function resumeCandidates(): ResumeCandidate[] {
  const config = loadConfig();
  const dmCwd = resolveDm(config)?.cwd ?? '';
  const out: ResumeCandidate[] = [];
  for (const d of dmHistory()) {
    if (!d.sessionId) continue;
    out.push({ kind: 'dm', id: d.sessionId, sessionId: d.sessionId, cwd: d.cwd ?? dmCwd, at: d.lastAt ?? d.createdAt, source: d.source ?? '私訊', summary: d.last ?? d.first ?? d.source ?? '' });
  }
  for (const [id, t] of allThreads()) {
    const cwd = config.channels[t.channelId]?.cwd;
    if (!t.sessionId || !cwd) continue;
    out.push({ kind: 'thread', id, sessionId: t.sessionId, cwd, at: t.lastAt ?? t.createdAt, source: t.name ?? `討論串 ${id}`, summary: t.last ?? t.first ?? t.name ?? '' });
  }
  return resumeList(out);
}

/** Run a command. Who may use it has been checked by the caller. */
export async function runCommand(cmd: Command, c: Conv, message: Message, who: Who): Promise<void> {
  const ts = convState(c);
  log('command', `${c.key} !${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''} by ${message.author.username}`);
  switch (cmd.name) {
    case 'help':
      await say(message, helpText(c.kind));
      return;
    case 'status':
      await say(message, await statusText(c));
      return;
    case 'stop': {
      const s = liveSession(c.key);
      if (s?.busy && (await s.interrupt(message.author.displayName || message.author.username))) await message.react('⏹️').catch(() => {});
      else await say(message, '目前沒有在執行的工作。');
      return;
    }
    case 'model': {
      if (cmd.arg) {
        const model = normalizeModel(cmd.arg);
        await say(message, model ? await applyModel(c, model) : `不認得「${cmd.arg}」。可以用 haiku、sonnet、opus。`);
        return;
      }
      const id = remember(c, who);
      const current = ts.model ?? effective(c, ts).model ?? 'Claude Code 預設';
      await message.reply({
        content: `目前的模型：**${current}**。要換成哪一個？`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...MODEL_CHOICES.map((m) => new ButtonBuilder().setCustomId(`ccmd:model:${id}:${m.alias}`).setLabel(`${m.label}（${m.note}）`).setStyle(m.alias === current ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }
    case 'plan': {
      const next = !ts.plan;
      const mode = next ? 'plan' : c.base.permissionMode;
      const s = liveSession(c.key);
      if (s?.usable) {
        try {
          await s.setMode(mode);
        } catch (e) {
          log('command', `${c.key} setMode ${mode} failed: ${(e as Error).message}`);
          await say(message, '⚠️ 切換失敗，模式沒有改變。');
          return;
        }
      }
      ts.plan = next || undefined;
      saveState();
      await say(message, next ? `📝 已切到計畫模式：Claude 只討論、不改檔也不執行指令。再打一次 !plan 切回（${modeName(c.base.permissionMode)}）。` : `▶️ 已切回${modeName(mode)}，Claude 可以動手了。`);
      return;
    }
    case 'compact':
      if (!ts.sessionId) return void (await say(message, '還沒有對話，不需要壓縮。'));
      await queueTurn(c, message, who, '/compact', 'compact');
      return;
    case 'retry':
      if (!ts.lastPrompt) return void (await say(message, '沒有可以重送的訊息。'));
      await queueTurn(c, message, who, ts.lastPrompt, 'retry');
      return;
    case 'clear': {
      if (liveSession(c.key)?.busy || isPending(c.key)) return void (await say(message, 'Claude 還在處理，先打 !stop 停下來，再打 !clear。'));
      await release(c.key, 'clear');
      switchDm();
      await say(message, '🆕 已結束目前的對話（之後可以用 !resume 接回）。下一則訊息會開新的對話。');
      return;
    }
    case 'resume': {
      const list = resumeCandidates();
      if (!list.length) return void (await say(message, '還沒有可以接回的對話。'));
      // Old threads saved before 0.1.5 have no name yet: ask Discord.
      for (const cand of list) {
        if (cand.kind !== 'thread' || getThread(cand.id)?.name) continue;
        const ch = await message.client.channels.fetch(cand.id).catch(() => null);
        if (ch && 'name' in ch && ch.name) {
          cand.source = ch.name;
          if (!cand.summary || cand.summary.startsWith('討論串 ')) cand.summary = ch.name;
          getThread(cand.id)!.name = ch.name;
        }
      }
      saveState();
      const id = remember(c, who, list);
      await message.reply({
        content: '要接回哪一段對話？（討論串的對話會複製一份分支來接，不影響討論串本身）',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`ccmd:resume:${id}`)
              .setPlaceholder('選一段對話')
              .addOptions(list.map((cand, n) => ({ ...resumeOption(cand), value: String(n) }))),
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }
  }
}

export function isCommandInteraction(i: Interaction): boolean {
  return (i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('ccmd:');
}

export async function handleCommandInteraction(i: Interaction): Promise<void> {
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  const [, what, id, arg] = i.customId.split(':');
  const m = menus.get(id);
  if (!m) {
    await i.reply({ content: '這個選單已經失效（超過 15 分鐘或 Bot 重啟過），請重打一次指令。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canAct('stop', i.user.id, m.who)) {
    await i.reply({ content: '只有 Bot 的主人或提出需求的人可以用這個選單。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (what === 'model' && i.isButton()) {
    menus.delete(id);
    const text = await applyModel(m.conv, arg);
    await i.update({ content: text, components: [] });
    return;
  }
  if (what === 'resume' && i.isStringSelectMenu()) {
    const pick = m.candidates?.[Number(i.values[0])];
    if (!pick) return;
    if (liveSession(DM_KEY)?.busy || isPending(DM_KEY)) {
      await i.reply({ content: 'Claude 還在處理，先打 !stop 停下來再接回。', flags: MessageFlags.Ephemeral });
      return;
    }
    menus.delete(id);
    // Closing the current session and forking can take longer than Discord's 3 seconds.
    await i.update({ content: '⏳ 接回中…', components: [] });
    try {
      const text = await resumeInto(i.client, pick);
      await i.editReply({ content: text });
    } catch (e) {
      log('error', `resume ${pick.sessionId}: ${(e as Error).stack ?? e}`);
      await i.editReply({ content: `❌ 接回失敗：${(e as Error).message.slice(0, 200)}` });
    }
  }
}

/**
 * Make `pick` the direct-message conversation. A DM session is resumed as is;
 * a thread's session is forked first (the thread keeps its own session) and
 * continues in that thread's working folder.
 */
async function resumeInto(_client: Client, pick: ResumeCandidate): Promise<string> {
  await release(DM_KEY, 'resume');
  if (pick.kind === 'dm') {
    const rec = dmHistory().find((h) => h.sessionId === pick.sessionId);
    switchDm(rec);
    log('command', `dm resumed ${pick.sessionId}`);
    return `↩️ 已接回 ${shortTime(pick.at)} 的私訊對話。下一則訊息會接著聊。`;
  }
  const t = getThread(pick.id);
  const fork = await forkSession(pick.sessionId, { dir: pick.cwd });
  const now = new Date().toISOString();
  switchDm({
    channelId: DM_KEY,
    sessionId: fork.sessionId,
    cwd: pick.cwd,
    source: `討論串「${pick.source}」的分支`,
    lastCostTotal: t?.lastCostTotal ?? 0,
    resumeCostBase: t?.resumeCostBase ?? t?.lastCostTotal ?? 0,
    createdAt: now,
    lastAt: now,
    first: `（接續討論串「${pick.source}」）`,
    ...(t?.model ? { model: t.model } : {}),
  });
  log('command', `dm forked thread ${pick.id} session ${pick.sessionId} -> ${fork.sessionId} cwd=${pick.cwd}`);
  return `↩️ 已從討論串「${pick.source}」複製一份對話接回（討論串本身不受影響）。工作目錄：\`${pick.cwd}\`。下一則訊息會接著聊。`;
}
