/**
 * Context and plan usage reminders (pure; no Discord, no SDK calls).
 *
 * Context: after each turn the session reports how full its context window is
 * (Query.getContextUsage). 70% and 95% get a one-time notice; from 85% on,
 * every reply carries a one-line footer. Thresholds re-arm once usage falls
 * back below them (after !compact or !clear).
 *
 * Plan usage: `rate_limit_event` messages carry the claude.ai plan's rate-limit
 * windows. `utilization` is a fraction of the window (0-1, can exceed 1) and
 * `resetsAt` is unix seconds (Claude Code's schema for the event). The latest
 * event is account-wide, so it is kept here for every session.
 */
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

export const CONTEXT_THRESHOLDS = [70, 85, 95] as const;
/** From this percentage on, every reply carries the footer. */
export const FOOTER_FROM = 85;
/** Thresholds that also get a message of their own (85 only shows as the footer). */
const NOTICE_AT = new Set([70, 95]);

export type ContextAlert = { notify?: number; notified: number[] };

/**
 * Which threshold to announce now. `notified` are the thresholds already
 * announced; any of them above the current percentage re-arm.
 */
export function contextAlert(pct: number, notified: readonly number[]): ContextAlert {
  const kept = notified.filter((t) => t <= pct);
  const crossed = CONTEXT_THRESHOLDS.filter((t) => pct >= t && !kept.includes(t));
  const next = [...new Set([...kept, ...crossed])].sort((a, b) => a - b);
  const loud = crossed.filter((t) => NOTICE_AT.has(t));
  return loud.length ? { notify: Math.max(...loud), notified: next } : { notified: next };
}

export function contextNotice(pct: number, kind: 'thread' | 'dm'): string {
  const clear = kind === 'dm' ? '，或 !clear 開新對話' : '';
  return pct >= 95
    ? `🧠 上下文已用 ${pct}%，快滿了，建議現在打 !compact 壓縮${clear}。`
    : `🧠 上下文已用 ${pct}%，可以打 !compact 壓縮${clear}。`;
}

/** The line appended to every reply once the context is at least FOOTER_FROM full; '' below that or when unknown. */
export function contextFooter(pct: number | undefined): string {
  if (pct === undefined || pct < FOOTER_FROM) return '';
  return `🧠 上下文 ${pct}%${pct >= 95 ? '，快滿了' : ''}，可打 !compact`;
}

/** Percentage from the last API call's usage when getContextUsage is unavailable. */
export function contextFromUsage(usage: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number } | undefined, window: number | undefined): { pct: number; tokens: number; max: number } | undefined {
  if (!usage || !window) return undefined;
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (!tokens) return undefined;
  return { pct: Math.round((tokens / window) * 100), tokens, max: window };
}

// ---------------------------------------------------------------------------
// Plan usage (rate_limit_event)
// ---------------------------------------------------------------------------

type Window = { utilization?: number; resetsAt?: number; status?: string; surpassedThreshold?: number };
/** `unifiedWindows` is sent by Claude Code but not in the SDK's public type, so it is read defensively. */
export type RateInfo = SDKRateLimitInfo & { unifiedWindows?: Record<string, Window | undefined> };

const LABELS: Record<string, string> = {
  five_hour: '5 小時',
  seven_day: '每週',
  seven_day_opus: '每週 Opus',
  seven_day_sonnet: '每週 Sonnet',
  seven_day_overage_included: '每週（含加購）',
  overage: '加購',
};
export const rateLabel = (type: string) => LABELS[type] ?? type;

