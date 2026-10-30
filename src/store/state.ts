/**
 * Local state: <HOME>\state.json.
 * One entry per thread the bot handles; the thread ↔ session mapping lives here.
 * Hop counts are not kept here: every bot derives them from the thread history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const STATE_PATH = path.join(DATA_DIR, 'state.json');

export type ThreadState = {
  /** The bound channel the thread belongs to. */
  channelId: string;
  sessionId?: string;
  /** Last cumulative total_cost_usd seen for the session (shown in the details view). */
  lastCostTotal: number;
  /**
   * The total a resumed session starts counting from: the CLI saves it only on a
   * clean exit, so a crash loses the turns since. Missing in entries written
   * before live sessions, where every run ended cleanly (= lastCostTotal).
   */
  resumeCostBase?: number;
  /** Newest message already handed to the session; older history is not resent. */
  lastSeenMessageId?: string;
  /** Tools the owner chose "always allow" for in this thread's session. */
  alwaysAllow?: string[];
  createdAt: string;
};

type State = { threads: Record<string, ThreadState> };

let state: State = { threads: {} };

export function loadState(): void {
  if (!existsSync(STATE_PATH)) return;
  state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  state.threads ??= {};
}

export function saveState(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, STATE_PATH);
}

export function getThread(threadId: string): ThreadState | undefined {
  return state.threads[threadId];
}

export function registerThread(threadId: string, channelId: string): ThreadState {
  const t: ThreadState = { channelId, lastCostTotal: 0, resumeCostBase: 0, createdAt: new Date().toISOString() };
  state.threads[threadId] = t;
  saveState();
  return t;
}
