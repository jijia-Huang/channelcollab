/**
 * Approve later (PLAN §8): when the owner does not answer a permission request
 * within `defaults.owner_wait_minutes` (default 2), the call is denied with
 * DEFER_MESSAGE, Claude finishes what it can without it, and the call goes on
 * the conversation's list of pending approvals. The owner gets a card (by
 * direct message, else in the thread) to approve all, pick, or deny all.
 * Approved calls are allowed in the next turn when Claude repeats them with the
 * same input (retryKey), exactly like an approved auto mode block.
 *
 * Batches are kept in state.json, so the card keeps working after the session
 * is closed or the bot restarts, until it expires (24 hours). Pure apart from
 * the store functions.
 */
import { retryKey } from './policy.js';

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFER_MESSAGE =
  '主人暫時不在。這個動作已排入待核准清單。請改用不需要權限的方式把能做的做完；做不到的部分，在 reply 裡整理成「待主人核准」，說明要做什麼、為什麼，然後結束這一輪。不要重試同一個動作。';

export type DeferredItem = { toolName: string; input: Record<string, unknown>; key: string };

export type BatchStatus = 'pending' | 'approved' | 'partial' | 'denied' | 'expired';

export type Batch = {
  id: string;
  /** Conversation key (thread ID or the DM key) and kind. */
  convKey: string;
  kind: 'thread' | 'dm';
  /** Who asked for the work (none when another bot did). */
  requesterId?: string;
  items: DeferredItem[];
  createdAt: number;
  expiresAt: number;
  status: BatchStatus;
  /** The short notice in the conversation, and the card with the buttons. */
  notice?: { channelId: string; messageId: string };
  card?: { channelId: string; messageId: string; where: 'dm' | 'thread' };
};

/** How long a permission request waits for the owner: the shorter of the two settings. */
export function ownerWaitMs(ownerWaitMinutes: number, permissionTimeoutMinutes: number): number {
  return Math.min(ownerWaitMinutes, permissionTimeoutMinutes) * 60 * 1000;
}

export function deferItem(toolName: string, input: Record<string, unknown>): DeferredItem {
  return { toolName, input, key: retryKey(toolName, input) };
}

/** The retryKeys the follow-up turn allows: only these calls, only with this input. */
export function deferredKeys(items: DeferredItem[]): string[] {
  return items.map((x) => x.key);
}

/** A new batch; the same call deferred twice in one turn is listed once. */
export function newBatch(f: { id: string; convKey: string; kind: 'thread' | 'dm'; requesterId?: string; items: DeferredItem[]; now?: number }): Batch {
  const now = f.now ?? Date.now();
  const seen = new Set<string>();
  const items = f.items.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)));
  return { id: f.id, convKey: f.convKey, kind: f.kind, ...(f.requesterId ? { requesterId: f.requesterId } : {}), items, createdAt: now, expiresAt: now + APPROVAL_TTL_MS, status: 'pending' };
}

export type Choice = 'all' | 'none' | number[];

export type Decision =
  | { result: 'decided'; status: 'approved' | 'partial' | 'denied'; allow: DeferredItem[]; deny: DeferredItem[] }
  | { result: 'expired' }
  | { result: 'already'; status: BatchStatus };

/** Apply the owner's choice (indices are 0-based). Mutates the batch's status. */
export function decide(b: Batch, choice: Choice, now = Date.now()): Decision {
  if (b.status !== 'pending') return { result: 'already', status: b.status };
  if (now >= b.expiresAt) {
    b.status = 'expired';
    return { result: 'expired' };
  }
  const picked = choice === 'all' ? b.items.map((_, i) => i) : choice === 'none' ? [] : choice.filter((i) => i >= 0 && i < b.items.length);
  const allow = b.items.filter((_, i) => picked.includes(i));
  const deny = b.items.filter((_, i) => !picked.includes(i));
  b.status = !allow.length ? 'denied' : deny.length ? 'partial' : 'approved';
  return { result: 'decided', status: b.status, allow, deny };
}

const line = (x: DeferredItem, i: number) => `${i + 1}. ${x.toolName} ${JSON.stringify(x.input).slice(0, 400)}`;

/** The message pushed into the session after the owner approved. */
export function approvedPrompt(allow: DeferredItem[], deny: DeferredItem[]): string {
  const parts = [`主人已核准：\n${allow.map(line).join('\n')}\n請用相同參數執行這些動作，完成剩下的工作，並用 reply 回報。`];
  if (deny.length) parts.push(`主人拒絕了這些動作，不要做：\n${deny.map(line).join('\n')}`);
  return parts.join('\n\n');
}

/** Told to Claude with the next message after the owner denied everything. */
export function deniedNote(deny: DeferredItem[]): string {
  return `【主人的決定】先前排入待核准清單的動作，主人拒絕了，不要做這些動作：\n${deny.map(line).join('\n')}`;
}

/** The short notice in the conversation (no buttons, no details). */
export function noticeText(b: Batch, ownerId: string, where: 'dm' | 'thread'): string {
  const n = b.items.length;
  if (b.status === 'approved') return `✅ 主人已核准待核准的 ${n} 個動作，Bot 接著做。`;
  if (b.status === 'partial') return `✅ 主人已核准部分待核准的動作，Bot 接著做（其餘已拒絕）。`;
  if (b.status === 'denied') return `🚫 主人拒絕了待核准的 ${n} 個動作。`;
  if (b.status === 'expired') return `⌛ 待核准的 ${n} 個動作已過期（24 小時），沒有執行。`;
  return `⏳ 有 ${n} 個動作等 <@${ownerId}> 核准（${where === 'dm' ? '已私訊主人' : '請主人按下方的卡片'}）。`;
}

/** Card result line once decided. */
export function outcomeText(d: Decision, by: string): string {
  if (d.result === 'expired') return '⌛ 已過期（24 小時），按鈕失效。';
  if (d.result === 'already') return `已處理過（${d.status}）。`;
  if (d.status === 'approved') return `✅ ${by} 已全部核准，Bot 接著做。`;
  if (d.status === 'denied') return `🚫 ${by} 已全部拒絕。`;
  return `✅ ${by} 核准了 ${d.allow.length} 個，拒絕了 ${d.deny.length} 個，Bot 接著做核准的部分。`;
}

/**
 * Deliver the card: by direct message to the owner first; when that fails
 * (e.g. the owner does not accept direct messages from server members), in
 * the conversation itself, where only the owner can press the buttons.
 */
export async function deliverCard<T>(send: { dm?: () => Promise<T>; thread: () => Promise<T> }, onDmError?: (e: Error) => void): Promise<{ where: 'dm' | 'thread'; sent: T }> {
  if (send.dm) {
    try {
      return { where: 'dm', sent: await send.dm() };
    } catch (e) {
      onDmError?.(e as Error);
    }
  }
  return { where: 'thread', sent: await send.thread() };
}
