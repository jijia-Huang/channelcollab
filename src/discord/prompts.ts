/**
 * Prompts that wait for a person (PLAN §7, §8): permission requests (allow /
 * always allow / deny with an optional reason), AskUserQuestion, and the 🛑
 * stop button on a turn's progress message. Each prompt lives in memory until
 * answered, timed out or cancelled; after a restart old buttons say so.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { brief, log } from '../log.js';
import { canAct, type PromptKind } from '../runner/policy.js';
import type { PermissionAnswer, PermissionRequest, Question } from '../runner/session.js';

const OTHER = '__other';
const OTHER_LABEL = '其他…（自行輸入）';
const MAX_CONTENT = 1900;

export type Who = { ownerId?: string; requesterId?: string };

type Pending = {
  kind: PromptKind;
  who: Who;
  message?: Message;
  /** Text the prompt message started with; outcomes are appended to it. */
  base: string;
};

type PermissionPending = Pending & { kind: 'permission'; toolName: string; done: (a: PermissionAnswer, note: string) => void };
type QuestionPending = Pending & {
  kind: 'question';
  questions: Question[];
  answers: (string | undefined)[];
  done: (answers: Record<string, string> | undefined, note: string) => void;
};
type StopPending = Pending & { kind: 'stop'; stop: (by: string) => void };

const pending = new Map<string, PermissionPending | QuestionPending | StopPending>();
let seq = 0;
const newId = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

const fence = (s: string, lang = '') => `\`\`\`${lang}\n${s.replace(/```/g, "'''")}\n\`\`\``;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

function clipLines(s: string, maxLines: number, maxChars: number): string {
  const lines = s.split('\n');
  const head = lines.slice(0, maxLines).join('\n');
  const more = lines.length > maxLines ? `\n…（還有 ${lines.length - maxLines} 行）` : '';
  return clip(head, maxChars) + more;
}

/** A short, readable picture of what the tool is about to do. */
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (name === 'Bash' || name === 'PowerShell') {
    const desc = str('description');
    return `${desc ? `${clip(desc, 200)}\n` : ''}${fence(clipLines(str('command'), 20, 900), name === 'Bash' ? 'sh' : 'powershell')}`;
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'Edit' ? [{ old_string: str('old_string'), new_string: str('new_string') }] : ((input.edits as { old_string: string; new_string: string }[]) ?? []);
    const diff = edits
      .slice(0, 3)
      .map((e) => [...clipLines(e.old_string, 8, 400).split('\n').map((l) => `- ${l}`), ...clipLines(e.new_string, 8, 400).split('\n').map((l) => `+ ${l}`)].join('\n'))
      .join('\n…\n');
    return `\`${str('file_path')}\`${edits.length > 3 ? `（共 ${edits.length} 處，只列前 3 處）` : ''}\n${fence(diff, 'diff')}`;
  }
  if (name === 'Write') {
    const content = str('content');
    return `\`${str('file_path')}\`（${content.split('\n').length} 行）\n${fence(clipLines(content, 10, 600))}`;
  }
  const p = str('file_path') || str('notebook_path') || str('path');
  if (p) return `\`${p}\``;
  if (name === 'WebFetch') return `${str('url')}`;
  return fence(brief(input, 600));
}

function rows(...builders: (ButtonBuilder | StringSelectMenuBuilder)[][]) {
  return builders.map((b) => new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(...b));
}

async function edit(p: Pending, extra: string, keepComponents = false): Promise<void> {
  const content = clip(`${p.base}\n${extra}`, MAX_CONTENT);
  await p.message?.edit({ content, ...(keepComponents ? {} : { components: [] }), allowedMentions: { parse: [] } }).catch((e) => log('prompt', `edit failed: ${(e as Error).message}`));
}

/**
 * Settle a prompt once: whatever comes first (a click, the timeout, the turn
 * being stopped) wins; later clicks are told it is already settled.
 */
function settleOnce<T>(id: string, entry: PermissionPending | QuestionPending, timeoutMs: number, signal: AbortSignal, onTimeout: () => T, onAbort: () => T) {
  pending.set(id, entry);
  let finish!: (v: T) => void;
  const result = new Promise<T>((r) => (finish = r));
  let settled = false;
  const timer = setTimeout(() => settle(onTimeout()), timeoutMs);
  const abort = () => settle(onAbort());
  signal.addEventListener('abort', abort, { once: true });
  function settle(v: T) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    pending.delete(id);
    finish(v);
  }
  if (signal.aborted) abort();
  return { result, settle };
}