/** Every window the event describes: the per-window list when present, else the top-level (currently limiting) one. */
export function rateWindows(info: RateInfo): (Window & { type: string })[] {
  const out: (Window & { type: string })[] = [];
  for (const [type, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w && typeof w === 'object') out.push({ type, utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: w.status, surpassedThreshold: num(w.surpassedThreshold) });
  }
  if (!out.length && info.rateLimitType) {
    out.push({ type: info.rateLimitType, utilization: num(info.utilization), resetsAt: num(info.resetsAt), status: info.status, surpassedThreshold: num(info.surpassedThreshold) });
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pctOf = (u: number) => Math.round(u * 100);

/** 「14:30」 today, otherwise 「11/7 23:20」, in this computer's time zone. */
export function formatReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt) return '';
  const d = new Date(resetsAt * 1000);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 0 fine, 1 warned by the server without a number, 80 / 95 by utilization, 100 rejected. */
function level(w: Window): number {
  if (w.status === 'rejected') return 100;
  if (w.utilization !== undefined && w.utilization >= 0.95) return 95;
  if (w.utilization !== undefined && w.utilization >= 0.8) return 80;
  if (w.status === 'allowed_warning') return 1;
  return 0;
}

/**
 * Reminders for this event, once per window and level. `notified` maps a
 * window type to the level and reset time last announced; a new reset time or
 * a drop back to a lower level re-arms it.
 */
export function rateAlerts(info: RateInfo, notified: Map<string, { level: number; resetsAt?: number }>, now = Date.now()): string[] {
  const out: string[] = [];
  const windows = rateWindows(info);
  for (const w of windows) {
    const lv = level(w);
    const prev = notified.get(w.type);
    const fresh = !prev || prev.resetsAt !== w.resetsAt;
    if (fresh || lv < prev!.level) notified.set(w.type, { level: Math.min(lv, fresh ? 0 : lv), resetsAt: w.resetsAt });
    const cur = notified.get(w.type)!;
    if (lv <= cur.level || lv === 0) continue;
    cur.level = lv;
    const when = formatReset(w.resetsAt, now);
    const reset = when ? `，約 ${when} 重置` : '';
    if (lv === 100) out.push(`⛔ ${rateLabel(w.type)}額度已用完${reset}${when ? '，到時再試' : ''}。`);
    else if (lv === 1) out.push(`⚠️ ${rateLabel(w.type)}額度接近上限${reset}。`);
    else out.push(`⚠️ ${rateLabel(w.type)}額度已用 ${pctOf(w.utilization!)}%${reset}。`);
  }
  // Refused right now (top-level status) but no window said so: still say when it comes back.
  if (info.status === 'rejected' && !out.some((l) => l.startsWith('⛔')) && !windows.some((w) => w.status === 'rejected')) {
    const key = `rejected:${info.rateLimitType ?? '-'}`;
    if (notified.get(key)?.resetsAt !== info.resetsAt) {
      notified.set(key, { level: 100, resetsAt: info.resetsAt });
      const when = formatReset(info.resetsAt, now);
      out.push(`⛔ ${info.rateLimitType ? rateLabel(info.rateLimitType) : ''}額度已用完${when ? `，約 ${when} 重置，到時再試` : ''}。`);
    }
  }
  return out;
}

/** One line for !status, or 未知 when no event has arrived since the bot started. */
export function rateSummary(info: RateInfo | undefined, now = Date.now()): string {
  if (!info) return '未知（這次啟動後還沒收到額度資訊，跑過一輪後再看）';
  const parts = rateWindows(info).map((w) => {
    const used = w.utilization !== undefined ? `${pctOf(w.utilization)}%` : w.status === 'rejected' ? '已用完' : w.status === 'allowed_warning' ? '接近上限' : '正常';
    const when = formatReset(w.resetsAt, now);
    return `${rateLabel(w.type)} ${used}${when ? `（${when} 重置）` : ''}`;
  });
  const state = info.status === 'rejected' ? '⛔ 目前被限制' : info.status === 'allowed_warning' ? '⚠️ 接近上限' : '正常';
  return parts.length ? `${state}：${parts.join('、')}` : state;
}

// Account-wide: the latest event and what has been announced, shared by every session.
let latestRate: RateInfo | undefined;
const rateNotified = new Map<string, { level: number; resetsAt?: number }>();

/** Record an event; returns the reminders to post (possibly none). */
export function recordRateLimit(info: RateInfo): string[] {
  latestRate = info;
  return rateAlerts(info, rateNotified);
}

export function latestRateLimit(): RateInfo | undefined {
  return latestRate;
}
