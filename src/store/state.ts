/**
 * Local state: <HOME>\state.json.
 * One entry per thread the bot handles; the thread ↔ session mapping lives here.
 * Direct messages with the owner are one conversation (`dm`), with earlier ones
 * kept in `dmHistory` for !resume.
 * Hop counts are not kept here: every bot derives them from the thread history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import type { Batch } from '../runner/approvals.js';
import type { SkillItem } from '../runner/skills.js';

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
  /** Thread name (or a label for a direct message conversation), for !resume. */
  name?: string;
  /** When the last turn ended (ISO). */
  lastAt?: string;
  /** Model chosen with !model; overrides the binding's model. */
  model?: string;
  /** !plan is on: the session runs in plan mode until !plan again. */
  plan?: boolean;
  /** The last prompt handed to Claude, for !retry. */
  lastPrompt?: string;
  /** First and latest message text of the conversation (short), for !resume. */
  first?: string;
  last?: string;
  /** Context window use after the last turn. */
  ctx?: { pct: number; tokens?: number; max?: number; at: string };
  /** Context thresholds already announced (see runner/usage.ts). */
  ctxNotified?: number[];
  /** Told to Claude in front of the next message (e.g. the owner denied pending approvals). */
  pendingNote?: string;
};

/** A direct-message conversation. `cwd` is set when it continues a thread's session (that thread's folder). */
export type DmState = ThreadState & { cwd?: string; source?: string };

/** The /skill list last reported by a session, per working folder. */
type SkillList = { at: string; items: SkillItem[] };

type State = { threads: Record<string, ThreadState>; dm?: DmState; dmHistory?: DmState[]; approvals?: Record<string, Batch>; skills?: Record<string, SkillList> };

/** Key of the direct-message conversation in the session pool, the queue and the inbox. */
export const DM_KEY = 'dm';
const DM_HISTORY_MAX = 30;

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

export function registerThread(threadId: string, channelId: string, name?: string): ThreadState {
  const t: ThreadState = { channelId, lastCostTotal: 0, resumeCostBase: 0, createdAt: new Date().toISOString(), ...(name ? { name } : {}) };
  state.threads[threadId] = t;
  saveState();
  return t;
}

export function getBatch(id: string): Batch | undefined {
  return state.approvals?.[id];
}

/** Store a pending-approval batch; batches a week past their expiry are dropped. Saves. */
export function putBatch(b: Batch): void {
  const keep = Date.now() - 7 * 24 * 60 * 60 * 1000;
  state.approvals = Object.fromEntries(Object.entries(state.approvals ?? {}).filter(([, x]) => x.expiresAt > keep));
  state.approvals[b.id] = b;
  saveState();
}

export function allThreads(): [string, ThreadState][] {
  return Object.entries(state.threads);
}

function freshDm(): DmState {
  return { channelId: DM_KEY, lastCostTotal: 0, resumeCostBase: 0, createdAt: new Date().toISOString() };
}

/** The current direct-message conversation (created empty when there is none). */
export function getDm(): DmState {
  state.dm ??= freshDm();
  return state.dm;
}

export function dmHistory(): DmState[] {
  return state.dmHistory ?? [];
}

/**
 * Put the current direct-message conversation (if it has a session) into the
 * history and make `next` (or a new empty one) current. Saves.
 */
export function switchDm(next?: DmState): DmState {
  const cur = state.dm;
  const rest = (state.dmHistory ?? []).filter((h) => h.sessionId && h.sessionId !== cur?.sessionId && h.sessionId !== next?.sessionId);
  state.dmHistory = [...(cur?.sessionId ? [cur] : []), ...rest].slice(0, DM_HISTORY_MAX);
  state.dm = next ?? freshDm();
  saveState();
  return state.dm;
}

/** State of a conversation by its key: a thread ID, or DM_KEY. */
export function getConversation(key: string): ThreadState | undefined {
  return key === DM_KEY ? state.dm : state.threads[key];
}

/** Wherever this session is recorded now (it may have moved to the history after !clear). */
export function findSession(key: string, sessionId: string | undefined): ThreadState | undefined {
  if (!sessionId) return undefined;
  if (key !== DM_KEY) return state.threads[key]?.sessionId === sessionId ? state.threads[key] : undefined;
  return [state.dm, ...(state.dmHistory ?? [])].find((d) => d?.sessionId === sessionId);
}

const folderKey = (cwd: string) => path.resolve(cwd).toLowerCase();

/** Remember the skills a session in `cwd` offers (the latest list wins). Saves when it changed. */
export function rememberSkills(cwd: string, items: SkillItem[]): void {
  const key = folderKey(cwd);
  const prev = state.skills?.[key];
  if (prev && JSON.stringify(prev.items) === JSON.stringify(items)) return;
  state.skills = { ...(state.skills ?? {}), [key]: { at: new Date().toISOString(), items } };
  saveState();
}

/** The skills last seen for `cwd`, or undefined before any session ran there. */
export function skillsFor(cwd: string): SkillItem[] | undefined {
  return state.skills?.[folderKey(cwd)]?.items;
}