const minutes = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分鐘`);

/** Post a permission request with allow / always / deny buttons and wait for the owner. */
export async function askPermission(thread: AnyThreadChannel, req: PermissionRequest, who: Who, timeoutMs: number): Promise<PermissionAnswer> {
  const id = newId();
  if (!who.ownerId) {
    await thread.send({ content: `🔐 Claude 想執行 \`${req.toolName}\`，但這個 Bot 沒有設定主人（config 的 \`discord.owner_id\`），無法核准，已拒絕。`, allowedMentions: { parse: [] } });
    return { behavior: 'deny', message: '這個 Bot 沒有設定主人，沒有人能核准權限請求，已拒絕。' };
  }
  const base = `🔐 **權限請求** \`${req.toolName}\`　<@${who.ownerId}> 請確認（${minutes(timeoutMs)}內沒有回應會自動拒絕）\n${summarizeTool(req.toolName, req.input)}`;
  const p: PermissionPending = { kind: 'permission', who, base: clip(base, MAX_CONTENT - 200), toolName: req.toolName, done: () => {} };
  const s = settleOnce<{ a: PermissionAnswer; note: string }>(
    id,
    p,
    timeoutMs,
    req.signal,
    () => ({ a: { behavior: 'deny', message: `等待主人核准逾時（${minutes(timeoutMs)}），已自動拒絕。` }, note: `⌛ 逾時（${minutes(timeoutMs)}），已自動拒絕` }),
    () => ({ a: { behavior: 'deny', message: '這一輪已停止，請求已取消。' }, note: '⏹️ 這一輪已停止，請求已取消' }),
  );
  p.done = (a, note) => s.settle({ a, note });
  p.message = await thread.send({
    content: p.base,
    components: rows([
      new ButtonBuilder().setCustomId(`perm:${id}:allow`).setLabel('允許').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:${id}:always`).setLabel(clip(`這個 session 一律允許 ${req.toolName}`, 80)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`perm:${id}:deny`).setLabel('拒絕').setStyle(ButtonStyle.Danger),
    ]),
    allowedMentions: { users: [who.ownerId] },
  });
  log('prompt', `permission ${id} posted ${req.toolName} tool_use=${req.toolUseId} message=${p.message.id}`);
  const { a, note } = await s.result;
  log('prompt', `permission ${id} ${a.behavior} ${req.toolName} tool_use=${req.toolUseId} (${note})`);
  await edit(p, note);
  return a;
}

function questionText(q: QuestionPending): string {
  const parts = q.questions.map((x, i) => {
    const opts = x.options.map((o, j) => `　${j + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ''}`).join('\n');
    const answer = q.answers[i] !== undefined ? `\n　→ **${q.answers[i]}**` : '';
    return `**${x.header || `問題 ${i + 1}`}**${x.multiSelect ? '（可複選）' : ''}：${x.question}\n${opts}${answer}`;
  });
  return parts.join('\n\n');
}

function questionMenus(id: string, q: QuestionPending) {
  return q.questions.map((x, i) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ask:${id}:${i}`)
        .setPlaceholder(clip(q.answers[i] !== undefined ? `已選：${q.answers[i]}` : `${x.header || `問題 ${i + 1}`}：請選擇`, 150))
        .setMinValues(1)
        .setMaxValues(x.multiSelect ? x.options.length + 1 : 1)
        .addOptions(
          ...x.options.map((o, j) => ({ label: clip(o.label, 100), value: String(j), ...(o.description ? { description: clip(o.description, 100) } : {}) })),
          { label: OTHER_LABEL, value: OTHER },
        ),
    ),
  );
}

