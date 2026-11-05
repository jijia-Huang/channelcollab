/**
 * Running `!` and `/` commands (parsing and the rules are in commands.ts; the
 * slash side is slash.ts). Both come here through runCommand with a CommandIO.
 * Commands that act right away (stop, model, plan, status, help, clear,
 * resume) never wait in the conversation's queue; compact, retry and skill
 * are turns and queue like any message.
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
import { brief, log } from '../log.js';
import { enqueue, isPending } from '../router/queue.js';
import { canAct } from '../runner/policy.js';
import { liveSession, release } from '../runner/pool.js';
import { NO_LIST_TEXT, skillPrompt, type SkillItem } from '../runner/skills.js';
import { limitLabel } from '../runner/turn-clock.js';
import { latestRateLimit, rateSummary } from '../runner/usage.js';
import { pinGate } from '../security/pin.js';
import { allThreads, DM_KEY, dmHistory, getThread, saveState, skillsFor, switchDm, type DmState } from '../store/state.js';
import { duration, EFFORT_CHOICES, helpText, MODEL_CHOICES, normalizeEffort, normalizeModel, resumeList, resumeOption, shortTime, type Command, type ResumeCandidate } from './commands.js';
import { convState, effective, runTurn, type Conv } from './conversation.js';
import type { Who } from './prompts.js';
import { StatusReactions } from './status.js';
import { giveBack } from './takeover.js';

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
/** `slash`: the menu was an ephemeral answer, so the choice also gets a public note in the conversation. */
const menus = new Map<string, { conv: Conv; who: Who; slash: boolean; candidates?: ResumeCandidate[]; at: number }>();
let seq = 0;
function remember(conv: Conv, who: Who, slash: boolean, candidates?: ResumeCandidate[]): string {
  const now = Date.now();
  for (const [id, m] of menus) if (now - m.at > 15 * 60 * 1000) menus.delete(id);
  const id = `${now.toString(36)}${(++seq).toString(36)}`;
  menus.set(id, { conv, who, slash, candidates, at: now });
  return id;
}

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

/**
 * !effort: remembered for the conversation (a resume keeps it) and switched in the live session right
 * away (applyFlagSettings, spike/v017-sdk.ts). If the switch fails, the process is closed when idle so
 * the next message resumes with the new level.
 */
async function applyEffort(c: Conv, level: string | null): Promise<string> {
  const ts = convState(c);
  ts.effort = level ?? undefined;
  saveState();
  const shown = level ?? `預設${effective(c, ts).effort ? `（綁定的 ${effective(c, ts).effort}）` : ''}`;
  const s = liveSession(c.key);
  if (s?.usable) {
    try {
      // Back to the default: the binding's level if it has one, else the model's.
      await s.setEffort(level ?? effective(c, ts).effort ?? null);
    } catch (e) {
      log('command', `${c.key} setEffort ${level} failed: ${(e as Error).message}`);
      if (!s.busy && !isPending(c.key)) await release(c.key, 'effort');
      return `⚠️ 已記下努力程度 **${shown}**，但目前的 session 沒辦法直接切換，下一則訊息開始生效。`;
    }
  }
  log('command', `${c.key} effort -> ${level ?? 'default'}${s?.usable ? ' (live)' : ''}`);
  return `🧠 努力程度已設為 **${shown}**，接下來的回應就用它。`;
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
    `・努力程度：${ts.effort ?? ch.effort ?? 'Claude Code 預設'}${s?.effortActual ? `（實際：${s.effortActual}）` : ''}`,
    `・權限模式：${modeName(s?.mode ?? ch.permissionMode)}${ts.plan ? '，用 !plan 可切回' : ''}`,
    `・對話：${s?.usable ? `session 已開 ${duration(Date.now() - s.startedAt)}${s.busy ? '，正在工作' : '，閒置中'}` : ts.sessionId ? '已暫停（下一則訊息會接回）' : '還沒有對話'}`,
    ...((ts as DmState).source ? [`・來源：${(ts as DmState).source}`] : []),
    ...(ts.takeover ? [`・🖥️ 主人在電腦上接手中（${shortTime(ts.takeover.at)} 起，記下 ${ts.takeover.queued.length} 則訊息）；電腦上用 /channelcollab:release 交還，或在這裡用 /takeback 強制接回`] : []),
    `・單輪工作上限：${ch.turnTimeoutMs ? `${limitLabel(ch.turnTimeoutMs)}（等人按按鈕的時間不算）` : '不限（要停止請按 🛑 或用 /stop）'}`,
    `・單輪步數上限：${ch.maxTurns ? `${ch.maxTurns} 步` : '不限'}`,
    `・本段對話花費：約 $${ts.lastCostTotal.toFixed(2)}`,
    `・上下文：${ts.ctx ? `${ts.ctx.pct}%${ts.ctx.tokens && ts.ctx.max ? `（${k(ts.ctx.tokens)} / ${k(ts.ctx.max)} tokens）` : ''}` : '未知（跑過一輪後才知道）'}`,
    `・額度：${rateSummary(latestRateLimit())}`,
    `・PIN：${!pin.configured ? '未設定' : pin.locked ? '🔒 已鎖定' : pin.unlockedUntil ? `免輸入到 ${shortTime(pin.unlockedUntil)}` : '核准時要輸入'}`,
  ];
  return lines.join('\n');
}

