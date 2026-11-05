/**
 * The optional working-time limit of one turn (PLAN §6, 0.1.7). Off by default
 * (`turn_timeout_minutes: 0`): a turn runs until it ends, and only the owner
 * stops it (🛑, /stop, !stop). When a limit is set, the clock runs only while
 * Claude works: time spent waiting for someone (permission buttons,
 * AskUserQuestion) is not counted. Pure apart from timers, so it can be tested
 * on its own (src/features.test.ts).
 */

/** A heads-up this long before the limit, for limits of at least twice this. */
export const WARN_BEFORE_MS = 5 * 60 * 1000;

export class TurnClock {
  private remaining: number;
  private warnAt: number;
  private started = 0;
  private timer?: NodeJS.Timeout;
  private warnTimer?: NodeJS.Timeout;
  private running = false;
  private done = false;

  /** `limitMs` 0 (or less) means no limit: neither callback ever fires. */
  constructor(
    readonly limitMs: number,
    private readonly onTimeout: () => void,
    private readonly onWarn?: () => void,
    warnBeforeMs = WARN_BEFORE_MS,
  ) {
    this.remaining = limitMs;
    // Remaining working time at which the warning goes out (none for short limits).
    this.warnAt = limitMs > 0 && onWarn && limitMs >= 2 * warnBeforeMs ? warnBeforeMs : -1;
  }

  get limited(): boolean {
    return this.limitMs > 0;
  }

  /** Working time left (ms); Infinity without a limit. */
  get left(): number {
    if (!this.limited) return Infinity;
    return Math.max(0, this.remaining - (this.running ? Date.now() - this.started : 0));
  }

  /** Start or continue counting. */
  resume(): void {
    if (!this.limited || this.running || this.done) return;
    this.running = true;
    this.started = Date.now();
    this.timer = setTimeout(() => {
      this.done = true;
      this.clear();
      this.onTimeout();
    }, this.remaining);
    this.timer.unref?.();
    if (this.warnAt > 0 && this.remaining > this.warnAt) {
      this.warnTimer = setTimeout(() => {
        this.warnAt = -1;
        this.onWarn?.();
      }, this.remaining - this.warnAt);
      this.warnTimer.unref?.();
    }
  }

  /** Stop counting while someone is being waited for. */
  pause(): void {
    if (!this.running) return;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
    this.clear();
  }

  /** The turn ended: nothing fires after this. */
  stop(): void {
    this.done = true;
    this.clear();
  }

  private clear(): void {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.warnTimer);
    this.timer = this.warnTimer = undefined;
  }
}

/** 「60 分鐘」 / 「1 小時 30 分」 for a limit in ms. */
export function limitLabel(ms: number): string {
  if (!ms || ms <= 0) return '不限';
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h} 小時${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分鐘`;
}

/**
 * The notice the bot posts itself when a turn hits the limit (Claude is not
 * asked to explain it: it could mistake the stop for a blocked action).
 * In a thread it mentions whoever asked and the owner; a direct message mentions nobody.
 */
export function timeoutNotice(limitMs: number, kind: 'thread' | 'dm', who: { ownerId?: string; requesterId?: string } = {}): { content: string; users: string[] } {
  const users = kind === 'dm' ? [] : [who.requesterId, who.ownerId].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
  const at = users.map((u) => `<@${u}>`).join(' ');
  return {
    content: `${at ? `${at} ` : ''}⏱️ 這一輪工作超過 ${limitLabel(limitMs)}的上限，已停止（不是被擋下）。對話已保存，回覆「繼續」就會接著做。要調整上限請改設定的 turn_timeout_minutes（0 代表不限）。`,
    users,
  };
}

/** The notice when a turn stops at the step limit (max_turns; off by default), posted by the bot like the time limit's. */
export function maxTurnsNotice(maxTurns: number, kind: 'thread' | 'dm', who: { ownerId?: string; requesterId?: string } = {}): { content: string; users: string[] } {
  const users = kind === 'dm' ? [] : [who.requesterId, who.ownerId].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
  const at = users.map((u) => `<@${u}>`).join(' ');
  return {
    content: `${at ? `${at} ` : ''}⏹️ 這一輪已達 ${maxTurns > 0 ? `${maxTurns} 步` : '步數'}上限，已停止（不是被擋下）。對話已保存，回覆「繼續」就會接著做。要調整上限請改設定的 max_turns（0 代表不限）。`,
    users,
  };
}

/** The heads-up before the limit. */
export function timeoutWarning(limitMs: number, leftMs: number): string {
  return `⏳ 這一輪快到 ${limitLabel(limitMs)}的工作上限了（剩約 ${Math.max(1, Math.round(leftMs / 60000))} 分鐘）。時間到會停止這一輪，對話會保存。`;
}

/** What Claude sees for any call made after the limit hit (the bot reports the stop itself). */
export const TIMEOUT_TOOL_MESSAGE = 'This turn hit its working-time limit and is being stopped by the bot. Do not call any more tools and do not reply; the bot tells the people in the conversation itself.';
