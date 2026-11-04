/**
 * One conversation with Claude: a thread, or the direct message with the
 * owner. Both run the same way (PLAN §6, §7): one live session, turns queued,
 * status reactions, replies split for Discord, permission and question
 * prompts, 🛑, a details button, and the context / plan usage reminders.
 */
import path from 'node:path';
import type { AnyThreadChannel, Client, Message } from 'discord.js';
import { loadConfig, resolveChannel, resolveDm, type ResolvedChannel } from '../config.js';
import { brief, log } from '../log.js';
import { deferItem, type DeferredItem } from '../runner/approvals.js';
import { explainFailure } from '../runner/failure.js';
import { acquire } from '../runner/pool.js';
import type { LiveSession } from '../runner/session.js';
import { contextAlert, contextFooter, contextNotice } from '../runner/usage.js';
import { botOwner } from '../roster.js';
import { DM_KEY, getConversation, getDm, getThread, saveState, type DmState, type ThreadState } from '../store/state.js';
import { sendApprovalBatch } from './approvals-ui.js';
import { saveAttachments } from './attachments.js';
import { splitReply } from './commands.js';
import { attachDetails, rememberTurn } from './details.js';
import { buildDmPrompt, buildPrompt } from './prompt.js';
import { askPermission, askQuestion, stopControl, type Room, type Who } from './prompts.js';
import type { StatusReactions } from './status.js';

const FALLBACK_MAX = 500;
/** A turn still running after this long gets a progress message with 🛑. */
const STOP_BUTTON_DELAY_MS = 5000;

export type Conv = {
  /** Thread ID, or DM_KEY: the key in the session pool, the queue and the inbox. */
  key: string;
  kind: 'thread' | 'dm';
  room: Room;
  /** The binding (channel, or the dm block) with defaults applied. */
  base: ResolvedChannel;
  /** This bot's Discord user ID. */
  selfId: string;
};

/** The conversation's state now (a direct message's can be swapped by !clear / !resume). */
export function convState(c: Conv): ThreadState {
  return c.kind === 'dm' ? getDm() : getConversation(c.key)!;
}

/** The binding with this conversation's own choices applied: !model, !plan, and a resumed thread's folder. */
export function effective(c: Conv, ts: ThreadState = convState(c)): ResolvedChannel {
  const cwd = c.kind === 'dm' ? ((ts as DmState).cwd ?? c.base.cwd) : c.base.cwd;
  return { ...c.base, cwd, model: ts.model ?? c.base.model, permissionMode: ts.plan ? 'plan' : c.base.permissionMode, basePermissionMode: c.base.permissionMode };
}

/** Who triggered the turn running in each conversation (thread commands follow the 🛑 rule). */
export const running = new Map<string, Who>();

export type TurnKind = 'normal' | 'compact' | 'retry' | 'approved' | 'skill';

/** Rebuild a conversation from its key (to continue it after a later approval). */
export async function convFor(client: Client<true>, key: string): Promise<Conv | undefined> {
  const config = loadConfig();
  if (key === DM_KEY) {
    const base = resolveDm(config);
    const owner = botOwner(config.discord.owner_id, client.user.id);
    if (!base || !owner) return undefined;
    const room = await (await client.users.fetch(owner)).createDM();
    return { key, kind: 'dm', room, base, selfId: client.user.id };
  }
  const ts = getThread(key);
  const base = ts && resolveChannel(config, ts.channelId);
  const room = base ? await client.channels.fetch(key).catch(() => null) : null;
  if (!base || !room?.isThread()) return undefined;
  return { key, kind: 'thread', room, base, selfId: client.user.id };
}