/** Post AskUserQuestion as select menus (multi-select where asked, plus "其他…") and wait for the requester or the owner. */
export async function askQuestion(thread: AnyThreadChannel, questions: Question[], who: Who, timeoutMs: number, signal: AbortSignal): Promise<Record<string, string> | undefined> {
  const id = newId();
  const q: QuestionPending = { kind: 'question', who, base: '', questions: questions.slice(0, 5), answers: [], done: () => {} };
  const header = () => `❓ **Claude 想問**（${[who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`).join(' 或 ')} 回答；${minutes(timeoutMs)}內沒有回應就略過）`;
  q.base = clip(`${header()}\n\n${questionText(q)}`, MAX_CONTENT - 100);
  const s = settleOnce<{ answers?: Record<string, string>; note: string }>(
    id,
    q,
    timeoutMs,
    signal,
    () => ({ note: `⌛ 逾時（${minutes(timeoutMs)}），沒有回答` }),
    () => ({ note: '⏹️ 已取消' }),
  );
  q.done = (answers, note) => s.settle({ answers, note });
  q.message = await thread.send({ content: q.base, components: questionMenus(id, q), allowedMentions: { users: who.requesterId ? [who.requesterId] : [] } });
  log('prompt', `question ${id} posted ${questions.length} question(s) message=${q.message.id}`);
  const { answers, note } = await s.result;
  log('prompt', `question ${id} ${answers ? `answered ${brief(answers)}` : note}`);
  q.base = clip(`${header()}\n\n${questionText(q)}`, MAX_CONTENT - 100);
  await edit(q, note);
  return answers;
}

/** Record one question's answer; settle once every question has one. */
async function answerQuestion(i: StringSelectMenuInteraction | ModalSubmitInteraction, id: string, q: QuestionPending, index: number, answer: string): Promise<void> {
  q.answers[index] = answer;
  const complete = q.questions.every((_, j) => q.answers[j] !== undefined);
  const content = clip(`${q.base.split('\n\n')[0]}\n\n${questionText(q)}`, MAX_CONTENT);
  const by = `✅ 由 <@${i.user.id}> 回答`;
  if (i.isStringSelectMenu() || i.isFromMessage()) await i.update({ content: complete ? `${content}\n${by}` : content, components: complete ? [] : questionMenus(id, q), allowedMentions: { parse: [] } });
  else await i.reply({ content: '已記錄。', flags: MessageFlags.Ephemeral });
  if (complete) {
    const answers = Object.fromEntries(q.questions.map((x, j) => [x.question, q.answers[j]!]));
    q.base = content;
    q.message = undefined; // already updated through the interaction
    q.done(answers, by);
  }
}

/**
 * A turn's progress message with 🛑. Posted only if the turn is still running
 * after `delayMs`, so quick turns add nothing to the thread. Returns the
 * handle the caller uses to take the message over when the turn ends.
 */
export function stopControl(thread: AnyThreadChannel, who: Who, delayMs: number, stop: (by: string) => void) {
  const id = newId();
  const p: StopPending = { kind: 'stop', who, base: '⚙️ 處理中…', stop };
  let posting: Promise<Message | undefined> | undefined;
  const timer = setTimeout(() => {
    pending.set(id, p);
    posting = thread
      .send({
        content: `${p.base}（主人或提出需求的人可以按 🛑 停止）`,
        components: rows([new ButtonBuilder().setCustomId(`stop:${id}`).setLabel('停止').setEmoji('🛑').setStyle(ButtonStyle.Danger)]),
        allowedMentions: { parse: [] },
      })
      .then((m) => (p.message = m))
      .catch((e) => {
        log('prompt', `stop control failed: ${(e as Error).message}`);
        return undefined;
      });
  }, delayMs);
  return {
    /** Turn over: no more stopping. Resolves to the progress message, if one was posted. */
    async end(): Promise<Message | undefined> {
      clearTimeout(timer);
      pending.delete(id);
      return posting ? await posting : undefined;
    },
  };
}

function denyText(kind: PromptKind, who: Who): string {
  if (kind === 'permission') return '只有 Bot 擁有者可以核准。';
  const names = [who.requesterId, who.ownerId].filter((v, i, a) => v && a.indexOf(v) === i).map((u) => `<@${u}>`);
  return `只有 ${names.join(' 或 ')} 可以${kind === 'stop' ? '停止這一輪' : '回答'}。`;
}

/** Common checks: the prompt still exists and the clicker may act on it. */
async function lookup(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, id: string) {
  const p = pending.get(id);
  if (!p) {
    await i.reply({ content: '這個請求已經處理過，或已失效（例如 Bot 重啟過）。', flags: MessageFlags.Ephemeral });
    return undefined;
  }
  if (!canAct(p.kind, i.user.id, p.who)) {
    log('prompt', `${p.kind} ${id} refused ${i.user.username} (${i.user.id})`);
    await i.reply({ content: denyText(p.kind, p.who), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return undefined;
  }
  return p;
}

export function isPromptInteraction(i: Interaction): boolean {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return false;
  return /^(perm|permdeny|ask|askother|stop):/.test(i.customId);
}

export async function handlePromptInteraction(i: Interaction): Promise<void> {
  if (i.isButton() && i.customId.startsWith('perm:')) {
    const [, id, action] = i.customId.split(':');
    const p = await lookup(i, id);
    if (!p || p.kind !== 'permission') return;
    log('prompt', `permission ${id} ${action} clicked by ${i.user.username}`);
    if (action === 'deny') {
      // showModal must be the first response to the click.
      await i.showModal(
        new ModalBuilder()
          .setCustomId(`permdeny:${id}`)
          .setTitle(clip(`拒絕 ${p.toolName}`, 45))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId('reason').setLabel('拒絕理由（選填，會轉告 Claude）').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000),
            ),
          ),
      );
      return;
    }
    const note = action === 'always' ? `✅ <@${i.user.id}> 已允許，這個 session 之後的 \`${p.toolName}\` 不再詢問` : `✅ <@${i.user.id}> 已允許`;
    await i.update({ content: clip(`${p.base}\n${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
    p.message = undefined;
    p.done({ behavior: action === 'always' ? 'always' : 'allow' }, note);
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith('permdeny:')) {
    const id = i.customId.split(':')[1];
    const p = await lookup(i, id);
    if (!p || p.kind !== 'permission') return;
    const reason = i.fields.getTextInputValue('reason').trim();
    const note = `🚫 <@${i.user.id}> 已拒絕${reason ? `：${clip(reason, 300)}` : ''}`;
    if (i.isFromMessage()) {
      await i.update({ content: clip(`${p.base}\n${note}`, MAX_CONTENT), components: [], allowedMentions: { parse: [] } });
      p.message = undefined;
    } else await i.deferUpdate();
    log('prompt', `permission ${id} denied by ${i.user.username} reason=${brief(reason, 200)}`);
    p.done({ behavior: 'deny', message: reason ? `主人拒絕了這次的 ${p.toolName}，理由：${reason}` : `主人拒絕了這次的 ${p.toolName}（沒有說明理由）。` }, note);
    return;
  }
  if (i.isStringSelectMenu() && i.customId.startsWith('ask:')) {
    const [, id, idx] = i.customId.split(':');
    const p = await lookup(i, id);
    if (!p || p.kind !== 'question') return;
    const index = Number(idx);
    const x = p.questions[index];
    const picked = i.values.filter((v) => v !== OTHER).map((v) => x.options[Number(v)]?.label ?? v);
    log('prompt', `question ${id} q${index} picked ${JSON.stringify(i.values)} by ${i.user.username}`);
    if (i.values.includes(OTHER)) {
      await i.showModal(
        new ModalBuilder()
          .setCustomId(`askother:${id}:${index}:${i.values.filter((v) => v !== OTHER).join(',')}`)
          .setTitle(clip(x.header || '其他', 45))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId('answer').setLabel(clip(x.question, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
            ),
          ),
      );
      return;
    }
    await answerQuestion(i, id, p, index, picked.join(', '));
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith('askother:')) {
    const [, id, idx, chosen] = i.customId.split(':');
    const p = await lookup(i, id);
    if (!p || p.kind !== 'question') return;
    const index = Number(idx);
    const x = p.questions[index];
    const picked = (chosen ? chosen.split(',') : []).map((v) => x.options[Number(v)]?.label ?? v);
    const text = i.fields.getTextInputValue('answer').trim();
    log('prompt', `question ${id} q${index} other=${brief(text, 200)} by ${i.user.username}`);
    await answerQuestion(i, id, p, index, [...picked, text].filter(Boolean).join(', '));
    return;
  }
  if (i.isButton() && i.customId.startsWith('stop:')) {
    const id = i.customId.split(':')[1];
    const p = await lookup(i, id);
    if (!p || p.kind !== 'stop') return;
    log('prompt', `stop ${id} clicked by ${i.user.username}`);
    pending.delete(id);
    await i.update({ content: `⏹️ <@${i.user.id}> 按了停止，正在停止…`, components: [], allowedMentions: { parse: [] } });
    p.stop(i.user.displayName || i.user.username);
  }
}
