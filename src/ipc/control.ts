/**
 * The bot's control channel: the named pipe of its HOME (config.ts STOP_PIPE),
 * used by the control script on the same computer. One request per
 * connection, one line each way.
 *
 * - Plain words, as before 0.1.8: `stop`, `unlock`, `pin-state`.
 * - 0.1.8: a JSON object `{"cmd": "...", ...}` on one line (JSON keeps any
 *   newline in a report escaped), answered with one JSON line.
 *
 * The line is read up to its newline (a long report arrives in several
 * chunks). The pipe is only reachable by this Windows user's processes, the
 * same trust as the stop and unlock commands it always carried.
 */
import net from 'node:net';
import { log } from '../log.js';

/** A request longer than this is refused (reports are limited by Discord anyway). */
export const MAX_REQUEST_BYTES = 1024 * 1024;

export type ControlRequest = { cmd: string; args: Record<string, unknown> };
export type ControlHandler = (args: Record<string, unknown>) => Promise<string | object>;

/** A request line: a plain command word, or a JSON object with `cmd`. */
export function parseControlLine(line: string): ControlRequest | undefined {
  const text = line.trim();
  if (!text) return undefined;
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      if (o && typeof o === 'object' && typeof o.cmd === 'string') {
        const { cmd, ...args } = o;
        return { cmd: cmd as string, args };
      }
    } catch {}
    return undefined;
  }
  return /^[a-z][a-z-]*$/.test(text) ? { cmd: text, args: {} } : undefined;
}

export function createControlServer(handlers: Record<string, ControlHandler>): net.Server {
  return net.createServer((socket) => {
    socket.on('error', () => {});
    // Decode as a stream: a multi-byte character can be split between two chunks.
    socket.setEncoding('utf8');
    let buf = '';
    let done = false;
    socket.on('data', (d: string) => {
      if (done) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length < MAX_REQUEST_BYTES) return;
      done = true;
      const req = nl < 0 ? undefined : parseControlLine(buf.slice(0, nl));
      if (!req) return void socket.end(nl < 0 ? '{"ok":false,"error":"request too long"}\n' : 'unknown command\n');
      const h = handlers[req.cmd];
      if (!h) return void socket.end('unknown command\n');
      h(req.args)
        .then((r) => socket.end(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`))
        .catch((e: Error) => {
          log('control', `${req.cmd} failed: ${e.stack ?? e}`);
          socket.end(`${JSON.stringify({ ok: false, error: e.message })}\n`);
        });
    });
  });
}