/** Context use after the turn; a one-time notice at 70% and 95% (see runner/usage.ts). */
async function checkContext(c: Conv, session: LiveSession, ts: ThreadState): Promise<number | undefined> {
  const u = await session.contextUsage().catch(() => undefined);
  if (!u) return undefined;
  ts.ctx = { pct: u.pct, ...(u.tokens !== undefined ? { tokens: u.tokens } : {}), ...(u.max !== undefined ? { max: u.max } : {}), at: new Date().toISOString() };
  const alert = contextAlert(u.pct, ts.ctxNotified ?? []);
  ts.ctxNotified = alert.notified;
  saveState();
  log('context', `${c.key} ${u.pct}% (${u.tokens ?? '?'}/${u.max ?? '?'})${alert.notify ? ` notify ${alert.notify}%` : ''}`);
  if (alert.notify) await c.room.send({ content: contextNotice(u.pct, c.kind), allowedMentions: { parse: [] } }).catch((e) => log('error', `context notice ${c.key}: ${(e as Error).message}`));
  return u.pct;
}

/**
 * Run one turn. `prompt` replaces the prompt built from `trigger` (!compact
 * sends "/compact", !retry the last prompt, !skill "/<name> <args>");
 * `trigger` still gets the status reactions (for a slash command it is the
 * bot's own public note).
 */
