/**
 * Entry point: `npm start` runs the bot (Phase 1: bot mode only) as a single
 * node process, so bot.pid is the root of the whole process tree.
 * `npm run stop` asks it to shut down over STOP_PIPE (see src/stop.ts).
 * Both use CHANNELCOLLAB_HOME (default %USERPROFILE%\.channelcollab).
 */
import { rmSync, writeFileSync } from 'node:fs';
import { Events, type Client } from 'discord.js';
import { DATA_DIR, loadConfig, PID_PATH, STOP_PIPE } from './config.js';
import { createBot } from './discord/bot.js';
import { controlHandlers } from './discord/control.js';
import { createControlServer } from './ipc/control.js';
import { log } from './log.js';
import { anyPending } from './router/queue.js';
import { closeAll } from './runner/pool.js';
import { pinGate } from './security/pin.js';
import { loadState } from './store/state.js';

/** After the sessions are closed, how long failed turns get to post their notice. */
const DRAIN_MS = 5000;

const config = loadConfig();
loadState();
log('start', `pid=${process.pid} home=${DATA_DIR} pipe=${STOP_PIPE} guild=${config.discord.guild_id ?? '-'} bound channels=${Object.keys(config.channels).join(', ') || '(none)'}`);

let client: Client | undefined;
// Also guards against a second instance: only one process can own the pipe.
const stopServer = createControlServer({
  async stop() {
    setImmediate(() => void shutdown('stop command'));
    return `stopping pid=${process.pid}`;
  },
  // `unlock` from the control script: clear the lock after too many wrong PINs (only this HOME's bot).
  async unlock() {
    const was = pinGate.locked;
    pinGate.reset();
    log('pin', was ? 'unlocked from the computer' : 'unlock requested (was not locked)');
    return was ? 'unlocked' : 'not-locked';
  },
  async 'pin-state'() {
    return pinGate.state();
  },
  // 0.1.8: report to a channel, list / take over / release conversations, hand one over (PLAN §21).
  ...controlHandlers(() => client),
});
await new Promise<void>((resolve) => {
  stopServer.once('error', (e) => {
    log('start', `cannot listen on ${STOP_PIPE} (${(e as NodeJS.ErrnoException).code}); is another bot running? exiting`);
    process.exit(1);
  });
  stopServer.listen(STOP_PIPE, resolve);
});

client = createBot();
client.once(Events.ClientReady, (c) => {
  writeFileSync(PID_PATH, String(process.pid), 'utf8');
  log('ready', `logged in as ${c.user.tag} id=${c.user.id} guilds=${c.guilds.cache.size}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('stop', signal);
  try {
    await closeAll();
    const deadline = Date.now() + DRAIN_MS;
    while (anyPending() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await client?.destroy();
  } catch (e) {
    log('stop', `error ${(e as Error).message}`);
  }
  rmSync(PID_PATH, { force: true });
  stopServer.close();
  log('stop', 'done');
  process.exit(0);
}
// SIGTERM never arrives from outside on Windows (taskkill / Stop-Process terminate outright); kept for other hosts.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
// A failure in one thread must not take the bot down.
process.on('unhandledRejection', (e) => log('error', `unhandled rejection: ${(e as Error)?.stack ?? e}`));
process.on('uncaughtException', (e) => log('error', `uncaught exception: ${e.stack ?? e}`));

await client.login(config.discord.token);
