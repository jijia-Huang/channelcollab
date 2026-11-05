/**
 * Live sessions, one per thread (PLAN §6). A session stays up between turns
 * and is closed when idle longer than `idle_close_minutes`, when more than
 * `max_live_sessions` are up (the longest-idle goes), or on shutdown. A closed
 * thread resumes from its saved session ID the next time it is triggered.
 */
import { loadConfig, type ResolvedChannel } from '../config.js';
import { log } from '../log.js';
import { isPending } from '../router/queue.js';
import { findSession, getConversation, saveState } from '../store/state.js';
import { LiveSession, type ConversationKind } from './session.js';

const SWEEP_MS = 15 * 1000;

const live = new Map<string, LiveSession>();
/** Sessions on their way out; a new one for the same thread waits for these to finish. */
const closing = new Map<string, Promise<void>>();
let stopping = false;
/** Conversations taken over on the computer: no session may be started for them (PLAN §21). */
const held = new Set<string>();

/** While the owner works on this conversation on the computer, refuse to start its session here. */
export function hold(key: string): void {
  held.add(key);
}

export function unhold(key: string): void {
  held.delete(key);
}

export function isHeld(key: string): boolean {
  return held.has(key);
}
let sweeper: NodeJS.Timeout | undefined;

/** The thread's live session, if one is up (e.g. for 🛑). */
export function liveSession(threadId: string): LiveSession | undefined {
  return live.get(threadId);
}

function limits(): { idleMs: number; max: number } {
  const d = loadConfig().defaults;
  return { idleMs: d.idle_close_minutes * 60 * 1000, max: d.max_live_sessions };
}

/** Idle: no turn running and nothing queued for the thread. */
function idle(s: LiveSession): boolean {
  return !s.busy && !isPending(s.threadId);
}

function retire(s: LiveSession, reason: string, force = false): Promise<void> {
  if (live.get(s.threadId) === s) live.delete(s.threadId);
  const p = s.close(reason, force).catch((e) => log('pool', `close ${s.threadId} failed: ${(e as Error).message}`));
  closing.set(s.threadId, p);
  void p.finally(() => {
    if (closing.get(s.threadId) === p) closing.delete(s.threadId);
  });
  return p;
}

/**
 * The live session for a thread, starting (or resuming) one if needed.
 * Called by the thread's queued job, so only one caller per thread at a time.
 */
export async function acquire(threadId: string, selfId: string, channel: ResolvedChannel, resume: string | undefined, costBase: number, kind: ConversationKind = 'thread', targets = ''): Promise<LiveSession> {
  if (stopping) throw new Error('bot is shutting down');
  // Two processes on one session fork its transcript and one side's turns are lost (spike/v017-cli.mjs).
  if (held.has(threadId) || getConversation(threadId)?.takeover) throw new Error('this conversation is taken over on the computer');
  const current = live.get(threadId);
  if (current?.usable) return current;
  if (current) retire(current, 'ended');
  await closing.get(threadId);
  if (stopping) throw new Error('bot is shutting down');

  if (held.has(threadId) || getConversation(threadId)?.takeover) throw new Error('this conversation is taken over on the computer');
  const s = new LiveSession(threadId, selfId, channel, resume, costBase, getConversation(threadId)?.alwaysAllow, kind, targets);
  live.set(threadId, s);
  void s.done.then(() => {
    // The conversation may have moved on (!clear, !resume): update the entry that still has this session.
    const ts = findSession(threadId, s.sessionId);
    if (ts && s.cleanExit) {
      ts.resumeCostBase = s.costTotal;
      saveState();
    }
    // Exited on its own (crash, timeout): drop it so the next trigger resumes.
    if (live.get(threadId) === s) {
      live.delete(threadId);
      log('pool', `${threadId} session exited, will resume on next trigger (live=${live.size})`);
    }
  });
  enforceLimit(threadId);
  sweeper ??= setInterval(sweep, SWEEP_MS);
  sweeper.unref();
  return s;
}

function enforceLimit(keep: string): void {
  let max: number;
  try {
    max = limits().max;
  } catch (e) {
    log('pool', `limit check skipped: ${(e as Error).message}`);
    return;
  }
  const candidates = [...live.values()]
    .filter((s) => s.threadId !== keep && idle(s))
    .sort((a, b) => a.lastActivity - b.lastActivity);
  while (live.size > max) {
    const s = candidates.shift();
    if (!s) {
      log('pool', `live=${live.size} exceeds max_live_sessions=${max}, but every other session is busy`);
      return;
    }
    log('pool', `live=${live.size} exceeds max_live_sessions=${max}, closing longest idle ${s.threadId} (idle ${Math.round((Date.now() - s.lastActivity) / 1000)} s)`);
    retire(s, 'evicted');
  }
}

function sweep(): void {
  let idleMs: number;
  try {
    idleMs = limits().idleMs;
  } catch (e) {
    log('pool', `idle check skipped: ${(e as Error).message}`);
    return;
  }
  const now = Date.now();
  for (const s of live.values()) {
    if (idle(s) && now - s.lastActivity >= idleMs) {
      log('pool', `${s.threadId} idle ${Math.round((now - s.lastActivity) / 1000)} s >= ${idleMs / 1000} s`);
      retire(s, 'idle');
    }
  }
}

/** End a conversation's live session gracefully (!clear, !resume); the next turn starts or resumes another. */
export function release(threadId: string, reason: string): Promise<void> {
  const s = live.get(threadId);
  return s ? retire(s, reason) : (closing.get(threadId) ?? Promise.resolve());
}

/** Shutdown: refuse new sessions, kill running turns, close everything, wait for the process trees. */
export async function closeAll(): Promise<void> {
  stopping = true;
  if (sweeper) clearInterval(sweeper);
  const sessions = [...live.values()];
  log('pool', `closing ${sessions.length} live session(s)`);
  await Promise.all([...sessions.map((s) => retire(s, 'shutdown', s.busy)), ...closing.values()]);
}
