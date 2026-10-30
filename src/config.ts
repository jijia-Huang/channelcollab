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
};

export type Defaults = {
  history: number;
  max_hops: number;
  busy_policy: 'queue' | 'interrupt';
  idle_close_minutes: number;
  max_live_sessions: number;
  permission_mode: PermissionMode;
  /** How long a permission request or question waits for an answer before it is denied. */
  permission_timeout_minutes: number;
};

export type Config = {
  /** owner_id: who may approve permission requests; falls back to this bot's ownerDiscordId in the roster. */
  discord: { token: string; guild_id?: string; owner_id?: string };
  defaults: Defaults;
  channels: Record<string, ChannelConfig>;
};

/** Settings for one bound channel, with defaults applied. */
export type ResolvedChannel = {
  channelId: string;
  cwd: string;
  launcher: string;
  model?: string;
  permissionMode: PermissionMode;
  tools?: string[];
  history: number;
  maxHops: number;
  permissionTimeoutMs: number;
};

const BUILTIN_DEFAULTS: Defaults = {
  history: 30,
  max_hops: 5,
  busy_policy: 'queue',
  idle_close_minutes: 120,
  max_live_sessions: 4,
  permission_mode: 'default',
  permission_timeout_minutes: 10,
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
  };
}

export function resolveChannel(config: Config, channelId: string): ResolvedChannel | undefined {
  const ch = config.channels[channelId];
  if (!ch) return undefined;
  const permissionMode = ch.permission_mode ?? config.defaults.permission_mode;
  if (!ALLOWED_MODES.includes(permissionMode)) {
    throw new Error(`channel ${channelId}: permission_mode "${permissionMode}" is not allowed`);
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
  };
}
