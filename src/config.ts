/**
 * Local config: <HOME>\config.json (PLAN §5). HOME is CHANNELCOLLAB_HOME, or
 * %USERPROFILE%\.channelcollab; each bot on a machine has its own HOME.
 * The file holds the Discord token, so nothing here ever logs the parsed object.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const DATA_DIR = path.resolve(process.env.CHANNELCOLLAB_HOME || path.join(os.homedir(), '.channelcollab'));
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
/** PID of the running bot: the root of its process tree. */
export const PID_PATH = path.join(DATA_DIR, 'bot.pid');
/** Attachments from Discord are saved under <INBOX_DIR>\<threadId>\. */
export const INBOX_DIR = path.join(DATA_DIR, 'inbox');
/** The running bot listens here for `npm run stop`; one pipe per HOME, so bots with different HOMEs coexist. */
export const STOP_PIPE = `\\\\.\\pipe\\channelcollab-${createHash('sha1').update(DATA_DIR.toLowerCase()).digest('hex').slice(0, 12)}`;

export type ChannelConfig = {
  cwd: string;
  launcher?: string;
  model?: string;
  permission_mode?: PermissionMode;
  tools?: string[];
  /** Working minutes per turn before it is stopped; 0 = no limit. Overrides defaults.turn_timeout_minutes. */
  turn_timeout_minutes?: number;
  /** Steps (API round trips) per turn before it is stopped; 0 = no limit. Overrides defaults.max_turns. */
  max_turns?: number;
  /** Reasoning effort (low … max); unset = Claude Code's default for the model. */
  effort?: string;
};

/** Effort levels the SDK accepts (Options.effort, applyFlagSettings effortLevel). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);

export type Defaults = {
  history: number;
  max_hops: number;
  busy_policy: 'queue' | 'interrupt';
  idle_close_minutes: number;
  max_live_sessions: number;
  permission_mode: PermissionMode;
  /** How long a permission request or question waits for an answer before it is denied. */
  permission_timeout_minutes: number;
  /** A permission request waits this long (or permission_timeout_minutes, if shorter); then it goes on the approve-later list. */
  owner_wait_minutes: number;
  /** Working minutes per turn before it is stopped (waiting for people not counted); 0 = no limit (the default). */
  turn_timeout_minutes: number;
  /** Steps per turn before it is stopped (SDK maxTurns); 0 = no limit (the default). */
  max_turns: number;
};

export type Config = {
  /** owner_id: who may approve permission requests; falls back to this bot's ownerDiscordId in the roster. */
  discord: { token: string; guild_id?: string; owner_id?: string };
  defaults: Defaults;
  channels: Record<string, ChannelConfig>;
  /** Direct messages from the owner: off unless set (and a PIN is set). Same fields as a channel binding. */
  dm?: ChannelConfig;
  /** pin_unlock_minutes: after a correct PIN, approvals and direct messages need no PIN for this long. */
  security: { pin_unlock_minutes: number };
  /** roster_only: only the owner and people / bots in the roster can trigger the bot. */
  access: { roster_only: boolean };
};

/** Files the bot keeps in HOME besides config.json. */
export const PIN_PATH = path.join(DATA_DIR, 'pin.json');

/** Settings for one bound channel, with defaults applied. */
export type ResolvedChannel = {
  channelId: string;
  cwd: string;
  launcher: string;
  model?: string;
  permissionMode: PermissionMode;
  /** The binding's own mode when `permissionMode` is temporarily different (plan through !plan). */
  basePermissionMode?: PermissionMode;
  tools?: string[];
  history: number;
  maxHops: number;
  permissionTimeoutMs: number;
  /** How long a permission request waits for the owner before it is deferred (approve later). */
  ownerWaitMs: number;
  /** Working time per turn before it is stopped; 0 = no limit. */
  turnTimeoutMs: number;
  /** Steps per turn before it is stopped; 0 = no limit. */
  maxTurns: number;
  /** Reasoning effort; undefined = Claude Code's default. */
  effort?: Effort;
};

const BUILTIN_DEFAULTS: Defaults = {
  history: 30,
  max_hops: 5,
  busy_policy: 'queue',
  idle_close_minutes: 120,
  max_live_sessions: 4,
  permission_mode: 'default',
  permission_timeout_minutes: 10,
  owner_wait_minutes: 2,
  // No limit: a turn runs until it ends; only the owner stops it (🛑, /stop, !stop).
  turn_timeout_minutes: 0,
  // No step limit either.
  max_turns: 0,
};

// bypassPermissions would skip every check on the owner's machine; not allowed from Discord.
const ALLOWED_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'];

export function loadConfig(): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    // Only the error class: a JSON parse message can quote file content.
    throw new Error(`cannot read ${CONFIG_PATH} (${(e as Error).name})`);
  }
  const c = raw as Partial<Config>;
  if (!c.discord?.token) throw new Error(`${CONFIG_PATH}: discord.token is missing`);
  return {
    discord: { token: c.discord.token, guild_id: c.discord.guild_id, owner_id: c.discord.owner_id },
    defaults: { ...BUILTIN_DEFAULTS, ...c.defaults },
    channels: c.channels ?? {},
    dm: c.dm && typeof c.dm === 'object' && typeof c.dm.cwd === 'string' && c.dm.cwd ? c.dm : undefined,
    security: { pin_unlock_minutes: positive(c.security?.pin_unlock_minutes, 30) },
    access: { roster_only: c.access?.roster_only !== false },
  };
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function resolveChannel(config: Config, channelId: string): ResolvedChannel | undefined {
  const ch = config.channels[channelId];
  return ch ? resolve(config, channelId, ch, `channel ${channelId}`) : undefined;
}

/** The direct-message settings, or undefined when direct messages are off. */
export function resolveDm(config: Config): ResolvedChannel | undefined {
  return config.dm ? resolve(config, 'dm', config.dm, 'dm') : undefined;
}

function resolve(config: Config, channelId: string, ch: ChannelConfig, what: string): ResolvedChannel {
  const permissionMode = ch.permission_mode ?? config.defaults.permission_mode;
  if (!ALLOWED_MODES.includes(permissionMode)) {
    throw new Error(`${what}: permission_mode "${permissionMode}" is not allowed`);
  }
  return {
    channelId,
    cwd: ch.cwd,
    launcher: ch.launcher ?? '',
    model: ch.model,
    permissionMode,
    tools: ch.tools,
    history: config.defaults.history,
    maxHops: config.defaults.max_hops,
    permissionTimeoutMs: config.defaults.permission_timeout_minutes * 60 * 1000,
    ownerWaitMs: Math.min(config.defaults.owner_wait_minutes, config.defaults.permission_timeout_minutes) * 60 * 1000,
    turnTimeoutMs: minutesOrZero(ch.turn_timeout_minutes ?? config.defaults.turn_timeout_minutes) * 60 * 1000,
    maxTurns: Math.floor(minutesOrZero(ch.max_turns ?? config.defaults.max_turns)),
    ...(isEffort(ch.effort) ? { effort: ch.effort } : {}),
  };
}

/** A limit (minutes, steps): a positive number; anything else (missing, 0, negative, not a number) is 0 = no limit. */
export function minutesOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
