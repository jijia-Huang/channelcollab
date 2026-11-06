/**
 * Control-pipe commands that need Discord (0.1.8, PLAN §21), used by the
 * control script on the same computer: `info`, `post`, `sessions`,
 * `takeover`, `release`, `handoff`, and (0.1.9) `working`. Every answer is a JSON object with `ok`.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from 'discord.js';
import { DATA_DIR, loadConfig, resolveDm } from '../config.js';
import { log } from '../log.js';
import type { ControlHandler } from '../ipc/control.js';
import { forbiddenPath } from '../security/zones.js';
import { boundTargets, postReport } from './post.js';
import { giveBack, handOff, sessionFolder, sessionRows, takeOver, workingRows } from './takeover.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Files the computer asked to attach: they must exist, be files, and stay out of the no-go zones (the bot's HOME holds its token). */
export function checkLocalFiles(files: unknown, zonesHome = DATA_DIR): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (typeof f !== 'string' || !f) continue;
    try {
      const real = realpathSync(path.resolve(f));
      const zone = forbiddenPath(real, path.dirname(real), { homes: [zonesHome], allow: [] });
      if (zone) rejected.push(`${f}：禁區（${zone}），不能附`);
      else if (!existsSync(real) || !statSync(real).isFile()) rejected.push(`${f}：不是檔案`);
      else ok.push(real);
    } catch {
      rejected.push(`${f}：找不到`);
    }
  }
  if (ok.length > 10) rejected.push(...ok.splice(10).map((f) => `${f}：一則訊息最多 10 個檔案`));
  return { ok, rejected };
}

export function controlHandlers(getClient: () => Client | undefined): Record<string, ControlHandler> {
  const ready = (): Client<true> => {
    const c = getClient();
    if (!c?.isReady()) throw new Error('Bot 還沒登入 Discord，請稍後再試');
    return c;
  };
  return {
    /** Who the bot is and where it can post: for the skills to list bots and channels. */
    async info() {
      const client = ready();
      const config = loadConfig();
      let dm = false;
      try {
        dm = !!resolveDm(config);
      } catch {}
      return { ok: true, bot: { tag: client.user.tag, id: client.user.id }, channels: boundTargets(client, config), dm };
    },
    async post(a) {
      const client = ready();
      const text = typeof a.text === 'string' ? a.text : '';
      const files = checkLocalFiles(a.files);
      if (files.rejected.length && !files.ok.length && !text.trim()) return { ok: false, error: files.rejected.join('；') };
      // A new thread continues from the computer's session; its folder comes from the session record (the shell may have cd'ed elsewhere).
      let sessionId = str(a.sessionId);
      let cwd = str(a.cwd);
      if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) {
        const info = await getSessionInfo(sessionId).catch(() => undefined);
        if (info) cwd = sessionFolder(info.cwd, cwd);
        else sessionId = undefined;
      }
      const r = await postReport(client, {
        channel: str(a.channel) ?? '',
        text,
        files: files.ok,
        thread: str(a.thread),
        newThread: str(a.newThread),
        source: { kind: 'cli' },
        // A new thread then continues from the computer's session (forked on its first trigger).
        ...(sessionId && cwd && /^[0-9a-f-]{36}$/i.test(sessionId) ? { forkFrom: { sessionId, cwd } } : {}),
      });
      log('control', `post ${r.ok ? `ok ${r.url}` : `failed: ${r.error}`}`);
      return { ...r, ...(files.rejected.length ? { rejected: files.rejected } : {}) };
    },
    /** Where Claude is working right now (0.1.9): stop and status list these. Needs no Discord login. */
    async working() {
      return { ok: true, working: workingRows() };
    },
    async sessions() {
      ready();
      return { ok: true, sessions: sessionRows(loadConfig()) };
    },
    async takeover(a) {
      const key = str(a.key);
      if (!key) return { ok: false, error: '要指定對話（討論串 ID 或 dm）' };
      return takeOver(ready(), key);
    },
    async release(a) {
      const key = str(a.key);
      if (!key) return { ok: false, error: '要指定對話（討論串 ID 或 dm）' };
      return giveBack(ready(), key, { sessionId: str(a.sessionId) });
    },
    async handoff(a) {
      const sessionId = str(a.sessionId);
      if (!sessionId) return { ok: false, error: '要給 session ID' };
      return handOff(ready(), { sessionId, cwd: str(a.cwd), target: str(a.target), title: str(a.title), summary: typeof a.summary === 'string' ? a.summary : undefined });
    },
  };
}
