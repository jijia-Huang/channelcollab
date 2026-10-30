/**
 * Launcher contract (PLAN §5): empty or "claude" → the SDK's built-in CLI;
 * a .cmd/.bat → spawned through cmd.exe with double caret escaping (Phase 0-5);
 * any other path → handed to the SDK as the executable.
 *
 * Every launcher is spawned here rather than by the SDK so the bot knows the
 * child's PID and can end the whole process tree (`taskkill /T`).
 */
import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

type LauncherOptions = Pick<Options, 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'>;
export type Spawned = ChildProcessByStdio<Writable, Readable, Readable>;

export function launcherOptions(launcher: string, onStderr: (d: string) => void, onSpawn: (child: Spawned) => void): LauncherOptions {
  const l = launcher.trim();
  if (/\.(cmd|bat)$/i.test(l)) {
    return { pathToClaudeCodeExecutable: l, spawnClaudeCodeProcess: (o) => track(spawnViaCmd(o), o, onStderr, onSpawn) };
  }
  const spawnClaudeCodeProcess = (o: SpawnOptions) => track(spawnDirect(o), o, onStderr, onSpawn);
  if (l === '' || l.toLowerCase() === 'claude') return { spawnClaudeCodeProcess };
  return { pathToClaudeCodeExecutable: l, spawnClaudeCodeProcess };
}

function alive(child: ChildProcess): boolean {
  return !!child.pid && child.exitCode === null && child.signalCode === null;
}

/** End the child and everything it started. Resolves once taskkill has run (or nothing was left). */
export function killTree(child: ChildProcess): Promise<void> {
  if (!alive(child)) return Promise.resolve();
  return new Promise((resolve) => execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => resolve()));
}

function track(child: Spawned, o: SpawnOptions, onStderr: (d: string) => void, onSpawn: (child: Spawned) => void): Spawned {
  child.stderr.on('data', (d: Buffer) => onStderr(d.toString('utf8')));
  // Not passed to spawn(): on Windows that kills only the top process, and once
  // it is gone taskkill /T can no longer find the rest of the tree. The SDK
  // fires this signal only after its stdin-EOF grace period.
  o.signal.addEventListener('abort', () => void killTree(child));
  onSpawn(child);
  return child;
}

function spawnDirect(o: SpawnOptions): Spawned {
  return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

// cmd parses the line twice: once for `cmd /c`, once more when the launcher
// expands %*. Quote each argument for the C runtime, then caret-escape every
// cmd metacharacter twice (one level is consumed per parse).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return a.replace(CMD_META, '^$1');
}

function spawnViaCmd(o: SpawnOptions): Spawned {
  const line = [o.command.replace(CMD_META, '^$1'), ...o.args.map(escapeCmdArg)].join(' ');
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}