/**
 * Where a command came from and how to answer it. A `!` message and a slash
 * command each have one (messageIO here, slash.ts); runCommand only talks to this.
 */
export type CommandIO = {
  /** Who used the command. */
  actor: { id: string; name: string };
  client: Client;
  /** A slash command; else a `!` message. */
  slash: boolean;
  /** An answer only the person who used it needs (ephemeral for slash; a reply for `!`). */
  tell(content: string, components?: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]): Promise<void>;
  /** A short public note in the conversation (the command changed something). */
  note(content: string): Promise<void>;
  /** A `!` message gets the reaction; a slash command, the note. */
  ack(emoji: string, content: string): Promise<void>;
  /** The message that carries the status reactions of a queued turn (the `!` message, or a public note). */
  anchor(content: string): Promise<Message>;
};

/** Turn-shaped commands (!compact, !retry, !skill) queue behind whatever is running. */
async function queueTurn(c: Conv, io: CommandIO, who: Who, prompt: string, kind: 'compact' | 'retry' | 'skill', label: string): Promise<void> {
  const trigger = await io.anchor(label);
  const status = new StatusReactions(trigger);
  await status.set('received');
  const { queued } = enqueue(c.key, () => runTurn(c, trigger, status, who, { prompt, kind }));
  if (queued) await status.set('waiting');
}

