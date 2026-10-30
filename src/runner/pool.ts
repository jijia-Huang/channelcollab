/**
 * Live sessions, one per thread (PLAN §6). A session stays up between turns
 * and is closed when idle longer than `idle_close_minutes`, when more than
 * `max_live_sessions` are up (the longest-idle goes), or on shutdown. A closed
 * thread resumes from its saved session ID the next time it is triggered.
 */
import { loadConfig, type ResolvedChannel } from '../config.js';
import { log } from '../log.js';
import { isPending } from '../router/queue.js';
import { getThread, saveState } from '../store/state.js';
import { LiveSession } from './session.js';

const SWEEP_MS = 15 * 1000;

const live = new Map<string, LiveSession>();
/** Sessions on their way out; a new one for the same thread waits for these to finish. */
const closing = new Map<string, Promise<void>>();
let stopping = false;
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
export async function acquire(threadId: string, selfId: string, channel: ResolvedChannel, resume: string | undefined, costBase: number): Promise<LiveSession> {
  if (stopping) throw new Error('bot is shutting down');
  const current = live.get(threadId);
  if (current?.usable) return current;
  if (current) retire(current, 'ended');
  await closing.get(threadId);
  if (stopping) throw new Error('bot is shutting down');

  const s = new LiveSession(threadId, selfId, channel, resume, costBase, getThread(threadId)?.alwaysAllow);
  live.set(threadId, s);
  void s.done.then(() => {
    const ts = getThread(threadId);
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

/** Shutdown: refuse new sessions, kill running turns, close everything, wait for the process trees. */
export async function closeAll(): Promise<void> {
  stopping = true;
  if (sweeper) clearInterval(sweeper);
  const sessions = [...live.values()];
  log('pool', `closing ${sessions.length} live session(s)`);
  await Promise.all([...sessions.map((s) => retire(s, 'shutdown', s.busy)), ...closing.values()]);
}