export async function runTurn(c: Conv, trigger: Message, status: StatusReactions, who: Who, input: { prompt?: string; kind?: TurnKind; preapproved?: string[] } = {}): Promise<void> {
  const kind = input.kind ?? 'normal';
  const room = c.room;
  let progress: ReturnType<typeof stopControl> | undefined;
  running.set(c.key, who);
  try {
    await status.set('running');
    const ts = convState(c);
    const channel = effective(c, ts);
    let prompt = input.prompt;
    if (prompt === undefined) {
      const attachments = await saveAttachments(trigger, c.key);
      prompt =
        c.kind === 'dm'
          ? buildDmPrompt(trigger, attachments)
          : await buildPrompt({ thread: room as AnyThreadChannel, trigger, history: channel.history, afterId: ts.sessionId ? ts.lastSeenMessageId : undefined, attachments });
      ts.lastPrompt = prompt;
      const text = trigger.cleanContent.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text) {
        ts.first ??= text;
        ts.last = text;
      }
    }
    // Something the owner decided while Claude was idle (e.g. denied the approve-later list).
    // Not in front of a slash command (/compact, a skill, a retried skill): it must start with "/" to run; the note waits for the next turn.
    if (ts.pendingNote && kind !== 'compact' && !prompt.startsWith('/')) {
      prompt = `${ts.pendingNote}\n\n${prompt}`;
      ts.pendingNote = undefined;
    }
    const deferred: DeferredItem[] = [];
    const before = ts.ctx?.pct;

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
    const session = await acquire(c.key, c.selfId, channel, ts.sessionId, ts.resumeCostBase ?? ts.lastCostTotal, c.kind);
    progress = stopControl(room, who, STOP_BUTTON_DELAY_MS, (by) => void session.interrupt(by));
    const turn = await session.run(prompt, {
      sendReply: async (text, files) => {
        // From 85% on, the context footer goes at the end of the last piece only.
        const chunks = splitReply(text, contextFooter(convState(c).ctx?.pct));
        if (!chunks.length && files.length) chunks.push('');
        for (const [i, chunk] of chunks.entries()) {
          const attach = i === chunks.length - 1 ? files.map((f) => ({ attachment: f, name: path.basename(f) })) : [];
          // In a direct message nobody else is there to notify.
          lastReply = await room.send({ ...(chunk ? { content: chunk } : {}), files: attach, allowedMentions: { parse: c.kind === 'dm' ? [] : ['users'] } });
        }
      },
      askPermission: (req) =>
        waiting(async () => {
          try {
            const answer = await askPermission(room, req, who, channel.ownerWaitMs);
            if (answer.behavior === 'deny' && answer.deferred) deferred.push(deferItem(req.toolName, req.input));
            if (answer.behavior === 'always') {
              ts.alwaysAllow = [...new Set([...(ts.alwaysAllow ?? []), req.toolName])];
              saveState();
            }
            return answer;
          } catch (e) {
            log('error', `permission prompt ${c.key}: ${(e as Error).message}`);
            return { behavior: 'deny' as const, message: `無法在 Discord 上詢問主人（${(e as Error).message}），已拒絕。` };
          }
        }),
      askQuestion: (questions, signal) =>
        waiting(() =>
          askQuestion(room, questions, who, channel.permissionTimeoutMs, signal).catch((e) => {
            log('error', `question prompt ${c.key}: ${(e as Error).message}`);
            return undefined;
          }),
        ),
      notice: async (text) => {
        await room.send({ content: text, allowedMentions: { parse: [] } });
      },
    }, { preapproved: input.preapproved });
    const progressMessage = await progress.end();
    // Calls nobody approved in time: a card for the owner to approve them later.
    if (deferred.length && who.ownerId) {
      await sendApprovalBatch(c, deferred, who).catch((e) => log('error', `approval card ${c.key}: ${(e as Error).stack ?? e}`));
    }

    if (turn.sessionId) ts.sessionId = turn.sessionId;
    ts.lastCostTotal = turn.costTotal;
    // !compact and !retry add no new messages for the session to have seen.
    if (kind === 'normal') ts.lastSeenMessageId = trigger.id;
    ts.lastAt = new Date().toISOString();
    saveState();

    // The progress message is reused for whatever notice the turn ends with, otherwise removed.
    const notice = async (content: string): Promise<Message> =>
      progressMessage ? await progressMessage.edit({ content, components: [], allowedMentions: { parse: [] } }) : await room.send({ content, allowedMentions: { parse: [] } });

    if (turn.stoppedBy) {
      log('stopped', `${c.key} by ${turn.stoppedBy} subtype=${turn.subtype}`);
      const msg = await notice(`⏹️ 已由 ${turn.stoppedBy} 停止。下一則訊息會接著這段對話。`);
      await attachDetails(msg, rememberTurn(c.key, turn));
      await status.set('stopped');
      await checkContext(c, session, ts);
      return;
    }
    if (kind === 'compact') {
      const after = turn.ok ? await checkContext(c, session, ts) : undefined;
      const text = turn.ok
        ? `🗜️ 已壓縮上下文${before !== undefined && after !== undefined ? `：${before}% → ${after}%` : after !== undefined ? `，現在 ${after}%` : ''}。`
        : explainFailure({ subtype: turn.subtype, error: turn.error, apiError: turn.apiError }, '這段對話沒有被壓縮。');
      log(turn.ok ? 'compact' : 'fallback', `${c.key} ${brief(text, 200)}`);
      await attachDetails(await notice(text), rememberTurn(c.key, turn));
      await status.set(turn.ok ? 'done' : 'failed');
      return;
    }
    // Another bot got no answer on purpose (nothing to do): stay silent instead of
    // posting a summary, which would only add noise to the bot-to-bot exchange.
    if ((kind === 'normal' || kind === 'approved') && turn.ok && turn.replies === 0 && trigger.author.bot) {
      log('silent', `${c.key} no reply to bot ${trigger.author.username} ${brief(turn.lastText, 200)}`);
      await progressMessage?.delete().catch(() => {});
      await status.set('done');
      await checkContext(c, session, ts);
      return;
    }
    if (!turn.ok || turn.replies === 0 || !lastReply) {
      const text = turn.ok
        ? `（沒有呼叫 reply，以下為自動摘要）\n${turn.lastText.trim().slice(0, FALLBACK_MAX) || '（沒有輸出）'}`
        : explainFailure({ subtype: turn.subtype, error: turn.error, apiError: turn.apiError }, c.kind === 'dm' ? '下一則訊息會接著這段對話。' : '下次觸發時會接回這段對話。');
      log('fallback', `${c.key} ${brief(text, 200)}`);
      lastReply = await notice(text);
    } else {
      await progressMessage?.delete().catch(() => {});
    }
    await attachDetails(lastReply, rememberTurn(c.key, turn));
    await status.set(turn.ok ? 'done' : 'failed');
    await checkContext(c, session, ts);
  } catch (e) {
    log('error', `run ${c.key}: ${(e as Error).stack ?? e}`);
    await (await progress?.end())?.delete().catch(() => {});
    await room.send({ content: explainFailure({ subtype: 'error', error: (e as Error).message }), allowedMentions: { parse: [] } }).catch(() => {});
    await status.set('failed');
  } finally {
    if (running.get(c.key) === who) running.delete(c.key);
  }
}
