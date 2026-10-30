/**
 * Entry point: `npm start` runs the bot (Phase 1: bot mode only) as a single
 * node process, so bot.pid is the root of the whole process tree.
 * `npm run stop` asks it to shut down over STOP_PIPE (see src/stop.ts).
 * Both use CHANNELCOLLAB_HOME (default %USERPROFILE%\.channelcollab).
 */
import { rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { Events } from 'discord.js';
import { DATA_DIR, loadConfig, PID_PATH, STOP_PIPE } from './config.js';
import { createBot } from './discord/bot.js';
import { log } from './log.js';
import { anyPending } from './router/queue.js';
import { closeAll } from './runner/pool.js';
import { loadState } from './store/state.js';

/** After the sessions are closed, how long failed turns get to post their notice. */
const DRAIN_MS = 5000;

const config = loadConfig();
loadState();
log('start', `pid=${process.pid} home=${DATA_DIR} pipe=${STOP_PIPE} guild=${config.discord.guild_id ?? '-'} bound channels=${Object.keys(config.channels).join(', ') || '(none)'}`);

// Also guards against a second instance: only one process can own the pipe.
const stopServer = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', (d) => {
    if (d.toString().trim() !== 'stop') return void socket.end('unknown command\n');
    socket.end(`stopping pid=${process.pid}\n`);
    void shutdown('stop command');
  });
});
await new Promise<void>((resolve) => {
  stopServer.once('error', (e) => {
    log('start', `cannot listen on ${STOP_PIPE} (${(e as NodeJS.ErrnoException).code}); is another bot running? exiting`);
    process.exit(1);
  });
  stopServer.listen(STOP_PIPE, resolve);
});

const client = createBot();
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
    await client.destroy();
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