/** `!skill` with no name: what can be run here. */
function skillListText(list: SkillItem[] | undefined, slash: boolean): string {
  if (!list?.length) return `${NO_LIST_TEXT}。`;
  const shown = list.slice(0, 40).map((s) => `\`${s.name}\`${s.hint ? ` ${s.hint}` : ''}${s.description ? `　${s.description.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`);
  const more = list.length > shown.length ? `\n…還有 ${list.length - shown.length} 個` : '';
  return `**可以用的 skill／自訂指令**（${slash ? '`/skill` 選名稱' : '`!skill <名稱> [參數]`'}）\n${shown.join('\n')}${more}`;
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
    const cwd = config.channels[t.channelId] ? (t.cwd ?? config.channels[t.channelId].cwd) : undefined;
    if (!t.sessionId || !cwd) continue;
    out.push({ kind: 'thread', id, sessionId: t.sessionId, cwd, at: t.lastAt ?? t.createdAt, source: t.name ?? `討論串 ${id}`, summary: t.last ?? t.first ?? t.name ?? '' });
  }
  return resumeList(out);
}

/** Run a command (`!` or `/`). Who may use it has been checked by the caller (commandGate). */
export async function runCommand(cmd: Command, c: Conv, io: CommandIO, who: Who): Promise<void> {
  const ts = convState(c);
  const p = io.slash ? '/' : '!';
  log('command', `${c.key} ${p}${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''}${cmd.rest ? ` ${brief(cmd.rest, 80)}` : ''} by ${io.actor.name}`);
  switch (cmd.name) {
    case 'help':
      await io.tell(helpText(c.kind));
      return;
    case 'status':
      await io.tell(await statusText(c));
      return;
    case 'stop': {
      const s = liveSession(c.key);
      if (s?.busy && (await s.interrupt(io.actor.name))) await io.ack('⏹️', `⏹️ ${io.actor.name} 停止了這一輪。`);
      else await io.tell('目前沒有在執行的工作。');
      return;
    }
    case 'model': {
      if (cmd.arg) {
        const model = normalizeModel(cmd.arg);
        if (model) await io.note(await applyModel(c, model));
        else await io.tell(`不認得「${cmd.arg}」。可以用 haiku、sonnet、opus。`);
        return;
      }
      const id = remember(c, who, io.slash);
      const current = ts.model ?? effective(c, ts).model ?? 'Claude Code 預設';
      await io.tell(`目前的模型：**${current}**。要換成哪一個？`, [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...MODEL_CHOICES.map((m) => new ButtonBuilder().setCustomId(`ccmd:model:${id}:${m.alias}`).setLabel(`${m.label}（${m.note}）`).setStyle(m.alias === current ? ButtonStyle.Primary : ButtonStyle.Secondary)),
        ),
      ]);
      return;
    }
    case 'effort': {
      if (cmd.arg) {
        const level = normalizeEffort(cmd.arg);
        if (level !== undefined) await io.note(await applyEffort(c, level));
        else await io.tell(`不認得「${cmd.arg}」。可以用 ${EFFORT_CHOICES.map((e) => e.level).join('、')}，或 default 回到預設。`);
        return;
      }
      const id = remember(c, who, io.slash);
      const current = ts.effort ?? effective(c, ts).effort;
      const rows = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...EFFORT_CHOICES.map((e) => new ButtonBuilder().setCustomId(`ccmd:effort:${id}:${e.level}`).setLabel(`${e.label}（${e.note}）`).setStyle(e.level === current ? ButtonStyle.Primary : ButtonStyle.Secondary)),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`ccmd:effort:${id}:default`).setLabel('回到預設').setStyle(current ? ButtonStyle.Secondary : ButtonStyle.Primary)),
      ];
      await io.tell(`目前的努力程度：**${current ?? 'Claude Code 預設'}**。要換成哪一個？`, rows);
      return;
    }
    case 'takeback': {
      if (!ts.takeover) return void (await io.tell('這段對話沒有在電腦上接手中，不需要接回。'));
      const r = await giveBack(io.client as Client<true>, c.key, { forced: true, by: io.actor.name });
      if (!r.ok) await io.tell(`❌ 接回失敗：${r.error}`);
      // giveBack posts the public note itself (with the reminder to close the computer's conversation).
      else if (io.slash) await io.tell('✅ 已接回。');
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
          await io.tell('⚠️ 切換失敗，模式沒有改變。');
          return;
        }
      }
      ts.plan = next || undefined;
      saveState();
      await io.note(next ? `📝 已切到計畫模式：Claude 只討論、不改檔也不執行指令。再用一次 ${p}plan 切回（${modeName(c.base.permissionMode)}）。` : `▶️ 已切回${modeName(mode)}，Claude 可以動手了。`);
      return;
    }
    case 'compact':
      if (!ts.sessionId) return void (await io.tell('還沒有對話，不需要壓縮。'));
      await queueTurn(c, io, who, '/compact', 'compact', `🗜️ ${io.actor.name} 要求壓縮上下文。`);
      return;
    case 'retry':
      if (!ts.lastPrompt) return void (await io.tell('沒有可以重送的訊息。'));
      await queueTurn(c, io, who, ts.lastPrompt, 'retry', `🔁 ${io.actor.name} 要求把上一則訊息重送一次。`);
      return;
    case 'skill': {
      const list = skillsFor(effective(c, ts).cwd);
      if (!cmd.arg) return void (await io.tell(skillListText(list, io.slash)));
      const r = skillPrompt(list, cmd.arg, cmd.rest);
      if (!r.ok) {
        log('command', `${c.key} ${p}skill ${brief(cmd.arg, 60)} refused (${r.reason})`);
        await io.tell(r.reason === 'no-list' ? `${NO_LIST_TEXT}。` : `沒有叫「${cmd.arg.slice(0, 60)}」的 skill。${io.slash ? '請從選單選一個。' : '打 `!skill` 看清單。'}`);
        return;
      }
      ts.lastPrompt = r.prompt;
      saveState();
      await queueTurn(c, io, who, r.prompt, 'skill', `🧩 ${io.actor.name} 執行 \`${r.prompt.slice(0, 200)}\``);
      return;
    }
    case 'clear': {
      if (ts.takeover) return void (await io.tell(`🖥️ 這段對話正在電腦上接手中。先在電腦上交還（/channelcollab:release），或用 ${p}takeback 接回，再用 ${p}clear。`));
      if (liveSession(c.key)?.busy || isPending(c.key)) return void (await io.tell(`Claude 還在處理，先用 ${p}stop 停下來，再用 ${p}clear。`));
      await release(c.key, 'clear');
      switchDm();
      await io.note(`🆕 已結束目前的對話（之後可以用 ${p}resume 接回）。下一則訊息會開新的對話。`);
      return;
    }
    case 'resume': {
      if (ts.takeover) return void (await io.tell(`🖥️ 目前的私訊對話正在電腦上接手中。先交還或用 ${p}takeback 接回，再接回別的對話。`));
      const list = resumeCandidates();
      if (!list.length) return void (await io.tell('還沒有可以接回的對話。'));
      // Old threads saved before 0.1.5 have no name yet: ask Discord.
      for (const cand of list) {
        if (cand.kind !== 'thread' || getThread(cand.id)?.name) continue;
        const ch = await io.client.channels.fetch(cand.id).catch(() => null);
        if (ch && 'name' in ch && ch.name) {
          cand.source = ch.name;
          if (!cand.summary || cand.summary.startsWith('討論串 ')) cand.summary = ch.name;
          getThread(cand.id)!.name = ch.name;
        }
      }
      saveState();
      const id = remember(c, who, io.slash, list);
      await io.tell('要接回哪一段對話？（討論串的對話會複製一份分支來接，不影響討論串本身）', [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ccmd:resume:${id}`)
            .setPlaceholder('選一段對話')
            .addOptions(list.map((cand, n) => ({ ...resumeOption(cand), value: String(n) }))),
        ),
      ]);
      return;
    }
  }
}

/** The `!` side: every answer is a reply to the message, as before 0.1.6. */
export function messageIO(message: Message): CommandIO {
  const reply = async (content: string, components?: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]) => {
    await message.reply({ content, ...(components ? { components } : {}), allowedMentions: { parse: [] } });
  };
  return {
    actor: { id: message.author.id, name: message.author.displayName || message.author.username },
    client: message.client,
    slash: false,
    tell: reply,
    note: reply,
    ack: async (emoji) => void (await message.react(emoji).catch(() => {})),
    anchor: async () => message,
  };
}

/** A public line in the conversation after a choice made in an ephemeral menu. */
async function publicNote(c: Conv, content: string): Promise<void> {
  await c.room.send({ content, allowedMentions: { parse: [] } }).catch((e) => log('command', `${c.key} note failed: ${(e as Error).message}`));
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
    if (m.slash) await publicNote(m.conv, `${text}（${i.user.displayName || i.user.username}）`);
    return;
  }
  if (what === 'effort' && i.isButton()) {
    menus.delete(id);
    const text = await applyEffort(m.conv, normalizeEffort(arg) ?? null);
    await i.update({ content: text, components: [] });
    if (m.slash) await publicNote(m.conv, `${text}（${i.user.displayName || i.user.username}）`);
    return;
  }
  if (what === 'resume' && i.isStringSelectMenu()) {
    const pick = m.candidates?.[Number(i.values[0])];
    if (!pick) return;
    if (liveSession(DM_KEY)?.busy || isPending(DM_KEY)) {
      await i.reply({ content: 'Claude 還在處理，先用 /stop（或 !stop）停下來再接回。', flags: MessageFlags.Ephemeral });
      return;
    }
    menus.delete(id);
    // Closing the current session and forking can take longer than Discord's 3 seconds.
    await i.update({ content: '⏳ 接回中…', components: [] });
    try {
      const text = await resumeInto(i.client, pick);
      await i.editReply({ content: text });
      if (m.slash) await publicNote(m.conv, text);
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
