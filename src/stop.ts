/**
 * `npm run stop`: asks the running bot to shut down (it closes every live
 * session and waits for their process trees), then waits for it to exit.
 * If it does not exit in time, its whole tree is ended with taskkill /T /F.
 * The PID comes from the bot's own answer, never from a possibly stale bot.pid.
 * Stops the bot of CHANNELCOLLAB_HOME (default %USERPROFILE%\.channelcollab).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { DATA_DIR, PID_PATH, STOP_PIPE } from './config.js';

const WAIT_MS = 60 * 1000;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ask(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(STOP_PIPE, () => socket.write('stop\n'));
    let answer = '';
    socket.on('data', (d) => (answer += d.toString()));
    socket.on('end', () => resolve(answer.trim()));
    socket.on('error', reject);
  });
}

let answer: string;
try {
  answer = await ask();
} catch (e) {
  console.log(`no bot answering on ${STOP_PIPE} for ${DATA_DIR} (${(e as NodeJS.ErrnoException).code})`);
  if (existsSync(PID_PATH)) {
    const pid = readFileSync(PID_PATH, 'utf8').trim();
    console.log(`${PID_PATH} says ${pid}; if that is a hung bot, end it with: taskkill /T /F /PID ${pid}`);
  }
  process.exit(1);
}
console.log(`bot: ${answer}`);
const pid = Number(/pid=(\d+)/.exec(answer)?.[1]);
if (!pid) process.exit(1);

const deadline = Date.now() + WAIT_MS;
while (running(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
if (running(pid)) {
  console.log(`pid ${pid} still running after ${WAIT_MS / 1000} s; taskkill /T /F`);
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'inherit' });
  } catch {
    // Already gone between the check and taskkill.
  }
  rmSync(PID_PATH, { force: true });
} else {
  console.log(`pid ${pid} exited`);
}
