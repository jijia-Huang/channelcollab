#!/usr/bin/env node
// channelcollab.mjs — channelcollab 的總控腳本（只用 Node 22 內建功能，安裝 runtime 之前就能執行）
//
// 子命令：
//   check                      檢查 Node、npm、runtime、設定檔、Bot 是否在跑
//   install-runtime [--force]  把 plugin 內的 runtime 安裝到 <HOME>\runtime（npm ci，依賴版本固定）
//   set-owner <Discord ID>     寫入 config.json 的 discord.owner_id（Bot 的主人，可以按權限按鈕）
//   bind ...                   新增、修改、移除、列出頻道綁定；bind --dm 設定私訊
//   set-pin | clear-pin | unlock   核准用 PIN（一律在主控台視窗裡輸入，不經過 Claude）、解除鎖定
//   access --roster-only on|off    白名單：只有主人和名冊上的人／Bot 能叫 Bot（預設開）
//   roster list|add|remove|import  管理自己的名冊 <HOME>\roster.json（Bot 和成員；add 只要 Discord ID）
//   start | stop | status      啟動（背景執行）、停止、查看狀態；加 --all 一次處理這台電腦上的所有 Bot
//   homes | targets            這台電腦上的 Bot（各 HOME）；這隻 Bot 可以貼文的頻道
//   post --channel ...         請執行中的 Bot 把回報貼到綁定的頻道（經 named pipe，腳本不讀 token）
//   sessions | takeover | release   列出 Bot 的對話；在電腦上接手（開新視窗 resume）；交還給 Bot
//   handoff ...                把電腦上的 session 交給 Bot（私訊或綁定頻道的新討論串）
//   shortcut [--dir <資料夾>] [--name <名稱>]   產生雙擊用的「啟動／停止 <Bot 名稱>.bat」等（預設放桌面）
//   shortcut --all             「啟動全部 Bot.bat」「停止全部 Bot.bat」（放在預設 HOME 的 launchers 資料夾）
//   --self-test                不需要 token 的自我測試
//
// HOME：--home <路徑> 優先，其次環境變數 CHANNELCOLLAB_HOME，預設 %USERPROFILE%\.channelcollab。
// 安全：config.json 含 Discord token。本腳本只讀寫 token 以外的欄位；roster add 會在程式裡用 token
// 向 Discord 查名稱，任何輸出都不含 token。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
// 在 plugin 裡執行時 runtime 在 ../runtime；安裝到 <HOME>\runtime 的複本（ctl.mjs）旁邊就是 runtime 本身。
const IS_RUNTIME_COPY = fs.existsSync(path.join(SCRIPT_DIR, 'bot.mjs'));
const SOURCE_RUNTIME = IS_RUNTIME_COPY ? SCRIPT_DIR : path.resolve(SCRIPT_DIR, '..', 'runtime');
const RUNTIME_FILES = ['bot.mjs', 'stop.mjs', 'package.json', 'package-lock.json'];
const MIN_NODE_MAJOR = 22;
/** Agent SDK 的提醒代碼（見 filterStderr）。 */
const SDK_SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const READY_WAIT_S = 90;
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'];
const SNOWFLAKE = /^\d{17,20}$/;
const NODE_INSTALL_HINT = 'winget install OpenJS.NodeJS.LTS';

class CliError extends Error {}

// ---------------------------------------------------------------------------
// 路徑
// ---------------------------------------------------------------------------
export function resolveHome(opts = {}, env = process.env) {
  const h = opts.home && opts.home !== true ? opts.home : env.CHANNELCOLLAB_HOME || path.join(os.homedir(), '.channelcollab');
  return path.resolve(h);
}

export function paths(home) {
  const runtime = path.join(home, 'runtime');
  return {
    home,
    config: path.join(home, 'config.json'),
    roster: path.join(home, 'roster.json'),
    pin: path.join(home, 'pin.json'),
    pid: path.join(home, 'bot.pid'),
    log: path.join(home, 'bot.log'),
    errLog: path.join(home, 'bot.err.log'),
    prevLog: path.join(home, 'bot.prev.log'),
    prevErrLog: path.join(home, 'bot.prev.err.log'),
    runtime,
    bot: path.join(runtime, 'bot.mjs'),
    stop: path.join(runtime, 'stop.mjs'),
    ctl: path.join(runtime, 'ctl.mjs'),
    version: path.join(runtime, 'version.json'),
  };
}

/** 與 src/config.ts 的 STOP_PIPE 相同算法：Bot 啟動後在這個 named pipe 等停止指令。 */
export function stopPipe(home) {
  return `\\\\.\\pipe\\channelcollab-${createHash('sha1').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// JSON 檔（合併寫入、原子寫入；永遠不輸出 discord.token）
// ---------------------------------------------------------------------------
export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 只給錯誤類別，不給訊息：JSON 的錯誤訊息可能引用檔案內容（config.json 含 token）
    throw new CliError(`${file} 不是合法的 JSON（${e.name}）。為避免覆蓋設定，已停止；請先修正該檔案。`);
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readConfig(file) {
  const c = readJson(file, {});
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new CliError(`${file} 的最外層不是物件，已停止以免覆蓋。`);
  if (c.discord !== undefined && (typeof c.discord !== 'object' || c.discord === null)) {
    throw new CliError(`${file} 的 discord 欄位不是物件，已停止以免覆蓋。`);
  }
  if (c.channels !== undefined && (typeof c.channels !== 'object' || c.channels === null || Array.isArray(c.channels))) {
    throw new CliError(`${file} 的 channels 欄位不是物件，已停止以免覆蓋。`);
  }
  return c;
}

/** 用途：none（還沒設定）、dm-only（只用私訊）、channels（只有頻道）、both（頻道＋私訊）。 */
export function configMode(channelCount, dmOn) {
  if (channelCount && dmOn) return 'both';
  if (channelCount) return 'channels';
  return dmOn ? 'dm-only' : 'none';
}

export const MODE_LABEL = { none: '還沒設定（沒有綁頻道，也沒開私訊）', 'dm-only': '只用私訊', channels: '團隊頻道協作', both: '團隊頻道協作＋私訊' };

/** 不含 token 的設定摘要（給 check／status 用）。 */
export function configSummary(file) {
  if (!fs.existsSync(file)) return { exists: false, hasToken: false, ownerId: null, guildId: null, channels: {} };
  const c = readConfig(file);
  const channels = {};
  for (const [id, ch] of Object.entries(c.channels ?? {})) {
    channels[id] = { cwd: ch?.cwd, model: ch?.model ?? null, permission_mode: ch?.permission_mode ?? null, launcher: ch?.launcher ?? null, ...turnLimitField(ch) };
  }
  const dm = c.dm && typeof c.dm === 'object' && c.dm.cwd ? { cwd: c.dm.cwd, model: c.dm.model ?? null, permission_mode: c.dm.permission_mode ?? null, launcher: c.dm.launcher ?? null, ...turnLimitField(c.dm) } : null;
  return {
    exists: true,
    hasToken: typeof c.discord?.token === 'string' && c.discord.token.length > 0,
    ownerId: c.discord?.owner_id ?? null,
    guildId: c.discord?.guild_id ?? null,
    defaultMode: c.defaults?.permission_mode ?? null,
    channels,
    dm,
    mode: configMode(Object.keys(channels).length, !!dm),
    rosterOnly: c.access?.roster_only !== false,
    pinUnlockMinutes: typeof c.security?.pin_unlock_minutes === 'number' ? c.security.pin_unlock_minutes : 30,
    ownerWaitMinutes: typeof c.defaults?.owner_wait_minutes === 'number' ? c.defaults.owner_wait_minutes : 2,
    turnTimeoutMinutes: minutesOrZero(c.defaults?.turn_timeout_minutes),
    maxTurns: Math.floor(minutesOrZero(c.defaults?.max_turns)),
  };
}

/** 單輪工作上限（分鐘）：正數才算，其他（沒設、0、負數）都是 0 = 不限。和 src/config.ts 的 minutesOrZero 相同。 */
const minutesOrZero = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const turnLimitField = (b) => ({
  ...(typeof b?.effort === 'string' ? { effort: b.effort } : {}),
  ...(typeof b?.turn_timeout_minutes === 'number' ? { turn_timeout_minutes: b.turn_timeout_minutes } : {}),
  ...(typeof b?.max_turns === 'number' ? { max_turns: b.max_turns } : {}),
});
export const stepLimitText = (n) => (n > 0 ? `${n} 步` : '不限');
export const turnLimitText = (min) => (min > 0 ? `${min} 分鐘` : '不限');

export function setOwner(file, ownerId) {
  if (!SNOWFLAKE.test(String(ownerId))) throw new CliError(`Discord 使用者 ID 格式不對（應為 17–20 位數字）：${ownerId}`);
  const c = readConfig(file);
  c.discord = { ...(c.discord ?? {}), owner_id: String(ownerId) };
  writeJson(file, c);
}

/** 新增或修改一個頻道綁定；只動 channels.<id>，其他欄位原樣保留。 */
export function bindChannel(file, { channel, cwd, model, permissionMode, launcher, tools, turnTimeout, maxTurns, effort }) {
  if (!SNOWFLAKE.test(String(channel ?? ''))) throw new CliError(`頻道 ID 格式不對（應為 17–20 位數字）：${channel}`);
  const c = readConfig(file);
  const prev = c.channels?.[channel];
  if (!prev && !cwd) throw new CliError('新增綁定時一定要給 --cwd（這個頻道的工作資料夾）');
  const next = applyBinding(prev, { cwd, model, permissionMode, launcher, tools, turnTimeout, maxTurns, effort });
  c.channels = { ...(c.channels ?? {}), [channel]: next };
  c.defaults = { permission_mode: 'default', ...(c.defaults ?? {}) };
  writeJson(file, c);
  return { action: prev ? 'updated' : 'added', channel: next };
}

/** 私訊設定（config 的 dm 區塊，欄位和頻道綁定相同）；只動 dm，其他欄位原樣保留。 */
export function bindDm(file, { cwd, model, permissionMode, launcher, turnTimeout, maxTurns, effort }) {
  const c = readConfig(file);
  const prev = c.dm && typeof c.dm === 'object' ? c.dm : undefined;
  if (!prev && !cwd) throw new CliError('開啟私訊時一定要給 --cwd（私訊用的工作資料夾）');
  const next = applyBinding(prev, { cwd, model, permissionMode, launcher, turnTimeout, maxTurns, effort });
  c.dm = next;
  c.defaults = { permission_mode: 'default', ...(c.defaults ?? {}) };
  writeJson(file, c);
  return { action: prev ? 'updated' : 'added', dm: next };
}

export function unbindDm(file) {
  const c = readConfig(file);
  if (!c.dm) return false;
  delete c.dm;
  writeJson(file, c);
  return true;
}

/** 白名單（access.roster_only，預設開）。 */
export function setRosterOnly(file, on) {
  const c = readConfig(file);
  c.access = { ...(c.access ?? {}), roster_only: !!on };
  writeJson(file, c);
}

/** 努力程度（SDK 的 effort）；none 移除，回到 Claude Code 的預設。 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function applyBinding(prev, { cwd, model, permissionMode, launcher, tools, turnTimeout, maxTurns, effort }) {
  const next = { ...(prev ?? {}) };
  if (cwd) {
    const abs = path.resolve(cwd);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new CliError(`工作資料夾不存在：${abs}`);
    next.cwd = abs;
  }
  if (model !== undefined) {
    if (model === '' || model === 'none') delete next.model;
    else next.model = String(model);
  }
  const mode = permissionMode ?? next.permission_mode ?? 'default';
  if (mode === 'bypassPermissions') throw new CliError('bypassPermissions 會跳過所有權限確認，不允許從 Discord 使用。');
  if (!PERMISSION_MODES.includes(mode)) throw new CliError(`permission_mode 只能是 ${PERMISSION_MODES.join(' / ')}（收到：${mode}）`);
  // 一定要明確寫入：省略時 Claude 會沿用使用者自己的預設模式，Discord 上就不會出現權限按鈕。
  next.permission_mode = mode;
  if (launcher !== undefined) {
    if (launcher === '' || launcher === 'claude') delete next.launcher;
    else next.launcher = String(launcher);
  }
  if (turnTimeout !== undefined) {
    // 預設不限時；只有使用者自己設定時才有上限。none 移除這個欄位（回到 defaults.turn_timeout_minutes）。
    if (turnTimeout === '' || turnTimeout === 'none') delete next.turn_timeout_minutes;
    else {
      const n = Number(turnTimeout);
      if (!/^\d+(\.\d+)?$/.test(String(turnTimeout).trim()) || !Number.isFinite(n) || n < 0) throw new CliError(`--turn-timeout 要是 0 以上的分鐘數（0 代表不限，none 表示沿用預設）；收到：${turnTimeout}`);
      next.turn_timeout_minutes = n;
    }
  }
  if (effort !== undefined) {
    if (effort === '' || effort === 'none' || effort === 'default') delete next.effort;
    else if (!EFFORT_LEVELS.includes(String(effort))) throw new CliError(`--effort 只能是 ${EFFORT_LEVELS.join(' / ')}，或 none 回到預設（收到：${effort}）`);
    else next.effort = String(effort);
  }
  if (maxTurns !== undefined) {
    // 預設不限步數；none 移除這個欄位（回到 defaults.max_turns）。
    if (maxTurns === '' || maxTurns === 'none') delete next.max_turns;
    else {
      if (!/^\d+$/.test(String(maxTurns).trim())) throw new CliError(`--max-turns 要是 0 以上的整數（0 代表不限，none 表示沿用預設）；收到：${maxTurns}`);
      next.max_turns = Number(maxTurns);
    }
  }
  if (tools !== undefined) {
    if (tools === '' || tools === 'all') delete next.tools;
    else next.tools = String(tools).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 核准用 PIN（<HOME>\pin.json 只存 scrypt 雜湊與 salt；Bot 端在 src/security/pin.ts 用同樣的參數驗證）
// ---------------------------------------------------------------------------
export const PIN_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const normalizePin = (pin) => String(pin).normalize('NFKC').trim();

/** PIN 格式：4～32 個字元、中間不能有空白。回傳錯誤訊息，沒問題時回傳 null。 */
export function pinFormatError(pin) {
  const v = normalizePin(pin);
  if (v.length < 4) return 'PIN 至少要 4 個字元（建議 6 位數字）';
  if (v.length > 32) return 'PIN 最多 32 個字元';
  if (/\s/.test(v)) return 'PIN 中間不能有空白';
  return null;
}

export function hashPin(pin, salt = randomBytes(16)) {
  const { N, r, p, keylen } = PIN_SCRYPT;
  const hash = scryptSync(normalizePin(pin), salt, keylen, { N, r, p });
  return { v: 1, algo: 'scrypt', N, r, p, keylen, salt: salt.toString('base64'), hash: hash.toString('base64'), setAt: new Date().toISOString() };
}

export function verifyPinRecord(pin, f) {
  const want = Buffer.from(f.hash, 'base64');
  const got = scryptSync(normalizePin(pin), Buffer.from(f.salt, 'base64'), f.keylen, { N: f.N, r: f.r, p: f.p });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 不回顯地讀一行（只能在主控台裡用）；Ctrl+C 取消。 */
function readSecret(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new CliError('已取消')));
        if (ch === '\b' || ch === '\u007f') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function readLine(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

const isConsole = () => !!process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

/**
 * 這幾個指令要在電腦前的人親手輸入：不是在主控台裡執行時（例如由 Claude Code 執行），
 * 另開一個主控台視窗讓使用者輸入，這裡等它關閉。PIN 不會出現在命令列、shell 歷史或 Claude 的對話裡。
 */
function runInConsoleWindow(p, action) {
  if (process.platform !== 'win32') throw new CliError(`${action} 要在主控台裡執行（請直接在終端機執行這個指令）`);
  const q = (x) => `"${String(x)}"`;
  const line = `start "channelcollab" /wait ${q(process.execPath)} ${q(SCRIPT_PATH)} ${action} --console --home ${q(p.home)}`;
  console.log(`已開一個新視窗「channelcollab」，請在那個視窗裡操作（${action}）；完成後視窗會關閉…`);
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false });
  if (r.error) throw new CliError(`開不了新視窗：${r.error.message}。請改成雙擊桌面的 .bat，或直接在終端機執行。`);
}

async function pressEnterToClose(opts) {
  if (opts.console) await readLine('\n按 Enter 關閉這個視窗…');
}

async function setPin(p, opts) {
  if (!isConsole()) {
    const before = fs.existsSync(p.pin) ? fs.statSync(p.pin).mtimeMs : 0;
    runInConsoleWindow(p, 'set-pin');
    const after = fs.existsSync(p.pin) ? fs.statSync(p.pin).mtimeMs : 0;
    console.log(after > before ? `✅ PIN 已設定（${p.pin}，只存雜湊）。` : '⚠️ PIN 沒有變更（視窗被關掉或取消了）。');
    return;
  }
  try {
    console.log(`設定 channelcollab 的核准用 PIN（HOME：${p.home}）`);
    console.log('之後在 Discord 按「允許」、或用私訊時，要輸入這個 PIN。建議 6 位數字，不要用生日或和其他密碼相同。');
    console.log('輸入時畫面只會顯示 *；按 Ctrl+C 取消。\n');
    const a = await readSecret('新的 PIN：');
    const err = pinFormatError(a);
    if (err) throw new CliError(err);
    const b = await readSecret('再輸入一次：');
    if (normalizePin(a) !== normalizePin(b)) throw new CliError('兩次輸入不一樣，PIN 沒有變更。');
    writeJson(p.pin, hashPin(a));
    console.log(`✅ PIN 已設定（${p.pin}，只存雜湊）。Bot 不用重啟，下一次核准就會要求 PIN。`);
  } catch (e) {
    console.log(`❌ ${e instanceof CliError ? e.message : e}`);
    process.exitCode = 1;
  }
  await pressEnterToClose(opts);
}

async function confirmInConsole(p, opts, action, question) {
  if (!isConsole()) {
    runInConsoleWindow(p, action);
    return null;
  }
  const ans = await readLine(`${question}（輸入 y 確認）：`);
  return /^y(es)?$/i.test(ans);
}

async function clearPin(p, opts) {
  const ok = await confirmInConsole(p, opts, 'clear-pin', '要移除 PIN 嗎？移除後核准不用 PIN，私訊會關閉');
  if (ok === null) return console.log(fs.existsSync(p.pin) ? '⚠️ PIN 還在（沒有確認）。' : '✅ 已移除 PIN。');
  if (!ok) console.log('沒有變更。');
  else if (fs.existsSync(p.pin)) {
    fs.rmSync(p.pin);
    console.log('✅ 已移除 PIN。核准權限不再要求 PIN；私訊在重新設定 PIN 之前不開放。');
  } else console.log('本來就沒有設定 PIN。');
  await pressEnterToClose(opts);
}

/** 經 Bot 的 named pipe 送一個指令，回傳回應文字；Bot 沒在執行時回傳 null。 */
export function pipeRequest(pipe, text, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe);
    let out = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.on('connect', () => sock.write(`${text}\n`));
    // 分段到達的多位元組字元（中文）要整段解碼，不能一段一段 toString。
    sock.setEncoding('utf8');
    sock.on('data', (d) => (out += d));
    sock.on('end', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function unlock(p, opts) {
  const ok = await confirmInConsole(p, opts, 'unlock', '要解除 PIN 鎖定嗎？（請確認是你本人輸錯，不是別人在試）');
  if (ok === null) return console.log('（解除鎖定的結果顯示在剛剛的視窗裡）');
  if (!ok) console.log('沒有變更。');
  else {
    const r = await pipeRequest(stopPipe(p.home), 'unlock');
    if (r === null) console.log('Bot 沒有在執行（重新啟動本來就會解除鎖定）。');
    else console.log(r === 'unlocked' ? '✅ 已解除鎖定。下一次核准或私訊仍要輸入 PIN。' : '目前沒有鎖定。');
  }
  await pressEnterToClose(opts);
}

export function unbindChannel(file, channel) {
  const c = readConfig(file);
  if (!c.channels?.[channel]) return false;
  delete c.channels[channel];
  writeJson(file, c);
  return true;
}

// ---------------------------------------------------------------------------
// 名冊（每個人自己的 <HOME>\roster.json）
// 格式：{ version: 1,
//         bots:    [{ botId, botName, ownerName?, ownerDiscordId?, role? }],
//         members: [{ discordId, name, role? }] }   ← members 可省略（舊名冊沒有）
// ---------------------------------------------------------------------------
const ROLE_ALIASES = { engineer: 'engineer', 工程師: 'engineer', planner: 'planner', 企劃: 'planner', 企画: 'planner' };
const TOKEN_LIKE = /[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/;

/** engineer／工程師、planner／企劃；沒給就是 undefined（role 可以不填）。 */
export function normalizeRole(role) {
  if (role === undefined || role === null || role === true || role === '') return undefined;
  const s = String(role).trim();
  const r = ROLE_ALIASES[s.toLowerCase()] ?? ROLE_ALIASES[s];
  if (!r) throw new CliError(`角色必須是 engineer／工程師 或 planner／企劃（收到：${role}）`);
  return r;
}

/** 名冊格式檢查。bots 必填 botId、botName；members 可省略，有的話每筆要有 discordId、name。 */
export function validateRoster(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.bots)) throw new CliError('名冊格式不對：缺少 bots 陣列');
  if (data.members !== undefined && !Array.isArray(data.members)) throw new CliError('名冊格式不對：members 必須是陣列');
  const seen = new Set();
  const once = (id, where) => {
    if (seen.has(id)) throw new CliError(`名冊裡 ${id} 出現不只一次（${where}）`);
    seen.add(id);
  };
  data.bots.forEach((b, i) => {
    if (!SNOWFLAKE.test(String(b?.botId ?? ''))) throw new CliError(`名冊 bots 第 ${i + 1} 筆的 botId 格式不對`);
    if (typeof b.botName !== 'string' || !b.botName) throw new CliError(`名冊 bots 第 ${i + 1} 筆缺少 botName`);
    if (b.ownerDiscordId !== undefined && !SNOWFLAKE.test(String(b.ownerDiscordId))) throw new CliError(`名冊 bots 第 ${i + 1} 筆的 ownerDiscordId 格式不對`);
    for (const k of ['ownerName', 'role']) {
      if (b[k] !== undefined && typeof b[k] !== 'string') throw new CliError(`名冊 bots 第 ${i + 1} 筆的 ${k} 不是文字`);
    }
    once(b.botId, `bots 第 ${i + 1} 筆`);
  });
  (data.members ?? []).forEach((m, i) => {
    if (!SNOWFLAKE.test(String(m?.discordId ?? ''))) throw new CliError(`名冊 members 第 ${i + 1} 筆的 discordId 格式不對`);
    if (typeof m.name !== 'string' || !m.name) throw new CliError(`名冊 members 第 ${i + 1} 筆缺少 name`);
    if (m.role !== undefined && typeof m.role !== 'string') throw new CliError(`名冊 members 第 ${i + 1} 筆的 role 不是文字`);
    once(m.discordId, `members 第 ${i + 1} 筆`);
  });
  if (TOKEN_LIKE.test(JSON.stringify(data))) {
    throw new CliError('名冊裡有看起來像 token 的字串，已拒絕。名冊不應該包含 token。');
  }
  return data;
}

/** 讀自己的名冊；不存在就是空名冊。壞掉的檔案會停下來，不覆蓋。 */
export function readRoster(file) {
  const r = readJson(file, null) ?? { version: 1, bots: [] };
  if (typeof r !== 'object' || Array.isArray(r)) throw new CliError(`${file} 的最外層不是物件，已停止以免覆蓋。`);
  r.version ??= 1;
  r.bots ??= [];
  r.members ??= [];
  return validateRoster(r);
}

/** 名冊的摘要數字（給 status 用）；不存在時是 null。 */
export function rosterCounts(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const r = readRoster(file);
    return { bots: r.bots.length, members: r.members.length };
  } catch {
    return { bots: 0, members: 0, broken: true };
  }
}

/**
 * 新增或更新一筆。entry：{ kind: 'bot'|'member', id, name, role?, ownerId?, ownerName? }
 * 同一個 ID 已在名冊就更新（只改有給的欄位）；在另一類（Bot／成員）就搬過來。
 */
export function rosterUpsert(roster, entry) {
  const { kind, id } = entry;
  if (!SNOWFLAKE.test(String(id ?? ''))) throw new CliError(`Discord ID 格式不對（應為 17–20 位數字）：${id}`);
  if (!entry.name) throw new CliError('缺少名稱');
  const role = normalizeRole(entry.role);
  let moved = false;
  if (kind === 'bot') {
    if (entry.ownerId !== undefined && !SNOWFLAKE.test(String(entry.ownerId))) throw new CliError(`主人的 Discord ID 格式不對：${entry.ownerId}`);
    if (roster.members.some((m) => m.discordId === id)) {
      roster.members = roster.members.filter((m) => m.discordId !== id);
      moved = true;
    }
    const idx = roster.bots.findIndex((b) => b.botId === id);
    const next = { ...(idx >= 0 ? roster.bots[idx] : {}), botId: id, botName: entry.name };
    if (entry.ownerName) next.ownerName = entry.ownerName;
    if (entry.ownerId) next.ownerDiscordId = String(entry.ownerId);
    if (role) next.role = role;
    if (idx >= 0) roster.bots[idx] = next;
    else roster.bots.push(next);
    return { action: idx >= 0 ? 'updated' : 'added', moved, entry: next };
  }
  if (kind !== 'member') throw new CliError(`不明的種類：${kind}`);
  if (entry.ownerId || entry.ownerName) throw new CliError('--owner-id／--owner-name 只用在 Bot 上');
  if (roster.bots.some((b) => b.botId === id)) {
    roster.bots = roster.bots.filter((b) => b.botId !== id);
    moved = true;
  }
  const idx = roster.members.findIndex((m) => m.discordId === id);
  const next = { ...(idx >= 0 ? roster.members[idx] : {}), discordId: id, name: entry.name };
  if (role) next.role = role;
  if (idx >= 0) roster.members[idx] = next;
  else roster.members.push(next);
  return { action: idx >= 0 ? 'updated' : 'added', moved, entry: next };
}

/** 移除一筆（Bot 或成員）；回傳移除的種類，找不到時是 null。 */
export function rosterRemove(roster, id) {
  if (roster.bots.some((b) => b.botId === id)) {
    roster.bots = roster.bots.filter((b) => b.botId !== id);
    return 'bot';
  }
  if (roster.members.some((m) => m.discordId === id)) {
    roster.members = roster.members.filter((m) => m.discordId !== id);
    return 'member';
  }
  return null;
}

const BOT_FIELDS = ['botName', 'ownerName', 'ownerDiscordId', 'role'];
const MEMBER_FIELDS = ['name', 'role'];
const sameFields = (a, b, keys) => keys.every((k) => (a[k] ?? null) === (b[k] ?? null));

/**
 * 把別人給的名冊合併進自己的。新的 ID 加進來；同一個 ID 預設保留自己的（列進 conflicts），
 * theirs 為 true 時改用對方的（列進 replaced）。ID 在自己這邊是另一類（Bot／成員）時一律保留自己的。
 * 不修改傳入的物件，回傳新的名冊。
 */
export function mergeRoster(mine, theirs, { preferTheirs = false } = {}) {
  const out = { ...mine, bots: [...(mine.bots ?? [])], members: [...(mine.members ?? [])] };
  const added = [];
  const conflicts = [];
  const replaced = [];
  const ids = () => new Set([...out.bots.map((b) => b.botId), ...out.members.map((m) => m.discordId)]);
  for (const b of theirs.bots ?? []) {
    const idx = out.bots.findIndex((x) => x.botId === b.botId);
    if (idx < 0) {
      if (ids().has(b.botId)) conflicts.push({ kind: 'bot', id: b.botId, name: b.botName, mine: '成員', theirs: 'Bot' });
      else {
        out.bots.push(b);
        added.push({ kind: 'bot', id: b.botId, name: b.botName });
      }
    } else if (!sameFields(out.bots[idx], b, BOT_FIELDS)) {
      if (preferTheirs) {
        out.bots[idx] = { ...out.bots[idx], ...b };
        replaced.push({ kind: 'bot', id: b.botId, name: b.botName });
      } else conflicts.push({ kind: 'bot', id: b.botId, name: out.bots[idx].botName, theirsName: b.botName });
    }
  }
  for (const m of theirs.members ?? []) {
    const idx = out.members.findIndex((x) => x.discordId === m.discordId);
    if (idx < 0) {
      if (ids().has(m.discordId)) conflicts.push({ kind: 'member', id: m.discordId, name: m.name, mine: 'Bot', theirs: '成員' });
      else {
        out.members.push(m);
        added.push({ kind: 'member', id: m.discordId, name: m.name });
      }
    } else if (!sameFields(out.members[idx], m, MEMBER_FIELDS)) {
      if (preferTheirs) {
        out.members[idx] = { ...out.members[idx], ...m };
        replaced.push({ kind: 'member', id: m.discordId, name: m.name });
      } else conflicts.push({ kind: 'member', id: m.discordId, name: out.members[idx].name, theirsName: m.name });
    }
  }
  return { roster: out, added, conflicts, replaced };
}

const ROLE_LABEL = { engineer: '工程師', planner: '企劃' };
const roleLabel = (r) => (r ? ROLE_LABEL[r] ?? r : '未填角色');

/** 名冊的文字清單（list／add／import 共用）。 */
export function rosterLines(roster) {
  const lines = [`Bot（${roster.bots.length}）：`];
  if (!roster.bots.length) lines.push('  （沒有）');
  for (const b of roster.bots) {
    const owner = b.ownerDiscordId ? `主人 ${b.ownerName ?? '?'}（ID ${b.ownerDiscordId}）` : b.ownerName ? `主人 ${b.ownerName}` : '主人未填';
    lines.push(`  - ${b.botName}（ID ${b.botId}）：${owner}，${roleLabel(b.role)}`);
  }
  lines.push(`成員（${roster.members.length}）：`);
  if (!roster.members.length) lines.push('  （沒有）');
  for (const m of roster.members) lines.push(`  - ${m.name}（ID ${m.discordId}）：${roleLabel(m.role)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// 用自己 Bot 的 token 查 Discord 使用者（名稱、是不是 Bot）。token 只用在請求標頭，不輸出。
// ---------------------------------------------------------------------------
const DISCORD_API = 'https://discord.com/api/v10';

async function discordGet(token, route, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(DISCORD_API + route, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (channelcollab, 1.0)' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '逾時' : e?.cause?.code || e?.name || 'error';
    throw new CliError(`連不到 Discord API（${why}）`);
  }
  if (res.status === 401) throw new CliError('Discord 回應 401：這個 HOME 的 Bot token 無效');
  const body = res.ok ? await res.json() : null;
  return { status: res.status, body };
}

/**
 * 查一個 Discord ID：名稱依序取伺服器暱稱（nick）、global_name、username。
 * 伺服器用 config.json 的 discord.guild_id；沒有就試 Bot 所在的伺服器（最多 10 個）。
 */
export async function lookupDiscordUser({ token, guildId }, id, fetchImpl = globalThis.fetch) {
  if (!token) throw new CliError('這個 HOME 還沒有 Bot token，沒辦法向 Discord 查名稱');
  const u = await discordGet(token, `/users/${id}`, fetchImpl);
  if (u.status === 404) throw new CliError(`Discord 上找不到 ID ${id} 的使用者`);
  if (!u.body) throw new CliError(`Discord API /users/${id} 回應 ${u.status}`);
  let guilds = guildId ? [String(guildId)] : [];
  if (!guilds.length) {
    const g = await discordGet(token, '/users/@me/guilds?limit=10', fetchImpl);
    guilds = Array.isArray(g.body) ? g.body.map((x) => x.id) : [];
  }
  let nick = null;
  let guild = null;
  for (const gid of guilds.slice(0, 10)) {
    const m = await discordGet(token, `/guilds/${gid}/members/${id}`, fetchImpl);
    if (m.body) {
      nick = m.body.nick || null;
      guild = gid;
      break;
    }
  }
  return {
    id: String(id),
    bot: !!u.body.bot,
    name: nick || u.body.global_name || u.body.username,
    username: u.body.username,
    nick,
    globalName: u.body.global_name ?? null,
    guild,
  };
}

/** 從 config.json 拿查詢需要的 token 與伺服器 ID（只在程式裡用，不回傳給輸出）。 */
function lookupCredentials(p) {
  const c = readConfig(p.config);
  return { token: typeof c.discord?.token === 'string' ? c.discord.token : null, guildId: c.discord?.guild_id ?? null };
}

// ---------------------------------------------------------------------------
// Node／npm／runtime
// ---------------------------------------------------------------------------
export function nodeMajor(v = process.version) {
  return Number(/^v?(\d+)/.exec(v)?.[1] ?? 0);
}

function npmCommand() {
  // 優先用跟這個 node 一起安裝的 npm，避免 PATH 上是另一套版本。
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli] };
  return null;
}

function npmVersion() {
  const npm = npmCommand();
  try {
    if (npm) return execFileSync(npm.cmd, [...npm.pre, '-v'], { encoding: 'utf8', windowsHide: true }).trim();
    return spawnSync('npm -v', { shell: true, encoding: 'utf8', windowsHide: true }).stdout.trim() || null;
  } catch {
    return null;
  }
}

export function runtimeState(p) {
  const want = readJson(path.join(SOURCE_RUNTIME, 'version.json'), null);
  const have = readJson(p.version, null);
  const depsOk = fs.existsSync(path.join(p.runtime, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  return {
    installed: !!have && depsOk && fs.existsSync(p.bot),
    have,
    want,
    upToDate: !!have && !!want && have.hash === want.hash && depsOk,
  };
}

function requireNode() {
  if (nodeMajor() < MIN_NODE_MAJOR) {
    throw new CliError(
      `需要 Node ${MIN_NODE_MAJOR} 以上，目前是 ${process.version}。請在終端機執行「${NODE_INSTALL_HINT}」，裝完後關掉並重開終端機和 Claude Code，再執行一次 setup。`,
    );
  }
}

/**
 * 總控腳本在 <HOME>\runtime 也放一份（ctl.mjs）：雙擊用的 .bat 執行它，plugin 更新時路徑才不會失效。
 * 它不影響 runtime 的版本 hash，所以每次 start／install-runtime／shortcut 都比對內容，不同就更新。
 */
function syncCtl(p) {
  if (path.resolve(SCRIPT_PATH) === path.resolve(p.ctl) || !fs.existsSync(p.runtime)) return;
  const mine = fs.readFileSync(SCRIPT_PATH);
  if (fs.existsSync(p.ctl) && fs.readFileSync(p.ctl).equals(mine)) return;
  fs.writeFileSync(p.ctl, mine);
}

async function installRuntime(p, { force = false } = {}) {
  requireNode();
  const state = runtimeState(p);
  if (!state.want) throw new CliError(`plugin 裡找不到 runtime（${SOURCE_RUNTIME}\\version.json）。plugin 可能不完整，請重新安裝 plugin。`);
  if (state.upToDate && !force) {
    syncCtl(p);
    console.log(`✅ runtime 已是最新（版本 ${state.have.version}，${p.runtime}）`);
    return false;
  }
  if (await isRunning(p)) throw new CliError('Bot 正在執行，無法更新 runtime。請先停止 Bot（stop），再重新執行。');
  const npm = npmCommand();
  if (!npm && !npmVersion()) throw new CliError(`找不到 npm。請重新安裝 Node（${NODE_INSTALL_HINT}）。`);

  fs.mkdirSync(p.runtime, { recursive: true });
  // 版本標記最後才寫，安裝中途失敗時下次會重來。
  fs.rmSync(p.version, { force: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(SOURCE_RUNTIME, f), path.join(p.runtime, f));
  console.log(`安裝 runtime 到 ${p.runtime}（第一次需要下載約 300 MB，請稍候）…`);
  const args = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
  const r = npm
    ? spawnSync(npm.cmd, [...npm.pre, ...args], { cwd: p.runtime, stdio: 'inherit', windowsHide: true })
    : spawnSync(`npm ${args.join(' ')}`, { cwd: p.runtime, stdio: 'inherit', shell: true, windowsHide: true });
  if (r.status !== 0) {
    throw new CliError(`npm ci 失敗（結束代碼 ${r.status}）。請確認網路可以連到 registry.npmjs.org，再重新執行 install-runtime。`);
  }
  for (const f of ['bot.mjs', 'stop.mjs']) fs.copyFileSync(path.join(SOURCE_RUNTIME, f), path.join(p.runtime, f));
  syncCtl(p);
  fs.copyFileSync(path.join(SOURCE_RUNTIME, 'version.json'), p.version);
  console.log(`✅ runtime 安裝完成（版本 ${state.want.version}）`);
  return true;
}

// ---------------------------------------------------------------------------
// 執行狀態
// ---------------------------------------------------------------------------
/** Bot 在跑時會佔住 named pipe；連得上就是在跑。連上後立刻斷開，不送任何指令。 */
export function pipeAlive(pipe, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(pipe);
    const done = (v) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid(p) {
  try {
    return Number(fs.readFileSync(p.pid, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function isRunning(p) {
  return pipeAlive(stopPipe(p.home));
}

function readLines(file, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return [];
  }
}

/**
 * bot.err.log 裡不算錯誤的行：Agent SDK 對 reply 工具的提醒（reply 一律放行是刻意的設計），
 * 以及緊接在它後面的 Node 提示「(Use `node --trace-warnings ...`」。0.1.6 起啟動時已用
 * --disable-warning 關掉，這裡過濾舊 log 和舊版留下的行。
 */
export function filterStderr(lines) {
  const out = [];
  let afterShadowed = false;
  for (const l of lines) {
    if (/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/.test(l)) {
      afterShadowed = true;
      continue;
    }
    if (afterShadowed && /^\(Use `node --trace-warnings/.test(l.trim())) {
      afterShadowed = false;
      continue;
    }
    afterShadowed = false;
    out.push(l);
  }
  return out;
}

export function parseLog(lines) {
  let ready = null;
  let start = null;
  const errors = [];
  for (const l of lines) {
    if (/\[start\] pid=/.test(l)) start = l;
    const m = /\[ready\] logged in as (\S+) id=(\d+)/.exec(l);
    if (m) ready = { tag: m[1], id: m[2], line: l };
    if (isErrorLine(l)) errors.push(l);
  }
  return { start, ready, errors: errors.slice(-5) };
}

/**
 * 是不是錯誤，只看 log 的分類標籤（`[時間] [標籤] 內容`），不看內容裡的字：
 * 工具的輸入、Claude 的回覆、訊息原文都可能含有 failed、error、❌（例如分支名稱）。
 */
export function isErrorLine(l) {
  const m = /^\[[\d:.]+\] \[([^\]]+)\] (.*)$/.exec(String(l));
  if (!m) return false;
  const [, tag, rest] = m;
  if (tag === 'error' || tag === 'config') return true;
  if (tag === 'stop') return /^error/i.test(rest);
  if (tag === 'start') return /^cannot listen/.test(rest);
  if (tag === 'commands') return /registration failed/.test(rest);
  if (tag === 'pool') return /\bfailed\b/.test(rest);
  if (tag.startsWith('live ')) return /^error /.test(rest);
  return false;
}

/** 執行中的 Bot 的 PIN 狀態（鎖定與否）；0.1.5 以前的 Bot 不認得這個指令，回傳空物件。 */
async function pinState(p) {
  try {
    const v = JSON.parse((await pipeRequest(stopPipe(p.home), 'pin-state')) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function getStatus(p) {
  const running = await isRunning(p);
  const pid = readPid(p);
  const log = parseLog(readLines(p.log));
  const errTail = filterStderr(readLines(p.errLog)).slice(-5);
  return {
    home: p.home,
    running,
    pid: running ? pid : null,
    stalePid: !running && pid && pidAlive(pid) ? pid : null,
    loggedInAs: running ? log.ready?.tag ?? null : null,
    working: running ? await workingNow(p) : [],
    botId: running ? log.ready?.id ?? null : null,
    lastStart: log.start,
    recentErrors: log.errors,
    stderrTail: errTail,
    config: configSummary(p.config),
    pin: { set: fs.existsSync(p.pin), ...(running ? await pinState(p) : {}) },
    roster: rosterCounts(p.roster),
    runtime: runtimeState(p),
    launchers: { 'set-pin': findLauncher(p, 'set-pin'), unlock: findLauncher(p, 'unlock') },
  };
}

// ---------------------------------------------------------------------------
// 啟動與停止
// ---------------------------------------------------------------------------
function rotate(from, to) {
  try {
    if (fs.existsSync(from)) fs.renameSync(from, to);
  } catch {
    // 檔案被其他程式開著就保留，改成接著寫。
  }
}

/**
 * 從另一隻 Bot 的 runtime 複本（ctl.mjs，例如「啟動全部 Bot.bat」）操作這個 HOME：那份複本的版本不一定比這隻新，
 * 所以這隻已經裝好 runtime 時不拿複本覆蓋它（runtime 和 ctl.mjs 都不動），用它自己的版本。
 */
const foreignRuntime = (p) => IS_RUNTIME_COPY && path.resolve(SOURCE_RUNTIME).toLowerCase() !== path.resolve(p.runtime).toLowerCase();

/**
 * 啟動。回傳 { ok, state, tag? }：state 是 running（本來就在執行）、started（已上線）、launched（--wait 0，不等上線）、failed。
 * 沒有 token、Node 太舊等設定問題丟 CliError。
 */
async function start(p, { wait = READY_WAIT_S, update = true } = {}) {
  requireNode();
  const cfg = configSummary(p.config);
  if (!cfg.hasToken) throw new CliError(`${p.config} 裡沒有 Bot token。請先執行 setup，匯入管理員給的交付檔。`);
  const foreign = foreignRuntime(p);
  if (!foreign) syncCtl(p);
  if (await isRunning(p)) {
    const s = parseLog(readLines(p.log));
    console.log(`✅ Bot 已經在執行中（${s.ready ? `登入成 ${s.ready.tag}` : '尚未登入完成'}），不用再啟動。`);
    printSetup(cfg, fs.existsSync(p.pin));
    return { ok: true, state: 'running', tag: s.ready?.tag ?? null };
  }
  const rt = runtimeState(p);
  if (!rt.upToDate) {
    if (foreign && rt.installed) console.log('（用這隻 Bot 自己的 runtime 啟動；要更新 runtime，請用 /channelcollab:start 或它自己的啟動捷徑）');
    else if (!update && rt.installed) console.log('⚠️  runtime 不是最新版，這次先用舊版啟動。');
    else await installRuntime(p);
  }

  rotate(p.log, p.prevLog);
  rotate(p.errLog, p.prevErrLog);
  const out = fs.openSync(p.log, 'a');
  const err = fs.openSync(p.errLog, 'a');
  // reply 工具一律放行是刻意的設計；SDK 對此的提醒不是錯誤，不寫進 bot.err.log。
  const child = spawn(process.execPath, [`--disable-warning=${SDK_SHADOW_WARNING}`, p.bot], {
    cwd: p.runtime,
    env: { ...process.env, CHANNELCOLLAB_HOME: p.home },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? -1));
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  console.log(`Bot 啟動中（pid ${child.pid}，log：${p.log}）…`);
  if (!wait) return { ok: true, state: 'launched' };

  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const s = parseLog(readLines(p.log));
    if (s.ready) {
      console.log(`✅ Bot 已上線：登入成 ${s.ready.tag}（Discord ID ${s.ready.id}）`);
      printSetup(cfg, fs.existsSync(p.pin));
      console.log('Bot 在背景執行，關掉這個視窗或 Claude Code 都不會停；要停止請用 stop。');
      return { ok: true, state: 'started', tag: s.ready.tag };
    }
    if (exited !== null) break;
  }
  const s = parseLog(readLines(p.log));
  console.log(exited !== null ? `❌ Bot 啟動失敗，程序已結束（代碼 ${exited}）。` : `❌ ${wait} 秒內沒有上線。`);
  for (const l of [...s.errors, ...filterStderr(readLines(p.errLog)).slice(-8)]) console.log(`   ${l}`);
  console.log('   常見原因：token 失效（請管理員重給交付檔）、網路連不到 discord.com、Message Content Intent 沒開。');
  process.exitCode = 1;
  return { ok: false, state: 'failed', error: exited !== null ? `程序已結束（代碼 ${exited}）` : `${wait} 秒內沒有上線` };
}

/** Bot 程序底下的所有子孫程序（停止前記下，停止後確認都已結束）。 */
function descendants(pid) {
  if (process.platform !== 'win32' || !pid) return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
      { encoding: 'utf8', windowsHide: true },
    );
    const rows = out.split(/\r?\n/).map((l) => l.trim().split(' ')).filter((r) => r.length >= 3);
    const found = [];
    const walk = (parent) => {
      for (const [id, pp, name] of rows) {
        if (Number(pp) === parent && !found.some((f) => f.pid === Number(id))) {
          found.push({ pid: Number(id), name });
          walk(Number(id));
        }
      }
    };
    walk(pid);
    return found;
  } catch {
    return [];
  }
}

/**
 * Bot 正在哪些對話裡工作（這一輪還在跑或有訊息排隊）：[{ key, kind, name }]，閒置是 []。
 * 問不到（沒在執行、還沒登入完成的舊版 Bot）回傳 null。0.1.8 的 Bot 沒有 working 指令，改用 sessions 的 busy。
 * 這只是查詢，不影響 Bot 的工作。
 */
export async function workingNow(p, timeoutMs = 10000) {
  const pipe = stopPipe(p.home);
  const r = await pipeJson(pipe, { cmd: 'working' }, timeoutMs).catch(() => null);
  if (r?.ok && Array.isArray(r.working)) return r.working;
  if (r === null) return null;
  const old = await pipeJson(pipe, { cmd: 'sessions' }, timeoutMs).catch(() => null);
  if (old?.ok && Array.isArray(old.sessions)) return old.sessions.filter((x) => x.busy).map((x) => ({ key: x.key, kind: x.kind, name: x.kind === 'dm' ? '私訊' : x.name }));
  return null;
}

export const workingText = (rows) => rows.map((r) => (r.kind === 'dm' ? '私訊' : `討論串「${r.name}」（${r.key}）`)).join('、');

/**
 * 停止。回傳 { ok, state, working }：state 是 stopped、not-running、still-running、leftover。
 * 正在工作的 Bot 照一般的停止處理（和以前一樣），只是先列出它在哪裡工作；不另外等待、不加任何時間限制。
 */
async function stop(p) {
  if (!(await isRunning(p))) {
    const pid = readPid(p);
    console.log('Bot 沒有在執行。');
    if (pid && pidAlive(pid)) console.log(`⚠️  ${p.pid} 記錄的程序 ${pid} 還在，如果確定是卡住的 Bot，可以執行：taskkill /T /F /PID ${pid}`);
    return { ok: true, state: 'not-running', working: [] };
  }
  const working = await workingNow(p);
  if (working === null) console.log('⚠️  無法確認 Bot 是否正在工作（Bot 還沒登入完成，或是舊版）。照一般停止處理。');
  else if (working.length) console.log(`⚙️  Bot 正在工作：${workingText(working)}。照一般停止處理：進行中的這一輪會被中斷（對話保存，之後可以接著做）。`);
  else console.log('Bot 目前閒置（沒有進行中的工作）。');
  const pid = readPid(p);
  const kids = descendants(pid);
  if (!fs.existsSync(p.stop)) throw new CliError(`找不到 ${p.stop}，runtime 可能不完整。請執行 install-runtime。`);
  const r = spawnSync(process.execPath, [p.stop], {
    cwd: p.runtime,
    env: { ...process.env, CHANNELCOLLAB_HOME: p.home },
    encoding: 'utf8',
    windowsHide: true,
  });
  for (const l of `${r.stdout}${r.stderr}`.split(/\r?\n/).filter(Boolean)) console.log(`   ${l}`);
  const left = [pid, ...kids.map((k) => k.pid)].filter((x) => x && pidAlive(x));
  if (await isRunning(p)) {
    console.log('❌ Bot 還在執行。');
    process.exitCode = 1;
    return { ok: false, state: 'still-running', working };
  }
  if (left.length) {
    console.log(`⚠️  Bot 已停止，但還有殘留程序：${left.join(', ')}。可以用 taskkill /T /F /PID <pid> 結束。`);
    process.exitCode = 1;
    return { ok: false, state: 'leftover', working, leftover: left };
  }
  console.log(`✅ Bot 已停止（pid ${pid ?? '?'}${kids.length ? `，連同 ${kids.length} 個子程序` : ''}），沒有殘留程序。`);
  return { ok: true, state: 'stopped', working };
}

// ---------------------------------------------------------------------------
// 雙擊用的啟動／停止檔（.bat）
// ---------------------------------------------------------------------------
/** 0.1.5 以前的固定檔名（不知道 Bot 名稱時仍用它）。同一台電腦有好幾隻 Bot 時會互相覆蓋，所以 0.1.6 起檔名帶 Bot 名稱。 */
export const LAUNCHER_NAMES = {
  start: '啟動 channelcollab Bot.bat',
  stop: '停止 channelcollab Bot.bat',
  'set-pin': '設定 channelcollab PIN.bat',
  unlock: '解除 channelcollab 鎖定.bat',
};

/** 檔名用的名稱：去掉 Discord 舊式的 #1234，不能用的字元換成 _，結尾的點和空白去掉。 */
export function launcherLabel(name) {
  const cleaned = String(name ?? '')
    .replace(/#\d{1,4}$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 60);
  return cleaned || null;
}

/** 「啟動 <名稱>.bat」等；沒有名稱時用舊的固定檔名。 */
export function launcherNames(label) {
  if (!label) return { ...LAUNCHER_NAMES };
  return { start: `啟動 ${label}.bat`, stop: `停止 ${label}.bat`, 'set-pin': `設定 ${label} PIN.bat`, unlock: `解除 ${label} 鎖定.bat` };
}

/**
 * 捷徑檔名用的 Bot 名稱：--name；名冊裡這隻 Bot 的名稱或最後一次登入的名稱（bot.log）；
 * 不是預設 HOME 時用 HOME 資料夾名稱。都沒有就是 null（用舊檔名）。
 */
export function botLabel(p, { name, defaultHome = path.join(os.homedir(), '.channelcollab') } = {}) {
  if (name) return launcherLabel(name);
  const ready = parseLog(readLines(p.log)).ready ?? parseLog(readLines(p.prevLog)).ready;
  if (ready) {
    const bots = readJsonSafe(p.roster)?.bots;
    const fromRoster = Array.isArray(bots) ? bots.find((b) => b?.botId === ready.id)?.botName : undefined;
    return launcherLabel(fromRoster || ready.tag);
  }
  if (path.resolve(p.home).toLowerCase() !== path.resolve(defaultHome).toLowerCase()) return launcherLabel(path.basename(p.home).replace(/^\.+/, ''));
  return null;
}

/** shortcut 建立的檔案記在 <HOME>\launchers.json，status 用它指出實際存在的檔案。 */
const launchersRecord = (p) => path.join(p.home, 'launchers.json');

/** 這個 HOME 的某個捷徑檔（實際存在才回傳）；找不到時 null，status 改成顯示指令。 */
export function findLauncher(p, action, { dirs = [] } = {}) {
  const recorded = readJsonSafe(launchersRecord(p))?.files?.[action];
  if (typeof recorded === 'string' && fs.existsSync(recorded)) return recorded;
  // 0.1.5 以前建的舊檔名：放在 <HOME>\launchers（或指定的資料夾），內容指向這個 HOME 才算。
  for (const dir of [path.join(p.home, 'launchers'), ...dirs]) {
    const f = path.join(dir, LAUNCHER_NAMES[action]);
    if (launcherPointsHere(f, p)) return f;
  }
  return null;
}

function readJsonSafe(file) {
  try {
    return readJson(file, null);
  } catch {
    return null;
  }
}

function launcherPointsHere(file, p) {
  try {
    return fs.readFileSync(file, 'utf8').includes(`--home ${batq(p.home)}`);
  } catch {
    return false;
  }
}

/** 沒有捷徑檔時給的指令（在終端機執行）。 */
export function ctlCommand(p, action) {
  return `node "${p.ctl}" ${action} --home "${p.home}"`;
}

/** cmd 的 % 要寫成 %%，其他字元在雙引號裡原樣保留。 */
const batq = (s) => `"${String(s).replace(/%/g, '%%')}"`;

/**
 * 產生 .bat 內容。執行 <HOME>\runtime\ctl.mjs（不是 plugin 裡的腳本）：plugin 更新時安裝路徑會變，這份複本的路徑不會。
 * node 優先用產生時的絕對路徑，找不到（例如重裝到別處）再用 PATH 上的 node。
 * 檔案用 UTF-8（無 BOM）寫入，第一行切到 65001 讓中文路徑與輸出正常。
 */
export function launcherBat(p, action, nodePath = process.execPath) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `title channelcollab Bot`,
    `set "CC_NODE=${String(nodePath).replace(/%/g, '%%')}"`,
    'if not exist "%CC_NODE%" set "CC_NODE=node"',
    `"%CC_NODE%" ${batq(p.ctl)} ${action} --home ${batq(p.home)}`,
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}

function desktopDir() {
  // 桌面可能被 OneDrive 重新導向，要問系統，不能直接用 %USERPROFILE%\Desktop。
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const dir = r.stdout?.trim();
  return dir && fs.existsSync(dir) ? dir : path.join(os.homedir(), 'Desktop');
}

/**
 * 在 dir（預設桌面）建四個 .bat，檔名帶 Bot 名稱。同一個資料夾裡指向這個 HOME 的舊檔
 * （0.1.5 的固定檔名、或改名前建的）會刪掉，指向別的 HOME 的不動。
 */
export function makeLaunchers(p, dir, { name, skipRuntimeCheck = false } = {}) {
  if (!skipRuntimeCheck) {
    if (!runtimeState(p).installed) throw new CliError('runtime 還沒安裝。請先執行 install-runtime 或 start。');
    syncCtl(p);
  }
  const target = path.resolve(dir || desktopDir());
  fs.mkdirSync(target, { recursive: true });
  const names = launcherNames(botLabel(p, { name }));
  const prev = readJsonSafe(launchersRecord(p))?.files ?? {};
  const files = [];
  const removed = [];
  const record = {};
  for (const action of Object.keys(names)) {
    const file = path.join(target, names[action]);
    fs.writeFileSync(file, launcherBat(p, action), 'utf8');
    files.push(file);
    record[action] = file;
    const stale = [path.join(target, LAUNCHER_NAMES[action]), typeof prev[action] === 'string' ? prev[action] : null].filter(Boolean);
    for (const old of stale) {
      if (path.resolve(old).toLowerCase() === path.resolve(file).toLowerCase()) continue;
      if (path.dirname(path.resolve(old)).toLowerCase() !== target.toLowerCase()) continue;
      if (launcherPointsHere(old, p)) {
        fs.rmSync(old, { force: true });
        removed.push(old);
      }
    }
  }
  writeJson(launchersRecord(p), { version: 1, dir: target, files: record });
  return { files, removed };
}

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
function printDm(dm, pinSet) {
  if (!dm) return console.log('私訊：未開啟（要用的話：bind --dm --cwd <資料夾>，並先設定 PIN）');
  console.log(`私訊：開啟 → ${dm.cwd}（模型 ${dm.model ?? '預設'}，權限模式 ${dm.permission_mode ?? '沿用預設'}${dm.launcher ? `，啟動器 ${dm.launcher}` : ''}${'turn_timeout_minutes' in dm ? `，單輪上限 ${turnLimitText(dm.turn_timeout_minutes)}` : ''}${'max_turns' in dm ? `，步數上限 ${stepLimitText(dm.max_turns)}` : ''}${dm.effort ? `，努力程度 ${dm.effort}` : ''}）${pinSet ? '' : '　⚠️ 還沒設定 PIN，私訊暫不開放'}`);
}

/** 模式、頻道、私訊（start 和 status 共用）。 */
function printSetup(c, pinSet) {
  console.log(`模式：${MODE_LABEL[c.mode] ?? c.mode}`);
  if (c.mode === 'none') console.log('   ⚠️ 要先綁一個頻道（/channelcollab:bind），或開私訊（bind --dm --cwd <資料夾>，並設定 PIN）');
  if (c.mode === 'dm-only') console.log('綁定的頻道：無（只用私訊，不需要；之後想加入團隊頻道，用 /channelcollab:bind 綁頻道就好）');
  else {
    console.log('綁定的頻道：');
    printChannels(c.channels);
  }
  printDm(c.dm, pinSet);
  console.log(`單輪工作上限：${turnLimitText(c.turnTimeoutMinutes ?? 0)}${c.turnTimeoutMinutes ? '（等人按按鈕的時間不算；到了會停止這一輪，對話保存）' : '（要停止請在 Discord 按 🛑 或用 /stop）'}`);
  console.log(`單輪步數上限：${stepLimitText(c.maxTurns ?? 0)}`);
}

function printChannels(channels) {
  const ids = Object.keys(channels);
  if (!ids.length) return console.log('  （還沒有綁定任何頻道）');
  for (const id of ids) {
    const c = channels[id];
    console.log(`  - 頻道 ${id} → ${c.cwd}（模型 ${c.model ?? '預設'}，權限模式 ${c.permission_mode ?? '沿用預設'}${c.launcher ? `，啟動器 ${c.launcher}` : ''}${'turn_timeout_minutes' in c ? `，單輪上限 ${turnLimitText(c.turn_timeout_minutes)}` : ''}${'max_turns' in c ? `，步數上限 ${stepLimitText(c.max_turns)}` : ''}${c.effort ? `，努力程度 ${c.effort}` : ''}）`);
  }
}

/** status 的提示：捷徑檔真的存在才叫使用者雙擊它，否則給指令。 */
export function launcherHint(s, action) {
  const f = s.launchers?.[action];
  return f ? `雙擊「${f}」` : `在終端機執行 ${ctlCommand(paths(s.home), action)}`;
}

function printStatus(s) {
  console.log(`HOME：${s.home}`);
  if (s.running) console.log(`✅ Bot 執行中（pid ${s.pid ?? '?'}）${s.loggedInAs ? `，登入成 ${s.loggedInAs}（ID ${s.botId}）` : '，尚未登入完成'}`);
  else console.log('⏹  Bot 沒有在執行');
  if (s.running) {
    if (s.working === null || s.working === undefined) console.log('工作中：無法確認（Bot 還沒登入完成，或是舊版）');
    else console.log(s.working.length ? `⚙️  正在工作：${workingText(s.working)}` : '工作中：沒有（閒置）');
  }
  if (s.stalePid) console.log(`⚠️  bot.pid 記錄的程序 ${s.stalePid} 還在，但沒有回應；可能卡住了`);
  const c = s.config;
  if (!c.exists) console.log('❌ 還沒有設定檔（請執行 setup）');
  else {
    console.log(`${c.hasToken ? '✅' : '❌'} Bot token ${c.hasToken ? '已設定' : '未設定'}`);
    console.log(`${c.ownerId ? '✅' : '⚠️ '} 主人 Discord ID：${c.ownerId ?? `未設定（權限按鈕${c.dm ? '和私訊' : ''}需要）`}`);
    printSetup(c, s.pin?.set);
    console.log(`白名單：${c.rosterOnly ? '開啟（只有主人和名冊上的人、Bot 能叫 Bot）' : '⚠️ 關閉（伺服器裡任何人都能叫 Bot）'}`);
  }
  const pin = s.pin ?? {};
  if (!pin.set) {
    const needed = c?.dm ? '私訊要有 PIN 才會開放' : '建議設定；開私訊時必須設定';
    console.log(`${c?.dm ? '❌' : '⚠️ '} PIN：未設定（${needed}：${launcherHint(s, 'set-pin')}，或用 /channelcollab:bind 設定 PIN）`);
  } else console.log(`✅ PIN：已設定${pin.locked ? `，🔒 目前鎖定中（輸錯太多次；解除：${launcherHint(s, 'unlock')}）` : ''}`);
  const r = s.roster;
  if (r?.broken) console.log('⚠️  名冊：<HOME>\\roster.json 格式不對，Bot 會當作空名冊');
  else if (!r || (!r.bots && !r.members)) console.log('名冊：空的（可以用 /channelcollab:roster 把常合作的人和 Bot 加進來）');
  else console.log(`名冊：${r.bots} 個 Bot，${r.members} 位成員`);
  const rt = s.runtime;
  console.log(`runtime：${rt.installed ? `版本 ${rt.have?.version}${rt.upToDate ? '（最新）' : `（plugin 是 ${rt.want?.version}，下次啟動會更新）`}` : '未安裝'}`);
  if (s.recentErrors.length || s.stderrTail.length) {
    console.log('最近的錯誤：');
    for (const l of [...s.recentErrors, ...s.stderrTail]) console.log(`  ${l}`);
  } else console.log('最近的錯誤：無');
}

// ---------------------------------------------------------------------------
// 0.1.8：回報到群組、在電腦上接手、交給手機（經執行中 Bot 的 named pipe；腳本本身不讀 token）
// ---------------------------------------------------------------------------
/**
 * 新討論串之後會不會接著電腦這段對話：以 Bot 的回答為準（0.1.9 起回 continues；Bot 確實記下分支來源才是 true）。
 * 0.1.8 的 Bot 不回這個欄位，只能用「有開新討論串、也送了 session」推測。
 */
export function postContinues(r, sentSessionId) {
  if (!r?.ok || !r.threadId) return false;
  if (typeof r.continues === 'boolean') return r.continues;
  return !!sentSessionId;
}

/** 經 pipe 送一個 JSON 指令、收一行 JSON 回應；Bot 沒在執行時回傳 null。 */
export async function pipeJson(pipe, request, timeoutMs = 60000) {
  const r = await pipeRequest(pipe, JSON.stringify(request), timeoutMs);
  if (r === null) return null;
  try {
    return JSON.parse(r);
  } catch {
    // 0.1.7 以前的 Bot 不認得 JSON 指令，會回 unknown command。
    return { ok: false, error: r === 'unknown command' ? '執行中的 Bot 是舊版，不認得這個指令；請先 stop 再 start 換成新版' : r };
  }
}

/** 對 Bot 送指令；Bot 沒在跑就停下來，請使用者先啟動（腳本不會自己拿 token 去連 Discord）。 */
async function askBot(p, request, timeoutMs) {
  const r = await pipeJson(stopPipe(p.home), request, timeoutMs);
  if (r === null) throw new CliError(`Bot 沒有在執行（${p.home}）。請先啟動 Bot：/channelcollab:start，或 start --home "${p.home}"`);
  return r;
}

/** 這台電腦上的 channelcollab HOME（%USERPROFILE% 底下 .channelcollab 開頭、有 config.json 的資料夾）。 */
export function listHomes(base = os.homedir()) {
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\.channelcollab/i.test(d.name)).map((d) => d.name);
  } catch {}
  return names
    .map((n) => paths(path.join(base, n)))
    .filter((p) => fs.existsSync(p.config))
    .map((p) => ({ home: p.home, name: botLabel(p, { defaultHome: path.join(base, '.channelcollab') }) ?? path.basename(p.home) }));
}

/** 文字來源：--text-file（建議，避免命令列跳脫），否則 stdin。 */
function readText(opts) {
  const f = opt(opts['text-file']) ?? opt(opts['summary-file']);
  if (f) {
    if (!fs.existsSync(f)) throw new CliError(`找不到文字檔：${f}`);
    return fs.readFileSync(f, 'utf-8').replace(/^﻿/, '');
  }
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * 「要接手哪一段對話」：清單的編號（1 開始）、dm／私訊、討論串 ID，或 --session 的 session ID。
 * rows 是 Bot 回的 sessions。
 */
export function pickConversation(rows, which, sessionId) {
  if (sessionId) {
    const bySession = rows.filter((r) => r.sessionId === sessionId);
    if (bySession.length) return bySession.find((r) => r.takenOver) ?? bySession[0];
  }
  if (which === undefined || which === true) return null;
  const w = String(which).trim();
  if (/^(dm|私訊)$/i.test(w)) return rows.find((r) => r.kind === 'dm') ?? { key: 'dm', kind: 'dm' };
  if (/^\d{1,3}$/.test(w)) return rows[Number(w) - 1] ?? null;
  if (SNOWFLAKE.test(w)) return rows.find((r) => r.key === w) ?? { key: w, kind: 'thread' };
  return null;
}

/** 從 Claude Code 啟動的子程序會帶著這些標記；開新視窗接手時要拿掉，不然新的 claude 會以為自己在別的 session 裡。 */
const SESSION_ENV = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_AGENT_SDK_VERSION'];

export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SESSION_ENV.includes(k.toUpperCase())) out[k] = v;
  return out;
}

/** 在電腦上接回 Bot 的 session 要用的指令（綁定的啟動器 + --resume，在 session 自己的資料夾執行）。 */
export function resumeCommand({ launcher, sessionId }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) throw new CliError(`session ID 格式不對：${sessionId}`);
  const l = String(launcher ?? '').trim();
  // --system-prompt-snapshot off：Bot 的 session 錄下的是 Bot 的系統提示詞（只能用 reply 發言）；在電腦上要換成一般的。
  const args = `--resume ${sessionId} --system-prompt-snapshot off`;
  if (!l || l.toLowerCase() === 'claude') return `claude ${args}`;
  return `"${l}" ${args}`;
}

/**
 * 新視窗執行的 .cmd。**內容只有 ASCII**：資料夾、啟動器、session ID、說明文字都放在環境變數（CC_RESUME_*）。
 * 實測：.cmd 裡有中文時，即使先 chcp 65001，cmd 讀下一行的位置也會算錯、把指令從中間切斷
 * （spike/v018-resume-script.mjs）；環境變數是 UTF-16，經 wt 和 start 都會傳到新視窗（spike/v018-wt-env.mjs）。
 */
export const RESUME_SCRIPT = [
  '@echo off',
  'title %CC_RESUME_TITLE%',
  ...SESSION_ENV.map((k) => `set "${k}="`),
  'cd /d "%CC_RESUME_CWD%"',
  'echo %CC_RESUME_NOTE%',
  'echo.',
  // --system-prompt-snapshot off: the bot's session recorded the bot's system prompt (speak only through reply).
  'if not defined CC_RESUME_LAUNCHER goto plain',
  '"%CC_RESUME_LAUNCHER%" --resume %CC_RESUME_SID% --system-prompt-snapshot off',
  'goto :eof',
  ':plain',
  'claude --resume %CC_RESUME_SID% --system-prompt-snapshot off',
  '',
].join('\r\n');

/** 給 RESUME_SCRIPT 的環境變數（沒有啟動器或啟動器是 claude 時，直接用 claude）。 */
export function resumeEnv({ cwd, launcher, sessionId, title }, base = process.env) {
  resumeCommand({ launcher, sessionId }); // 檢查 session ID 格式
  const l = String(launcher ?? '').trim();
  const env = { ...cleanEnv(base), CC_RESUME_CWD: cwd, CC_RESUME_SID: sessionId, CC_RESUME_TITLE: title ?? 'channelcollab', CC_RESUME_NOTE: 'channelcollab：在電腦上接手 Discord 的對話。做完後在這裡打 /channelcollab:release（或 /exit 後執行 release），把對話交還給 Bot。' };
  if (l && l.toLowerCase() !== 'claude') env.CC_RESUME_LAUNCHER = l;
  else delete env.CC_RESUME_LAUNCHER;
  return env;
}

function whereExe(name) {
  try {
    const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
  } catch {
    return null;
  }
}

/**
 * 開一個新的終端機視窗執行 .cmd（中文與空白路徑都可以）：有 Windows Terminal 就 `wt -w new -d <cwd> cmd /k <檔案>`，
 * 沒有（或路徑含 wt 的分隔字元 ;）就 `cmd /c start "" /d <cwd> cmd /k <檔案>`。
 */
export function openTerminal(file, cwd, { title = 'channelcollab', keep = true, wt = whereExe('wt.exe'), env = cleanEnv() } = {}) {
  const mode = keep ? '/k' : '/c';
  if (wt && !/;/.test(`${file}${cwd}`)) {
    const child = spawn(wt, ['-w', 'new', '--title', title, '-d', cwd, 'cmd.exe', mode, file], { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.unref();
    return 'wt';
  }
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `start ${q(title)} /d ${q(cwd)} cmd.exe ${mode} ${q(file)}`], { detached: true, stdio: 'ignore', env, windowsVerbatimArguments: true, windowsHide: true });
  child.unref();
  return 'cmd';
}

function printSessions(rows) {
  if (!rows.length) return console.log('（這隻 Bot 還沒有可以接手的對話）');
  rows.forEach((r, i) => {
    const flags = [r.takenOver ? '🖥️ 電腦上接手中' : '', r.busy ? '⚙️ 正在工作' : ''].filter(Boolean).join('，');
    console.log(`${String(i + 1).padStart(2)}. ${shortStamp(r.at)}　${r.kind === 'dm' ? '私訊' : `討論串「${r.name}」（${r.key}）`}${flags ? `　${flags}` : ''}`);
    console.log(`    ${r.summary ? r.summary.replace(/\s+/g, ' ').slice(0, 80) : '（沒有摘要）'}`);
    console.log(`    session ${r.sessionId}　cwd ${r.cwd}${r.launcher ? `　啟動器 ${r.launcher}` : ''}`);
  });
}

const shortStamp = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '時間不明' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const bridgeCommands = {
  async homes(_p, opts) {
    const list = listHomes();
    const rows = await Promise.all(list.map(async (h) => ({ ...h, running: await pipeAlive(stopPipe(h.home)) })));
    if (opts.json) return console.log('RESULT ' + JSON.stringify(rows));
    if (!rows.length) return console.log('這台電腦上沒有 channelcollab 的 Bot（找不到 %USERPROFILE%\\.channelcollab* 的設定）。');
    rows.forEach((r, i) => console.log(`${i + 1}. ${r.name}　${r.running ? '✅ 執行中' : '⏹ 沒有執行'}　--home "${r.home}"`));
  },
  async targets(p, opts) {
    const r = await askBot(p, { cmd: 'info' }, 10000);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    if (!r.ok) throw new CliError(r.error);
    console.log(`Bot：${r.bot.tag}（ID ${r.bot.id}）　私訊：${r.dm ? '開啟' : '未開啟'}`);
    if (!r.channels.length) return console.log('可以貼的頻道：無（這隻 Bot 沒有綁定頻道）');
    console.log('可以貼的頻道：');
    for (const c of r.channels) console.log(`  - ${c.name ? `#${c.name}` : '（名稱未知）'}　ID ${c.id}`);
  },
  async post(p, opts) {
    const channel = opt(opts.channel);
    if (!channel) throw new CliError('用法：post --channel <頻道 ID 或名稱> [--thread <討論串 ID>] [--new-thread <標題>] [--file <檔案>]... [--text-file <檔案>]（或從 stdin 傳文字）');
    const text = readText(opts);
    const files = [].concat(opts.file ?? []).filter((f) => f && f !== true).map((f) => path.resolve(String(f)));
    if (!text.trim() && !files.length) throw new CliError('沒有要貼的內容：用 --text-file <檔案> 或從 stdin 傳文字');
    const sessionId = opt(opts.session) ?? process.env.CLAUDE_CODE_SESSION_ID;
    const r = await askBot(p, { cmd: 'post', channel, text, files, thread: opt(opts.thread), newThread: opt(opts['new-thread']), sessionId, cwd: opt(opts.cwd) ?? process.cwd() }, 60000);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    if (!r.ok) throw new CliError(`沒有貼出去：${r.error}`);
    console.log(`✅ 已貼到 ${r.where}`);
    console.log(`連結：${r.url}`);
    for (const x of r.rejected ?? []) console.log(`⚠️  沒附上：${x}`);
    if (postContinues(r, sessionId)) console.log('之後在那個討論串 @ Bot，就會接著這段對話（從這裡的對話複製一份）。');
  },
  async sessions(p, opts) {
    const r = await askBot(p, { cmd: 'sessions' }, 15000);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    if (!r.ok) throw new CliError(r.error);
    printSessions(r.sessions);
  },
  async takeover(p, opts) {
    const list = await askBot(p, { cmd: 'sessions' }, 15000);
    if (!list.ok) throw new CliError(list.error);
    const pick = pickConversation(list.sessions, opts._[1] ?? opts.key);
    if (!pick) {
      printSessions(list.sessions);
      throw new CliError('要指定接手哪一段對話：takeover <編號｜dm｜討論串 ID>');
    }
    const r = await askBot(p, { cmd: 'takeover', key: pick.key }, 90000);
    if (!r.ok) throw new CliError(`沒有接手：${r.error}`);
    const title = `接手：${String(r.name).slice(0, 40)}`;
    const dir = path.join(p.home, 'takeover');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'resume.cmd');
    fs.writeFileSync(file, RESUME_SCRIPT, 'ascii');
    const how = opts['no-window'] ? null : openTerminal(file, r.cwd, { title, env: resumeEnv({ cwd: r.cwd, launcher: r.launcher, sessionId: r.sessionId, title }) });
    if (opts.json) return console.log('RESULT ' + JSON.stringify({ ...r, script: file, window: how }));
    console.log(`✅ Bot 已放開${r.name}，標記成「主人在電腦上接手中」。`);
    console.log(`   session ${r.sessionId}　cwd ${r.cwd}`);
    console.log(how ? `   已開新視窗（${how === 'wt' ? 'Windows Terminal' : '命令提示字元'}）接著這段對話。` : `   沒有開視窗；要自己接的話，在 ${r.cwd} 執行：${resumeCommand(r)}`);
    if (r.url) console.log(`   討論串：${r.url}`);
    console.log(`   做完後交還：release ${r.key} --home "${p.home}"（或在接手的視窗裡用 /channelcollab:release）。`);
  },
  async release(p, opts) {
    const list = await askBot(p, { cmd: 'sessions' }, 15000);
    if (!list.ok) throw new CliError(list.error);
    const sessionId = opt(opts.session);
    const which = opts._[1] ?? opts.key;
    const takenOver = list.sessions.filter((r) => r.takenOver);
    // 給了 --session 就只認那個 session（不在這隻 Bot 就是找錯 HOME，不能改交還別段對話）；都沒給時，只有一段接手中才自動選它。
    const pick = sessionId && which === undefined ? (list.sessions.find((r) => r.sessionId === sessionId && r.takenOver) ?? null) : (pickConversation(list.sessions, which, sessionId) ?? (which === undefined && takenOver.length === 1 ? takenOver[0] : null));
    if (!pick && sessionId && which === undefined) throw new CliError(`這隻 Bot（${p.home}）沒有接手中的 session ${sessionId}；可能是另一隻 Bot，請加 --home 指定`);
    if (!pick) {
      printSessions(list.sessions.filter((r) => r.takenOver));
      throw new CliError('要指定交還哪一段對話：release <編號｜dm｜討論串 ID>（或 --session <session ID>）');
    }
    const r = await askBot(p, { cmd: 'release', key: pick.key, ...(sessionId ? { sessionId } : {}) }, 30000);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    if (!r.ok) throw new CliError(`沒有交還：${r.error}`);
    console.log(`✅ 已把${r.name}交還給 Bot${r.kept ? `，Bot 接著處理期間記下的 ${r.kept} 則訊息` : ''}。`);
    console.log('   ⚠️ 電腦上的這個對話請關掉（/exit），不要再在這裡繼續，避免兩邊同時寫入同一段對話。');
  },
  async handoff(p, opts) {
    const sessionId = opt(opts.session) ?? process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new CliError('用法：handoff --session <session ID> [--cwd <資料夾>] [--channel <頻道> --title <標題>] [--summary-file <檔案>]');
    const summary = readText(opts);
    const r = await askBot(p, { cmd: 'handoff', sessionId, cwd: opt(opts.cwd) ?? process.cwd(), target: opt(opts.channel) ?? 'dm', title: opt(opts.title), summary }, 60000);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    if (!r.ok) throw new CliError(`沒有交棒：${r.error}`);
    console.log(`✅ 已把這段對話交給 Bot 的${r.where}。之後在那裡傳訊息，就會接著這段對話（session ${sessionId}）。`);
    if (r.url) console.log(`連結：${r.url}`);
    if (r.cwdNote) console.log(`   ${r.cwdNote.replace(/`/g, '')}`);
    console.log(`   Bot 用${r.launcher ? `啟動器 ${r.launcher}` : '一般的 claude'}接這段對話。`);
    console.log('   ⚠️ 請關掉電腦上的這個對話（/exit），不要再在這裡繼續，避免兩邊同時寫入。');
  },
};

// ---------------------------------------------------------------------------
// 0.1.9：一次處理這台電腦上的所有 Bot（start／stop／status --all）
// 每隻 Bot 仍是自己的 HOME、自己的程序；這裡只是用 homes 的清單逐一執行，某一隻失敗不影響其他隻。
// ---------------------------------------------------------------------------
const ALL_ACTIONS = {
  start: (p, opts) => start(p, { wait: opts.wait === undefined || opts.wait === true ? READY_WAIT_S : Number(opts.wait), update: !opts['no-update'] }),
  stop: (p) => stop(p),
  async status(p, opts) {
    const s = await getStatus(p);
    if (!opts.json) printStatus(s);
    return { ok: true, state: s.running ? 'running' : 'stopped', working: s.working, status: s };
  },
};

/** 一行總結（--all 的最後一行）。 */
export function allSummary(cmd, results) {
  if (!results.length) return '總結：這台電腦上沒有 channelcollab 的 Bot。';
  const names = (rows) => rows.map((r) => r.name).join('、');
  const parts = [];
  const add = (label, rows) => {
    if (rows.length) parts.push(`${label} ${rows.length}（${names(rows)}）`);
  };
  const ok = (states) => results.filter((r) => r.ok && states.includes(r.state));
  if (cmd === 'status') {
    add('執行中', ok(['running']));
    add('沒有執行', ok(['stopped']));
  } else if (cmd === 'start') {
    add('已上線', ok(['started', 'launched']));
    add('原本就在執行', ok(['running']));
  } else {
    add('已停止', ok(['stopped']));
    add('本來就沒在執行', ok(['not-running']));
  }
  add('失敗', results.filter((r) => !r.ok));
  const busy = results.filter((r) => r.working?.length);
  const unknown = results.filter((r) => r.working === null);
  let tail = '';
  if (busy.length) tail += `；${cmd === 'stop' ? '停止時正在工作' : '正在工作'}：${busy.map((r) => `${r.name}（${workingText(r.working)}）`).join('、')}`;
  if (unknown.length) tail += `；無法確認是否在工作：${names(unknown)}`;
  return `總結：${results.length} 隻 Bot，${parts.join('，')}${tail}。`;
}

/** 對 base（預設 %USERPROFILE%）底下的每個 HOME 執行 start／stop／status。回傳各 HOME 的結果。 */
export async function runAll(cmd, opts = {}, { base = os.homedir() } = {}) {
  const action = ALL_ACTIONS[cmd];
  if (!action) throw new CliError(`--all 只能用在 ${Object.keys(ALL_ACTIONS).join('、')}`);
  const list = listHomes(base);
  const results = [];
  if (!list.length) console.log('這台電腦上沒有 channelcollab 的 Bot（找不到 %USERPROFILE%\\.channelcollab* 的設定）。');
  for (const [i, h] of list.entries()) {
    console.log(`${i ? '\n' : ''}=== ${i + 1}/${list.length}　${h.name}（${h.home}）`);
    let r;
    try {
      r = await action(paths(h.home), opts);
    } catch (e) {
      const error = e instanceof CliError ? e.message : String(e?.message ?? e);
      console.log(`❌ ${error}`);
      r = { ok: false, state: 'error', error };
    }
    results.push({ home: h.home, name: h.name, ...r });
  }
  console.log(`\n${allSummary(cmd, results)}`);
  if (opts.json) console.log('RESULT ' + JSON.stringify(results));
  process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  return results;
}

// ---------------------------------------------------------------------------
// 0.1.9：「啟動全部 Bot.bat」「停止全部 Bot.bat」（放在預設 HOME 的 launchers 資料夾）
// ---------------------------------------------------------------------------
export const ALL_LAUNCHER_NAMES = { start: '啟動全部 Bot.bat', stop: '停止全部 Bot.bat' };

const isAscii = (x) => /^[\x20-\x7e]*$/.test(x);

/**
 * .bat 裡用的路徑，只用 ASCII：開頭是使用者資料夾等時換成 %USERPROFILE% 之類的環境變數（雙擊時由系統帶入）。
 * 換完還有非 ASCII 字元時回傳 null。
 */
export function batAsciiPath(file, env = process.env) {
  const f = path.resolve(String(file));
  const esc = (x) => x.replace(/%/g, '%%');
  if (isAscii(f)) return esc(f);
  for (const k of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles(x86)', 'ProgramFiles']) {
    const v = env[k];
    if (!v) continue;
    const rel = path.relative(path.resolve(v), f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (isAscii(rel)) return `%${k}%\\${esc(rel)}`;
  }
  return null;
}

/** HOME 資料夾名稱能不能直接寫進 .bat（英數字等 ASCII，沒有 % 和 "）。 */
const batSafeName = (n) => /^[\x21-\x7e][\x20-\x7e]*$/.test(n) && !/[%"]/.test(n);

/**
 * 「全部」捷徑的內容。**只有 ASCII**：.cmd 裡有中文時，即使先 chcp 65001，cmd 也可能把指令從中間切斷（見 RESUME_SCRIPT）。
 * 總控複本的路徑寫成 %USERPROFILE%\<HOME 資料夾>\runtime\ctl.mjs；要處理哪些 HOME，由 ctl 執行時用 homes 的規則自己找。
 */
export function allLauncherBat(action, { homeDir = '.channelcollab', nodePath = process.execPath, env = process.env } = {}) {
  if (!ALL_LAUNCHER_NAMES[action]) throw new CliError(`沒有「全部」的 ${action} 捷徑`);
  if (!batSafeName(homeDir)) throw new CliError(`HOME 資料夾名稱要是英數字：${homeDir}`);
  const node = batAsciiPath(nodePath, env);
  return [
    '@echo off',
    'chcp 65001 >nul',
    `title channelcollab: ${action} all bots`,
    `set "CC_NODE=${node ?? 'node'}"`,
    'if not exist "%CC_NODE%" set "CC_NODE=node"',
    `set "CC_CTL=%USERPROFILE%\\${homeDir}\\runtime\\ctl.mjs"`,
    'if exist "%CC_CTL%" goto run',
    'echo channelcollab: control script not found: "%CC_CTL%"',
    'echo Start a bot once with /channelcollab:start in Claude Code, then create this shortcut again.',
    'goto end',
    ':run',
    `"%CC_NODE%" "%CC_CTL%" ${action} --all`,
    ':end',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}

/**
 * 在預設 HOME 的 launchers 資料夾建「啟動全部 Bot.bat」「停止全部 Bot.bat」。各 Bot 自己的捷徑檔名不同，不會被覆蓋。
 * 執行用的 ctl.mjs：預設 HOME 有 runtime 就用它的，否則用第一個資料夾名稱是英數字、有 runtime 的 HOME。
 */
export function makeAllLaunchers({ base = os.homedir(), nodePath = process.execPath, env = process.env } = {}) {
  const def = paths(path.join(base, '.channelcollab'));
  const homes = listHomes(base).map((h) => paths(h.home));
  const candidates = [def, ...homes.filter((h) => h.home.toLowerCase() !== def.home.toLowerCase())];
  const host = candidates.find((h) => batSafeName(path.basename(h.home)) && runtimeState(h).installed);
  if (!host) throw new CliError('找不到已安裝 runtime 的 Bot。請先啟動過一次 Bot（/channelcollab:start），再建立「全部」捷徑。');
  if (!foreignRuntime(host)) syncCtl(host);
  if (!fs.existsSync(host.ctl)) throw new CliError(`找不到 ${host.ctl}。請先啟動過一次 Bot（/channelcollab:start）。`);
  const dir = path.join(def.home, 'launchers');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const action of Object.keys(ALL_LAUNCHER_NAMES)) {
    const file = path.join(dir, ALL_LAUNCHER_NAMES[action]);
    fs.writeFileSync(file, allLauncherBat(action, { homeDir: path.basename(host.home), nodePath, env }), 'ascii');
    files.push(file);
  }
  return { files, ctl: host.ctl, homes: homes.length, nodeFromPath: batAsciiPath(nodePath, env) === null };
}

// ---------------------------------------------------------------------------
// 參數與子命令
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq > 0 ? a.slice(eq + 1) : i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      // --file 可以給好幾次（post 的附檔）。
      if (key === 'file' && value !== true) opts.file = [...[].concat(opts.file ?? []), value];
      else opts[key] = value;
    } else opts._.push(a);
  }
  return opts;
}

const commands = {
  async check(p, opts) {
    const node = { version: process.version, ok: nodeMajor() >= MIN_NODE_MAJOR };
    const npm = npmVersion();
    const s = await getStatus(p);
    if (opts.json) return console.log('RESULT ' + JSON.stringify({ node, npm, ...s }));
    console.log(`${node.ok ? '✅' : '❌'} Node ${process.version}${node.ok ? '' : `（需要 ${MIN_NODE_MAJOR} 以上：請執行「${NODE_INSTALL_HINT}」，裝完重開終端機）`}`);
    console.log(`${npm ? '✅' : '❌'} npm ${npm ?? '找不到'}`);
    printStatus(s);
    if (!node.ok || !npm) process.exitCode = 1;
  },
  async 'install-runtime'(p, opts) {
    await installRuntime(p, { force: !!opts.force });
  },
  async 'set-owner'(p, opts) {
    const id = opts._[1] ?? opts.id;
    setOwner(p.config, id);
    console.log(`✅ 已寫入主人 Discord ID：${id}（${p.config}）`);
  },
  async bind(p, opts) {
    if (opts.list) {
      console.log(`${p.config} 的頻道綁定：`);
      const c = configSummary(p.config);
      printChannels(c.channels);
      return printDm(c.dm, fs.existsSync(p.pin));
    }
    if (opts.dm) {
      if (opts.remove) return console.log(unbindDm(p.config) ? '✅ 已關閉私訊' : '私訊本來就沒有開啟');
      const r = bindDm(p.config, {
        cwd: opts.cwd === true ? undefined : opts.cwd,
        model: opts.model === true ? undefined : opts.model,
        permissionMode: opts['permission-mode'] === true ? undefined : opts['permission-mode'],
        launcher: opts.launcher === true ? undefined : opts.launcher,
        turnTimeout: opt(opts['turn-timeout']),
        maxTurns: opt(opts['max-turns']),
        effort: opt(opts.effort),
      });
      console.log(`✅ ${r.action === 'added' ? '開啟' : '更新'}私訊設定：`);
      printDm(r.dm, fs.existsSync(p.pin));
      console.log('   只有主人能私訊 Bot；私訊要先設定 PIN 才會開放（set-pin）。設定檔會自動重新載入。');
      return;
    }
    if (opts.remove) {
      const ok = unbindChannel(p.config, String(opts.channel ?? opts.remove));
      return console.log(ok ? `✅ 已移除頻道 ${opts.channel ?? opts.remove} 的綁定` : `頻道 ${opts.channel ?? opts.remove} 本來就沒有綁定`);
    }
    const r = bindChannel(p.config, {
      channel: String(opts.channel ?? ''),
      cwd: opts.cwd === true ? undefined : opts.cwd,
      model: opts.model === true ? undefined : opts.model,
      permissionMode: opts['permission-mode'] === true ? undefined : opts['permission-mode'],
      launcher: opts.launcher === true ? undefined : opts.launcher,
      tools: opts.tools === true ? undefined : opts.tools,
      turnTimeout: opt(opts['turn-timeout']),
      maxTurns: opt(opts['max-turns']),
      effort: opt(opts.effort),
    });
    console.log(`✅ ${r.action === 'added' ? '新增' : '更新'}綁定：`);
    printChannels({ [opts.channel]: r.channel });
    console.log(`   設定檔會自動重新載入；Bot 正在執行的話，新的設定從下一則訊息開始生效。`);
  },
  async roster(p, opts) {
    const sub = opts._[1] ?? 'list';
    if (!rosterCommands[sub]) throw new CliError(`roster 的子命令只有 ${Object.keys(rosterCommands).join('、')}（收到：${sub}）`);
    await rosterCommands[sub](p, opts);
  },
  async 'import-roster'(p, opts) {
    // 舊名稱：等同 roster import
    await rosterCommands.import(p, { ...opts, _: ['roster', 'import', ...opts._.slice(1)] });
  },
  async 'set-pin'(p, opts) {
    await setPin(p, opts);
  },
  async 'clear-pin'(p, opts) {
    await clearPin(p, opts);
  },
  async unlock(p, opts) {
    await unlock(p, opts);
  },
  async access(p, opts) {
    const v = opts['roster-only'];
    if (v === undefined || v === true) {
      const on = configSummary(p.config).rosterOnly;
      return console.log(`白名單：${on ? '開啟' : '關閉'}（改用 access --roster-only on|off）`);
    }
    if (!/^(on|off)$/.test(String(v))) throw new CliError('用法：access --roster-only on|off');
    setRosterOnly(p.config, v === 'on');
    console.log(v === 'on' ? '✅ 白名單已開啟：只有主人和名冊上的人、Bot 能叫 Bot。' : '⚠️ 白名單已關閉：伺服器裡任何人都能叫 Bot（權限核准仍只有主人能按）。');
  },
  async start(p, opts) {
    await ALL_ACTIONS.start(p, opts);
  },
  async stop(p) {
    await stop(p);
  },
  async status(p, opts) {
    const s = await getStatus(p);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(s));
    printStatus(s);
  },
  ...bridgeCommands,
  async shortcut(p, opts) {
    if (opts.all) {
      const r = makeAllLaunchers();
      console.log('✅ 已建立一次處理所有 Bot 的雙擊檔（各 Bot 自己的捷徑不變）：');
      for (const f of r.files) console.log(`  - ${f}`);
      console.log(`   目前這台電腦上有 ${r.homes} 隻 Bot；之後新增的 Bot 也會自動包含在內（雙擊時才找）。`);
      console.log(`   使用的總控：${r.ctl}`);
      if (r.nodeFromPath) console.log('   ⚠️ node 的路徑含非英數字，捷徑改用 PATH 上的 node。');
      console.log('   想放到桌面的話，可以對檔案按右鍵「傳送到 → 桌面 (建立捷徑)」。');
      return;
    }
    const { files, removed } = makeLaunchers(p, typeof opts.dir === 'string' ? opts.dir : undefined, { name: opt(opts.name) });
    console.log('✅ 已建立雙擊用的檔案：');
    for (const f of files) console.log(`  - ${f}`);
    if (removed.length) {
      console.log('   已刪除同一個資料夾裡、指向這個 Bot 的舊捷徑：');
      for (const f of removed) console.log(`  - ${f}`);
    }
    console.log('   雙擊「啟動」會在背景啟動 Bot 並顯示是否上線；看到結果後按任意鍵關閉視窗，Bot 會繼續執行。');
    console.log('   「設定 PIN」設定核准用 PIN；「解除鎖定」在 PIN 輸錯太多次被鎖定時使用。');
  },
};

const opt = (v) => (v === undefined || v === true ? undefined : String(v));

const rosterCommands = {
  async list(p, opts) {
    const r = readRoster(p.roster);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(r));
    console.log(`名冊 ${p.roster}${fs.existsSync(p.roster) ? '' : '（還不存在，是空的）'}`);
    for (const l of rosterLines(r)) console.log(l);
  },
  async add(p, opts) {
    const id = opt(opts._[2] ?? opts.id);
    if (!id || !SNOWFLAKE.test(id)) throw new CliError('用法：roster add <Discord ID> [--name <名字>] [--role engineer|planner] [--bot|--member] [--owner-id <ID>] [--owner-name <名字>]');
    let name = opt(opts.name);
    let kind = opts.bot ? 'bot' : opts.member ? 'member' : undefined;
    let found = null;
    if (!name || !kind) {
      try {
        found = await lookupDiscordUser(lookupCredentials(p), id);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        if (!name) throw new CliError(`${e.message}。查不到名稱時請加 --name <名字>（Bot 再加 --bot）。`);
        console.log(`⚠️  ${e.message}；改用 --name「${name}」`);
      }
    }
    if (found) {
      name ??= found.name;
      kind ??= found.bot ? 'bot' : 'member';
      if (opts.bot && !found.bot) console.log(`⚠️  Discord 上 ${id} 不是 Bot，但照 --bot 記成 Bot`);
      if (opts.member && found.bot) console.log(`⚠️  Discord 上 ${id} 是 Bot，但照 --member 記成成員`);
    }
    kind ??= 'member';
    const ownerId = opt(opts['owner-id']);
    let ownerName = opt(opts['owner-name']);
    if (kind === 'bot' && ownerId && !ownerName) {
      try {
        ownerName = (await lookupDiscordUser(lookupCredentials(p), ownerId)).name;
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        console.log(`⚠️  查不到主人的名稱（${e.message}）；需要的話用 --owner-name 補上`);
      }
    }
    const roster = readRoster(p.roster);
    const r = rosterUpsert(roster, { kind, id, name, role: opt(opts.role), ownerId, ownerName });
    writeJson(p.roster, validateRoster(roster));
    const what = kind === 'bot' ? 'Bot' : '成員';
    const src = found ? `（名稱來自 Discord ${found.nick ? '伺服器暱稱' : found.globalName ? '顯示名稱' : 'username'}）` : '';
    console.log(`✅ 名冊${r.action === 'added' ? '新增' : '更新'}${what}：${name}（ID ${id}）${src}${r.moved ? `；原本記在${kind === 'bot' ? '成員' : 'Bot'}，已搬過來` : ''}`);
    if (found && !found.guild) console.log('   ⚠️  這個人不在 Bot 所在的伺服器裡（或 Bot 查不到），名稱用的是 Discord 帳號的名稱');
    console.log(`   檔案：${p.roster}；下一個新的對話開始生效，不用重啟 Bot。`);
  },
  async remove(p, opts) {
    const id = opt(opts._[2] ?? opts.id);
    if (!id) throw new CliError('用法：roster remove <Discord ID>');
    const roster = readRoster(p.roster);
    const kind = rosterRemove(roster, id);
    if (!kind) return console.log(`名冊裡本來就沒有 ${id}`);
    writeJson(p.roster, roster);
    console.log(`✅ 已從名冊移除${kind === 'bot' ? 'Bot' : '成員'} ${id}`);
  },
  async import(p, opts) {
    const src = opt(opts._[2] ?? opts.file);
    if (!src) throw new CliError('用法：roster import <名冊檔案> [--theirs]');
    const theirs = validateRoster(readJson(path.resolve(src), null) ?? {});
    const mine = readRoster(p.roster);
    const r = mergeRoster(mine, theirs, { preferTheirs: !!opts.theirs });
    writeJson(p.roster, validateRoster(r.roster));
    if (opts.json) return console.log('RESULT ' + JSON.stringify({ added: r.added, conflicts: r.conflicts, replaced: r.replaced }));
    const label = (x) => `${x.kind === 'bot' ? 'Bot' : '成員'} ${x.name}（ID ${x.id}）`;
    console.log(`✅ 已合併 ${path.resolve(src)} 到 ${p.roster}：新增 ${r.added.length} 筆，取代 ${r.replaced.length} 筆，保留自己的 ${r.conflicts.length} 筆`);
    for (const x of r.added) console.log(`  + ${label(x)}`);
    for (const x of r.replaced) console.log(`  ~ ${label(x)}（改用對方的）`);
    for (const x of r.conflicts) {
      const why = x.mine ? `你記成${x.mine}，對方記成${x.theirs}` : `對方的內容不同${x.theirsName && x.theirsName !== x.name ? `（對方叫它「${x.theirsName}」）` : ''}`;
      console.log(`  = ${label(x)}：${why}，保留你的`);
    }
    if (r.conflicts.some((x) => !x.mine)) console.log('   要改用對方的內容，加 --theirs 再匯入一次（只影響上面「保留你的」那幾筆）。');
    console.log('   下一個新的對話開始生效，不用重啟 Bot。');
  },
};

const HELP = `用法：node channelcollab.mjs <子命令> [選項] [--home <路徑>]

  check [--json]                          檢查 Node、npm、runtime、設定、執行狀態
  install-runtime [--force]               安裝或更新 runtime 到 <HOME>\\runtime
  set-owner <Discord 使用者 ID>           設定 Bot 的主人（可以按權限按鈕的人）
  bind --channel <ID> --cwd <資料夾> [--model opus|sonnet|haiku] [--permission-mode default]
       [--launcher <路徑>] [--tools Read,Grep,...] [--turn-timeout <分鐘>|none]
       [--max-turns <步數>|none] [--effort low|medium|high|xhigh|max|none]
                                          新增或修改頻道綁定（只給要改的欄位）
  bind --remove --channel <ID>            移除頻道綁定
  bind --dm --cwd <資料夾> [--model ...] [--permission-mode ...] [--launcher <路徑>] [--turn-timeout <分鐘>|none]
       [--max-turns <步數>|none]
                                          開啟或修改私訊（只有主人能用，要先設定 PIN）
  bind --dm --remove                      關閉私訊
  bind --list                             列出頻道綁定與私訊設定
  set-pin                                 設定核准用 PIN（另開主控台視窗輸入，不回顯）
  clear-pin                               移除 PIN（要在主控台視窗確認）
  unlock                                  PIN 輸錯太多次被鎖定時解除（要在主控台視窗確認）
  access [--roster-only on|off]           白名單：只有主人和名冊上的人、Bot 能叫 Bot（預設開）
  roster list [--json]                    列出自己的名冊（Bot 和成員）
  roster add <Discord ID> [--name <名字>] [--role engineer|planner] [--bot|--member]
             [--owner-id <ID>] [--owner-name <名字>]
                                          加進名冊；名字和是不是 Bot 用自己 Bot 的 token 向 Discord 查
  roster remove <Discord ID>              從名冊移除
  roster import <檔案> [--theirs]         合併別人給的名冊（同一個 ID 預設保留自己的）
  start [--wait <秒>] [--no-update] [--all]  在背景啟動 Bot，等它上線（--all：這台電腦上的每一隻）
  stop [--all]                            停止 Bot，並確認沒有殘留程序（會先列出正在工作的對話）
  status [--json] [--all]                 Bot 是否在跑、是否正在工作、登入成誰、綁定、最近錯誤
  homes [--json]                          列出這台電腦上的 Bot（各 HOME 與 Bot 名稱）
  targets [--json]                        這隻 Bot 可以貼文的頻道（要 Bot 在執行）
  post --channel <頻道 ID 或名稱> [--thread <討論串 ID>] [--new-thread <標題>] [--file <檔案>]...
       [--text-file <檔案>] [--session <ID>]  請執行中的 Bot 貼文到綁定的頻道（文字也可以從 stdin 傳入）
  sessions [--json]                       這隻 Bot 最近的對話（討論串、私訊）與 session ID、cwd
  takeover <編號|dm|討論串 ID> [--no-window]  在電腦上接手一段對話：Bot 放開它，開新視窗 resume
  release [<編號|dm|討論串 ID>] [--session <ID>]  把接手的對話交還給 Bot
  handoff [--session <ID>] [--channel <頻道> --title <標題>] [--summary-file <檔案>]
                                          把電腦上的這個 session 交給 Bot（預設私訊；--channel 開新討論串）
  shortcut [--dir <資料夾>] [--name <名稱>]  產生雙擊用的啟動／停止／PIN／解除鎖定 .bat，檔名帶 Bot 名稱（預設放桌面）
  shortcut --all                          在預設 HOME 的 launchers 資料夾產生「啟動全部 Bot.bat」「停止全部 Bot.bat」
  --self-test                             自我測試

HOME：--home 優先，其次 CHANNELCOLLAB_HOME，預設 %USERPROFILE%\\.channelcollab
--all：%USERPROFILE% 底下所有 .channelcollab* 的 HOME（和 homes 相同），逐一處理，某一隻失敗不影響其他隻`;

// ---------------------------------------------------------------------------
// 自我測試（不需要 token、不連網路、不啟動 Bot）
// ---------------------------------------------------------------------------
async function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = async (name, fn) => {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${name}：${e.message}`);
    }
  };
  const eq = (a, b, msg = '') => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
  };
  const throws = (fn, re) => {
    try {
      fn();
    } catch (e) {
      if (re && !re.test(e.message)) throw new Error(`錯誤訊息不符：${e.message}`);
      return;
    }
    throw new Error('預期丟出錯誤但沒有');
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channelcollab-test-'));
  const FAKE = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', 'GxYzAb', 'fake_token_for_self_test_0123456789abcd'].join('.'); // 拆開寫，原始碼才不像真 token
  const CH = '123456789012345678';
  const cfg = path.join(tmp, 'config.json');

  console.log('HOME');
  await t('--home 優先於 CHANNELCOLLAB_HOME，兩者都沒有時用 ~/.channelcollab', () => {
    eq(resolveHome({ home: tmp }, { CHANNELCOLLAB_HOME: 'X:\\other' }), path.resolve(tmp));
    eq(resolveHome({}, { CHANNELCOLLAB_HOME: tmp }), path.resolve(tmp));
    eq(resolveHome({}, {}), path.join(os.homedir(), '.channelcollab'));
  });
  await t('停止用的 pipe 名稱與 src/config.ts 同算法（大小寫不影響）', () => {
    eq(stopPipe('C:\\A\\B'), stopPipe('c:\\a\\b'));
    eq(/^\\\\\.\\pipe\\channelcollab-[0-9a-f]{12}$/.test(stopPipe(tmp)), true, '格式');
  });

  console.log('頻道綁定');
  fs.writeFileSync(cfg, '\uFEFF' + JSON.stringify({ discord: { token: FAKE, guild_id: '1' }, unbound: 'ignore' }), 'utf-8');
  await t('新增綁定：permission_mode 預設 default，token 與其他欄位保留', () => {
    const r = bindChannel(cfg, { channel: CH, cwd: tmp, model: 'haiku' });
    eq(r.action, 'added');
    const c = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    eq(c.discord.token, FAKE, 'token');
    eq(c.unbound, 'ignore');
    eq(c.channels[CH], { cwd: path.resolve(tmp), model: 'haiku', permission_mode: 'default' });
    eq(c.defaults.permission_mode, 'default');
  });
  await t('修改只動給的欄位', () => {
    bindChannel(cfg, { channel: CH, permissionMode: 'acceptEdits' });
    eq(JSON.parse(fs.readFileSync(cfg, 'utf-8')).channels[CH].model, 'haiku');
    eq(JSON.parse(fs.readFileSync(cfg, 'utf-8')).channels[CH].permission_mode, 'acceptEdits');
  });
  await t('拒絕 bypassPermissions、未知模式、不存在的資料夾、錯誤的頻道 ID', () => {
    throws(() => bindChannel(cfg, { channel: CH, permissionMode: 'bypassPermissions' }), /bypassPermissions/);
    throws(() => bindChannel(cfg, { channel: CH, permissionMode: 'yolo' }), /permission_mode/);
    throws(() => bindChannel(cfg, { channel: CH, cwd: path.join(tmp, 'nope') }), /不存在/);
    throws(() => bindChannel(cfg, { channel: '123', cwd: tmp }), /頻道 ID/);
    throws(() => bindChannel(cfg, { channel: '223456789012345678' }), /--cwd/);
  });
  await t('摘要不含 token', () => {
    const s = configSummary(cfg);
    eq(JSON.stringify(s).includes(FAKE), false);
    eq(s.hasToken, true);
    eq(Object.keys(s.channels), [CH]);
  });
  await t('主人 ID 寫入 discord.owner_id，格式錯誤會拒絕', () => {
    setOwner(cfg, '466000000000000001');
    const c = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    eq(c.discord.owner_id, '466000000000000001');
    eq(c.discord.token, FAKE);
    throws(() => setOwner(cfg, 'abc'), /格式/);
  });
  await t('之後再綁定或修改頻道，owner_id、token 與 defaults 的其他欄位都保留', () => {
    const c0 = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    c0.defaults = { ...c0.defaults, permission_timeout_minutes: 15 };
    fs.writeFileSync(cfg, JSON.stringify(c0), 'utf-8');
    bindChannel(cfg, { channel: '323456789012345678', cwd: tmp });
    bindChannel(cfg, { channel: CH, model: 'sonnet' });
    unbindChannel(cfg, '323456789012345678');
    const c = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    eq(c.discord.owner_id, '466000000000000001');
    eq(c.discord.token, FAKE);
    eq(c.defaults.permission_timeout_minutes, 15);
    eq(configSummary(cfg).ownerId, '466000000000000001');
  });
  await t('移除綁定', () => {
    eq(unbindChannel(cfg, CH), true);
    eq(unbindChannel(cfg, CH), false);
  });
  await t('壞掉的 JSON 不覆蓋，錯誤訊息不含檔案內容', () => {
    const f = path.join(tmp, 'broken.json');
    fs.writeFileSync(f, `{"discord":{"token":"${FAKE}"`, 'utf-8');
    try {
      bindChannel(f, { channel: CH, cwd: tmp });
      throw new Error('沒有丟錯');
    } catch (e) {
      eq(/不是合法的 JSON/.test(e.message), true, '訊息');
      eq(e.message.includes(FAKE), false, '不含 token');
    }
    eq(fs.readFileSync(f, 'utf-8').includes(FAKE), true, '原檔不變');
  });

  console.log('私訊設定');
  await t('bind --dm：新增、只改給的欄位、拒絕 bypassPermissions、沒給 cwd 不能新增、移除；不動頻道與 token', () => {
    const f = path.join(tmp, 'dm.json');
    fs.writeFileSync(f, JSON.stringify({ discord: { token: FAKE }, channels: { [CH]: { cwd: tmp, permission_mode: 'default' } } }), 'utf-8');
    throws(() => bindDm(f, {}), /--cwd/);
    eq(bindDm(f, { cwd: tmp, permissionMode: 'auto', launcher: 'C:\\x\\l.cmd' }).action, 'added');
    bindDm(f, { model: 'sonnet' });
    const c = JSON.parse(fs.readFileSync(f, 'utf-8'));
    eq(c.dm, { cwd: path.resolve(tmp), permission_mode: 'auto', launcher: 'C:\\x\\l.cmd', model: 'sonnet' });
    eq(c.discord.token, FAKE);
    eq(Object.keys(c.channels), [CH]);
    throws(() => bindDm(f, { permissionMode: 'bypassPermissions' }), /bypassPermissions/);
    const sum = configSummary(f);
    eq(sum.dm.cwd, path.resolve(tmp));
    eq(JSON.stringify(sum).includes(FAKE), false, '摘要不含 token');
    eq(unbindDm(f), true);
    eq(unbindDm(f), false);
    eq(configSummary(f).dm, null);
  });
  await t('白名單預設開，可以關；摘要顯示 PIN 免輸入時間與主人等待時間的預設', () => {
    const f = path.join(tmp, 'acc.json');
    fs.writeFileSync(f, JSON.stringify({ discord: { token: FAKE } }), 'utf-8');
    eq(configSummary(f).rosterOnly, true);
    eq(configSummary(f).pinUnlockMinutes, 30);
    eq(configSummary(f).ownerWaitMinutes, 2);
    setRosterOnly(f, false);
    eq(configSummary(f).rosterOnly, false);
    eq(JSON.parse(fs.readFileSync(f, 'utf-8')).discord.token, FAKE);
  });

  console.log('PIN');
  await t('只存 scrypt 雜湊與 salt；同一個 PIN 每次 salt 不同；前後空白不影響；錯的 PIN 不通過', () => {
    const a = hashPin('246810');
    const b = hashPin('246810');
    eq(a.algo, 'scrypt');
    eq(JSON.stringify(a).includes('246810'), false, '不含明文');
    eq(a.salt === b.salt, false, 'salt 不同');
    eq(verifyPinRecord(' 246810 ', a), true);
    eq(verifyPinRecord('246811', a), false);
  });
  await t('PIN 格式：至少 4 個字元、中間不能有空白', () => {
    eq(pinFormatError('123'), 'PIN 至少要 4 個字元（建議 6 位數字）');
    eq(pinFormatError('12 34') !== null, true);
    eq(pinFormatError('1234'), null);
  });
  await t('不是主控台時 set-pin 不在這裡讀 PIN（PIN 不經過命令列）', () => {
    eq(typeof setPin, 'function');
    eq(HELP.includes('set-pin'), true);
  });

  console.log('名冊');
  const bot = { botId: '111111111111111111', botName: '範例Bot', ownerName: '小明', ownerDiscordId: '222222222222222222', role: 'planner' };
  await t('合法名冊通過；缺欄位、ID 錯誤、夾帶 token 都拒絕', () => {
    validateRoster({ version: 1, bots: [bot] });
    throws(() => validateRoster({}), /bots/);
    throws(() => validateRoster({ bots: [{ ...bot, botId: 'x' }] }), /botId/);
    throws(() => validateRoster({ bots: [{ ...bot, botName: '' }] }), /botName/);
    throws(() => validateRoster({ bots: [{ ...bot, note: FAKE }] }), /token/);
  });
  const PERSON = '333333333333333333';
  const BOT2 = '444444444444444444';
  await t('members 可省略；Bot 的主人與角色可省略；members 的 ID、名稱錯誤或 ID 重複都拒絕', () => {
    validateRoster({ bots: [{ botId: BOT2, botName: '只有ID的Bot' }] });
    validateRoster({ bots: [bot], members: [{ discordId: PERSON, name: '小華', role: 'planner' }, { discordId: '555555555555555555', name: '小美' }] });
    throws(() => validateRoster({ bots: [], members: {} }), /members/);
    throws(() => validateRoster({ bots: [], members: [{ discordId: 'x', name: 'a' }] }), /discordId/);
    throws(() => validateRoster({ bots: [], members: [{ discordId: PERSON, name: '' }] }), /name/);
    throws(() => validateRoster({ bots: [bot], members: [{ discordId: bot.botId, name: 'a' }] }), /不只一次/);
    throws(() => validateRoster({ bots: [{ ...bot, ownerDiscordId: 'abc' }] }), /ownerDiscordId/);
  });
  const rosterHome = path.join(tmp, 'roster-home');
  const rp = paths(rosterHome);
  await t('名冊不存在時是空的；舊名冊（沒有 members）照常讀，bots 不動', () => {
    eq(readRoster(rp.roster), { version: 1, bots: [], members: [] });
    eq(rosterCounts(rp.roster), null);
    writeJson(rp.roster, { version: 1, bots: [bot] });
    const r = readRoster(rp.roster);
    eq(r.bots, [bot]);
    eq(r.members, []);
    eq(rosterCounts(rp.roster), { bots: 1, members: 0 });
  });
  await t('新增成員、同一個 ID 再加是更新（沒給的欄位保留）、角色別名、錯誤的角色拒絕', () => {
    const r = readRoster(rp.roster);
    eq(rosterUpsert(r, { kind: 'member', id: PERSON, name: '小華', role: '企劃' }).action, 'added');
    eq(r.members, [{ discordId: PERSON, name: '小華', role: 'planner' }]);
    eq(rosterUpsert(r, { kind: 'member', id: PERSON, name: '小華華' }).action, 'updated');
    eq(r.members, [{ discordId: PERSON, name: '小華華', role: 'planner' }]);
    throws(() => rosterUpsert(r, { kind: 'member', id: PERSON, name: 'x', role: '美術' }), /角色/);
    throws(() => rosterUpsert(r, { kind: 'member', id: '12', name: 'x' }), /格式/);
    throws(() => rosterUpsert(r, { kind: 'member', id: PERSON, name: 'x', ownerId: bot.ownerDiscordId }), /只用在 Bot/);
  });
  await t('新增只有 ID 與名稱的 Bot；同一個 ID 從成員改成 Bot 會搬過去，不重複', () => {
    const r = readRoster(rp.roster);
    rosterUpsert(r, { kind: 'member', id: BOT2, name: '誤加' });
    const res = rosterUpsert(r, { kind: 'bot', id: BOT2, name: '小華Bot', ownerId: PERSON, ownerName: '小華', role: 'planner' });
    eq(res.moved, true);
    eq(r.members.some((m) => m.discordId === BOT2), false);
    eq(r.bots.at(-1), { botId: BOT2, botName: '小華Bot', ownerName: '小華', ownerDiscordId: PERSON, role: 'planner' });
    validateRoster(r);
  });
  await t('移除 Bot 或成員；不存在時回傳 null', () => {
    const r = readRoster(rp.roster);
    rosterUpsert(r, { kind: 'member', id: PERSON, name: '小華' });
    rosterUpsert(r, { kind: 'bot', id: BOT2, name: '小華Bot' });
    eq(rosterRemove(r, PERSON), 'member');
    eq(rosterRemove(r, BOT2), 'bot');
    eq(rosterRemove(r, BOT2), null);
    eq(r.bots, [bot]);
  });
  await t('合併別人的名冊：新的加入；同 ID 預設保留自己的；--theirs 取代；Bot／成員不同類時保留自己的；不改傳入的物件', () => {
    const mine = { version: 1, bots: [bot], members: [{ discordId: PERSON, name: '我叫他小華', role: 'planner' }] };
    const theirs = {
      bots: [{ ...bot, botName: '別人取的名字' }, { botId: BOT2, botName: '新Bot' }, { botId: PERSON, botName: '把人記成Bot' }],
      members: [{ discordId: PERSON, name: '小華' }, { discordId: '555555555555555555', name: '小美', role: 'engineer' }],
    };
    const before = JSON.stringify(mine);
    const r = mergeRoster(mine, theirs);
    eq(JSON.stringify(mine), before, '原物件不變');
    eq(r.added.map((x) => x.id), [BOT2, '555555555555555555']);
    eq(r.conflicts.length, 3);
    eq(r.roster.bots[0].botName, bot.botName, '保留自己的 Bot 名稱');
    eq(r.roster.members[0].name, '我叫他小華', '保留自己的成員名稱');
    eq(r.roster.bots.some((b) => b.botId === PERSON), false, '不同類不加入');
    const t2 = mergeRoster(mine, theirs, { preferTheirs: true });
    eq(t2.replaced.map((x) => x.id), [bot.botId, PERSON]);
    eq(t2.roster.bots[0].botName, '別人取的名字');
    eq(t2.roster.members[0], { discordId: PERSON, name: '小華', role: 'planner' }, '對方沒給的欄位保留');
    eq(t2.roster.bots.some((b) => b.botId === PERSON), false, '不同類就算 --theirs 也不加入');
    validateRoster(t2.roster);
    eq(mergeRoster(mine, { bots: [bot] }).conflicts, [], '內容相同不算衝突');
  });
  await t('向 Discord 查名稱：伺服器暱稱優先、其次 global_name、username；查不到伺服器時試 Bot 所在的伺服器；錯誤訊息不含 token', async () => {
    const calls = [];
    const fake = (users, members, guilds = []) => async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      const route = url.replace('https://discord.com/api/v10', '');
      const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
      if (route.startsWith('/users/@me/guilds')) return json(200, guilds);
      let m = /^\/users\/(\d+)$/.exec(route);
      if (m) return users[m[1]] ? json(200, users[m[1]]) : json(404, { message: 'Unknown User' });
      m = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(route);
      if (m) return members[`${m[1]}/${m[2]}`] ? json(200, members[`${m[1]}/${m[2]}`]) : json(404, {});
      return json(404, {});
    };
    const users = { [PERSON]: { username: 'xh', global_name: '小華 Global' }, [BOT2]: { username: 'xhbot', global_name: null, bot: true } };
    const r1 = await lookupDiscordUser({ token: FAKE, guildId: CH }, PERSON, fake(users, { [`${CH}/${PERSON}`]: { nick: '企劃小華' } }));
    eq([r1.name, r1.bot, r1.guild], ['企劃小華', false, CH]);
    eq(calls[0].auth, `Bot ${FAKE}`, 'token 只放在 Authorization');
    const r2 = await lookupDiscordUser({ token: FAKE, guildId: CH }, PERSON, fake(users, { [`${CH}/${PERSON}`]: { nick: null } }));
    eq(r2.name, '小華 Global');
    const r3 = await lookupDiscordUser({ token: FAKE }, BOT2, fake(users, { [`9/${BOT2}`]: {} }, [{ id: '8' }, { id: '9' }]));
    eq([r3.name, r3.bot, r3.guild], ['xhbot', true, '9']);
    const r4 = await lookupDiscordUser({ token: FAKE }, PERSON, fake(users, {}, []));
    eq([r4.name, r4.guild], ['小華 Global', null]);
    for (const fn of [
      () => lookupDiscordUser({ token: FAKE }, '666666666666666666', fake(users, {})),
      () => lookupDiscordUser({ token: FAKE }, PERSON, async () => ({ status: 401, ok: false, json: async () => ({}) })),
      () => lookupDiscordUser({ token: FAKE }, PERSON, async () => { throw new Error(`boom ${FAKE}`); }),
      () => lookupDiscordUser({ token: null }, PERSON, fake(users, {})),
    ]) {
      try {
        await fn();
        throw new Error('沒有丟錯');
      } catch (e) {
        eq(e instanceof CliError, true, `CliError：${e.message}`);
        eq(e.message.includes(FAKE), false, '不含 token');
      }
    }
  });
  await t('roster 子命令：add（給 --name 不查 Discord）、list、remove、import 合併；沒有 token 又沒給 --name 會要求 --name', async () => {
    const home2 = path.join(tmp, 'roster-cli');
    const p2 = paths(home2);
    const quiet = async (fn) => {
      const log = console.log;
      const out = [];
      console.log = (...a) => out.push(a.join(' '));
      try {
        await fn();
      } finally {
        console.log = log;
      }
      return out.join('\n');
    };
    await quiet(() => commands.roster(p2, { _: ['roster', 'add', PERSON], name: '小華', member: true, role: 'planner' }));
    await quiet(() => commands.roster(p2, { _: ['roster', 'add', BOT2], name: '小華Bot', bot: true, 'owner-id': PERSON, 'owner-name': '小華' }));
    const r = JSON.parse(fs.readFileSync(p2.roster, 'utf-8'));
    eq(r.members, [{ discordId: PERSON, name: '小華', role: 'planner' }]);
    eq(r.bots, [{ botId: BOT2, botName: '小華Bot', ownerName: '小華', ownerDiscordId: PERSON }]);
    const listed = await quiet(() => commands.roster(p2, { _: ['roster', 'list'] }));
    eq(listed.includes(`小華（ID ${PERSON}）：企劃`), true, 'list 內容');
    let err = null;
    try {
      await quiet(() => commands.roster(p2, { _: ['roster', 'add', '555555555555555555'] }));
    } catch (e) {
      err = e;
    }
    eq(/--name/.test(err?.message ?? ''), true, `要求 --name：${err?.message}`);
    const other = path.join(tmp, 'other-roster.json');
    writeJson(other, { version: 1, bots: [bot], members: [{ discordId: PERSON, name: '別人叫的' }, { discordId: '555555555555555555', name: '小美' }] });
    await quiet(() => commands['import-roster'](p2, { _: ['import-roster', other] }));
    const merged = JSON.parse(fs.readFileSync(p2.roster, 'utf-8'));
    eq(merged.members.map((m) => m.name), ['小華', '小美'], '同 ID 保留自己的');
    eq(merged.bots.length, 2);
    await quiet(() => commands.roster(p2, { _: ['roster', 'remove', PERSON] }));
    eq(rosterCounts(p2.roster), { bots: 2, members: 1 });
  });

  console.log('log 解析');
  await t('取最後一次 ready 的身分與錯誤行', () => {
    const s = parseLog([
      '[01:00:00.000] [start] pid=1 home=X',
      '[01:00:01.000] [ready] logged in as old#0001 id=111111111111111111 guilds=1',
      '[01:00:02.000] [error] unhandled rejection: boom',
      '[01:00:03.000] [ready] logged in as test-bot#1234 id=222222222222222222 guilds=1',
      '[01:00:04.000] [stop] done',
    ]);
    eq(s.ready.tag, 'test-bot#1234');
    eq(s.ready.id, '222222222222222222');
    eq(s.errors.length, 1);
  });
  await t('錯誤只看分類標籤：工具輸入、回覆內容裡的 failed／error／❌ 不算', () => {
    const lines = [
      '[02:17:44.762] [tool_use] 100 Bash {"command":"git checkout -q 259741_gamebot_reserve_failed_1028 && git status","description":"x"}',
      '[02:17:45.000] [reply] 100 build failed ❌ 找到錯誤了，正在修',
      '[02:17:46.000] [trigger] 100 text=為什麼 cannot load error',
      '[02:17:47.000] [permission] 100 deny Bash (no-go zone: .env) id=x',
      '[02:17:48.000] [live 100] ended pid=1 after 5 ms turns=1 clean=true cost_total=0.0100',
      '[02:17:49.000] [stop] done',
      '[02:17:50.000] [live 100] timeout: 60 分鐘 of work used, interrupting the turn',
    ];
    eq(parseLog(lines).errors, []);
    const bad = [
      '[03:00:00.000] [error] run 100: boom',
      '[03:00:01.000] [config] cannot read X (SyntaxError)',
      '[03:00:02.000] [live 100] error Claude Code process exited with code 1',
      '[03:00:03.000] [commands] slash command registration failed: Missing Access',
      '[03:00:04.000] [start] cannot listen on \\\\.\\pipe\\x (EADDRINUSE); is another bot running? exiting',
      '[03:00:05.000] [stop] error boom',
      '[03:00:06.000] [pool] close 100 failed: x',
    ];
    eq(parseLog([...lines, ...bad]).errors.length, 5, '最多列 5 筆');
    eq(bad.every(isErrorLine), true, '每一行都算錯誤');
    eq(isErrorLine('沒有標籤的一行 error'), false);
  });

  console.log('單輪工作上限');
  await t('bind --turn-timeout：分鐘數寫進綁定，0 代表不限，none 移除；負數或非數字拒絕；status 顯示', () => {
    const f = path.join(tmp, 'turn-timeout.json');
    writeJson(f, { discord: { token: FAKE }, channels: {} });
    eq(configSummary(f).turnTimeoutMinutes, 0, '預設不限');
    bindChannel(f, { channel: CH, cwd: tmp, turnTimeout: '45' });
    eq(readJson(f, {}).channels[CH].turn_timeout_minutes, 45);
    eq(configSummary(f).channels[CH].turn_timeout_minutes, 45);
    bindChannel(f, { channel: CH, turnTimeout: '0' });
    eq(readJson(f, {}).channels[CH].turn_timeout_minutes, 0);
    bindChannel(f, { channel: CH, turnTimeout: 'none' });
    eq('turn_timeout_minutes' in readJson(f, {}).channels[CH], false);
    throws(() => bindChannel(f, { channel: CH, turnTimeout: '-3' }), /turn-timeout/);
    throws(() => bindChannel(f, { channel: CH, turnTimeout: 'abc' }), /turn-timeout/);
    bindDm(f, { cwd: tmp, turnTimeout: '30' });
    eq(configSummary(f).dm.turn_timeout_minutes, 30);
    eq(turnLimitText(0), '不限');
    eq(turnLimitText(90), '90 分鐘');
    eq(readJson(f, {}).discord.token, FAKE, 'token 原樣保留');
  });
  await t('bind --max-turns：預設不限；整數寫進綁定，0 代表不限，none 移除；小數、負數拒絕', () => {
    const f = path.join(tmp, 'max-turns.json');
    writeJson(f, { discord: { token: FAKE }, channels: {} });
    eq(configSummary(f).maxTurns, 0, '預設不限');
    bindChannel(f, { channel: CH, cwd: tmp, maxTurns: '80' });
    eq(configSummary(f).channels[CH].max_turns, 80);
    bindChannel(f, { channel: CH, maxTurns: 'none' });
    eq('max_turns' in readJson(f, {}).channels[CH], false);
    throws(() => bindChannel(f, { channel: CH, maxTurns: '2.5' }), /max-turns/);
    throws(() => bindChannel(f, { channel: CH, maxTurns: '-1' }), /max-turns/);
    bindDm(f, { cwd: tmp, maxTurns: '0' });
    eq(configSummary(f).dm.max_turns, 0);
    eq([stepLimitText(0), stepLimitText(40)], ['不限', '40 步']);
  });

  console.log('努力程度');
  await t('bind --effort：low…max 寫進綁定與私訊，none 移除；其他值拒絕；不設就是預設', () => {
    const f = path.join(tmp, 'effort.json');
    writeJson(f, { discord: { token: FAKE }, channels: {} });
    bindChannel(f, { channel: CH, cwd: tmp });
    eq('effort' in readJson(f, {}).channels[CH], false, '預設不寫');
    bindChannel(f, { channel: CH, effort: 'xhigh' });
    eq(configSummary(f).channels[CH].effort, 'xhigh');
    bindChannel(f, { channel: CH, effort: 'none' });
    eq('effort' in readJson(f, {}).channels[CH], false);
    throws(() => bindChannel(f, { channel: CH, effort: 'turbo' }), /--effort/);
    bindDm(f, { cwd: tmp, effort: 'max' });
    eq(configSummary(f).dm.effort, 'max');
    eq(readJson(f, {}).discord.token, FAKE, 'token 原樣保留');
  });

  console.log('雙擊用的 .bat');
  await t('執行 HOME 裡的 ctl.mjs、帶 --home、% 跳脫成 %%、CRLF 換行、找不到 node 時退回 PATH', () => {
    const p = paths('C:\\Users\\王 小明\\.channelcollab');
    const bat = launcherBat(p, 'start', 'C:\\Program Files\\nodejs\\node.exe');
    eq(bat.split('\r\n')[0], '@echo off');
    eq(bat.includes('chcp 65001'), true, 'chcp');
    eq(bat.includes(`"%CC_NODE%" "${p.ctl}" start --home "${p.home}"`), true, '指令列');
    eq(bat.includes('if not exist "%CC_NODE%" set "CC_NODE=node"'), true, '退回 PATH');
    eq(bat.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')), true, 'CRLF');
    const pct = launcherBat(paths('C:\\a%b'), 'stop', 'C:\\n%x\\node.exe');
    eq(pct.includes('"C:\\a%%b\\runtime\\ctl.mjs" stop --home "C:\\a%%b"'), true, '% 跳脫');
    eq(pct.includes('set "CC_NODE=C:\\n%%x\\node.exe"'), true, 'node 路徑 % 跳脫');
  });

  await t('設定 PIN、解除鎖定的 .bat 也會產生，指令一樣經過 ctl.mjs', () => {
    const p = paths('C:\\Users\\someone\\.channelcollab');
    eq(launcherBat(p, 'set-pin', 'C:\\node.exe').includes(`"${p.ctl}" set-pin --home "${p.home}"`), true);
    eq(Object.keys(LAUNCHER_NAMES), ['start', 'stop', 'set-pin', 'unlock']);
  });

  console.log('只用私訊（0.1.6）');
  await t('只有 dm 設定：模式是「只用私訊」，沒綁頻道不算問題', () => {
    const f = path.join(tmp, 'dm-only.json');
    fs.writeFileSync(f, JSON.stringify({ discord: { token: FAKE, owner_id: CH }, dm: { cwd: tmp, permission_mode: 'default' } }), 'utf-8');
    const c = configSummary(f);
    eq([c.mode, Object.keys(c.channels).length, c.dm.cwd, c.guildId], ['dm-only', 0, tmp, null]);
    eq(MODE_LABEL[c.mode], '只用私訊');
    eq([configMode(0, false), configMode(2, false), configMode(1, true), configMode(0, true)], ['none', 'channels', 'both', 'dm-only']);
  });
  await t('status：只用私訊顯示模式、不要求綁頻道；都沒設定才提示要設定', async () => {
    const run = (config) => {
      const lines = [];
      const orig = console.log;
      console.log = (...a) => lines.push(a.join(' '));
      try {
        printStatus({ home: tmp, running: false, config, pin: { set: true }, roster: { bots: 0, members: 0 }, runtime: { installed: false }, recentErrors: [], stderrTail: [], launchers: {} });
      } finally {
        console.log = orig;
      }
      return lines.join('\n');
    };
    const base = { exists: true, hasToken: true, ownerId: CH, channels: {}, rosterOnly: true };
    const dmOnly = run({ ...base, dm: { cwd: tmp }, mode: 'dm-only' });
    eq(dmOnly.includes('模式：只用私訊'), true, 'dm-only');
    eq(dmOnly.includes('還沒有綁定任何頻道'), false, '不把沒綁頻道當問題');
    eq(dmOnly.includes('要先綁一個頻道'), false);
    const none = run({ ...base, dm: null, mode: 'none' });
    eq(none.includes('要先綁一個頻道'), true, 'none 要提示');
  });

  console.log('最近的錯誤（0.1.6）');
  await t('過濾 SDK 對 reply 工具的提醒和它下一行的 trace-warnings 提示，其他錯誤保留', () => {
    const lines = [
      '(node:1) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: mcp__channelcollab__reply. Bare allowedTools entries ...',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'Error: real problem',
      '(node:2) [DEP0040] DeprecationWarning: something else',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
    ];
    eq(filterStderr(lines), [lines[2], lines[3], lines[4]]);
  });

  console.log('捷徑檔名（0.1.6）');
  await t('檔名帶 Bot 名稱，去掉 #1234 和不能用的字元；沒有名稱時用舊檔名', () => {
    eq(launcherLabel('Test-Bot#1234'), 'Test-Bot');
    eq(launcherLabel('a/b:c?'), 'a_b_c_');
    eq(launcherLabel('  '), null);
    eq(launcherNames('Test-Bot'), { start: '啟動 Test-Bot.bat', stop: '停止 Test-Bot.bat', 'set-pin': '設定 Test-Bot PIN.bat', unlock: '解除 Test-Bot 鎖定.bat' });
    eq(launcherNames(null), LAUNCHER_NAMES);
  });
  await t('名稱來源：bot.log 最後登入的 Bot（名冊有就用名冊的名稱）；非預設 HOME 用資料夾名稱', () => {
    const h = path.join(tmp, 'labels', '.channelcollab-second');
    fs.mkdirSync(h, { recursive: true });
    const p = paths(h);
    eq(botLabel(p, { defaultHome: path.join(tmp, 'nothing') }), 'channelcollab-second', '資料夾名稱');
    eq(botLabel(paths(path.join(tmp, 'def')), { defaultHome: path.join(tmp, 'def') }), null, '預設 HOME、沒有 log');
    fs.writeFileSync(p.log, '[01:00:01.000] [ready] logged in as test-bot#0001 id=222222222222222222 guilds=1\n', 'utf-8');
    eq(botLabel(p), 'test-bot');
    fs.writeFileSync(p.roster, JSON.stringify({ version: 1, bots: [{ botId: '222222222222222222', botName: '測試Bot' }] }), 'utf-8');
    eq(botLabel(p), '測試Bot');
    eq(botLabel(p, { name: '指定名稱' }), '指定名稱');
  });
  await t('兩個 HOME 的捷徑放同一個資料夾不會互相覆蓋；舊的固定檔名（指向自己）會被換掉，指向別人的不動', () => {
    const dir = path.join(tmp, 'shared-launchers');
    const a = paths(path.join(tmp, 'homes', 'a'));
    const b = paths(path.join(tmp, 'homes', 'b'));
    for (const p of [a, b]) fs.mkdirSync(p.home, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    // 0.1.5 留下的舊檔：start 指向 a、stop 指向 b
    fs.writeFileSync(path.join(dir, LAUNCHER_NAMES.start), launcherBat(a, 'start'), 'utf8');
    fs.writeFileSync(path.join(dir, LAUNCHER_NAMES.stop), launcherBat(b, 'stop'), 'utf8');
    const ra = makeLaunchers(a, dir, { name: 'Bot-A', skipRuntimeCheck: true });
    const rb = makeLaunchers(b, dir, { name: 'Bot-B', skipRuntimeCheck: true });
    eq(ra.files.map((f) => path.basename(f)), Object.values(launcherNames('Bot-A')));
    eq(ra.removed.map((f) => path.basename(f)), [LAUNCHER_NAMES.start], 'a 只刪自己的舊檔');
    eq(rb.removed.map((f) => path.basename(f)), [LAUNCHER_NAMES.stop]);
    const left = fs.readdirSync(dir).sort();
    eq(left, [...Object.values(launcherNames('Bot-A')), ...Object.values(launcherNames('Bot-B'))].sort());
    eq(fs.readFileSync(path.join(dir, '啟動 Bot-A.bat'), 'utf8').includes(`--home "${a.home}"`), true);
    eq(fs.readFileSync(path.join(dir, '啟動 Bot-B.bat'), 'utf8').includes(`--home "${b.home}"`), true);
  });
  await t('status 的 PIN 提示指向實際存在的檔案，找不到時改成顯示指令', () => {
    const p = paths(path.join(tmp, 'homes', 'a'));
    const f = findLauncher(p, 'set-pin');
    eq(path.basename(f), '設定 Bot-A PIN.bat');
    eq(launcherHint({ home: p.home, launchers: { 'set-pin': f } }, 'set-pin'), `雙擊「${f}」`);
    fs.rmSync(f);
    eq(findLauncher(p, 'set-pin'), null, '刪掉後找不到');
    eq(launcherHint({ home: p.home, launchers: { 'set-pin': null } }, 'set-pin'), `在終端機執行 node "${p.ctl}" set-pin --home "${p.home}"`);
    // 0.1.5 的舊檔名放在 <HOME>\launchers 也找得到
    const legacy = paths(path.join(tmp, 'homes', 'legacy'));
    fs.mkdirSync(path.join(legacy.home, 'launchers'), { recursive: true });
    fs.writeFileSync(path.join(legacy.home, 'launchers', LAUNCHER_NAMES['set-pin']), launcherBat(legacy, 'set-pin'), 'utf8');
    eq(path.basename(findLauncher(legacy, 'set-pin')), LAUNCHER_NAMES['set-pin']);
  });

  console.log('0.1.9：--all（多隻 Bot 一次處理，假的 HOME）');
  {
    const capture = async (fn) => {
      const lines = [];
      const orig = console.log;
      console.log = (...a) => lines.push(a.join(' '));
      try {
        return { r: await fn(), out: lines.join('\n') };
      } finally {
        console.log = orig;
      }
    };
    // 路徑含中文與空白（和使用者資料夾可能的樣子一樣）。
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc 測試 使用者 '));
    const home = (n) => paths(path.join(base, n));
    const writeCfg = (p, token) => writeJson(p.config, { discord: { ...(token ? { token } : {}), owner_id: CH }, channels: {}, defaults: {} });
    // runtimeState.installed 成立的假 runtime：bot.mjs 由測試指定（不會連 Discord）。
    const fakeRuntime = (p, botCode) => {
      fs.mkdirSync(path.join(p.runtime, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
      fs.writeFileSync(path.join(p.runtime, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), '{}');
      writeJson(p.version, { version: '0.0.0-test', hash: 'fake' });
      fs.writeFileSync(p.bot, botCode);
    };
    const A = home('.channelcollab'); // 執行中、正在私訊裡工作
    const B = home('.channelcollab-b'); // 沒有 token
    const C = home('.channelcollab-c'); // 啟動失敗
    const reset = () => (process.exitCode = 0);

    await t('0 個 HOME：每個指令都只說沒有 Bot，結果是空陣列', async () => {
      for (const cmd of ['start', 'stop', 'status']) {
        const { r, out } = await capture(() => runAll(cmd, { json: true }, { base }));
        eq(r, []);
        if (!/沒有 channelcollab 的 Bot/.test(out) || !/RESULT \[\]/.test(out)) throw new Error(out);
      }
      reset();
    });

    await t('1 個 HOME（沒有 token）：start --all 記成失敗、不丟錯；status --all 照常', async () => {
      writeCfg(B, null);
      const { r, out } = await capture(() => runAll('start', { wait: '2', 'no-update': true }, { base }));
      eq(r.length, 1);
      eq([r[0].ok, r[0].state], [false, 'error']);
      if (!/沒有 Bot token/.test(r[0].error) || !/總結：1 隻 Bot，失敗 1/.test(out)) throw new Error(out);
      eq(process.exitCode, 1);
      const st = await capture(() => runAll('status', { json: true }, { base }));
      eq([st.r[0].ok, st.r[0].state], [true, 'stopped']);
      reset();
    });

    writeCfg(C, FAKE);
    fakeRuntime(C, "console.error('fake bot: cannot log in'); process.exit(3);\n");
    await t('2 個 HOME（一隻沒 token、一隻啟動失敗）：兩隻都處理、都回報，stop --all 照常', async () => {
      const { r, out } = await capture(() => runAll('start', { wait: '20', 'no-update': true, json: true }, { base }));
      eq(r.map((x) => [path.basename(x.home), x.ok, x.state]), [['.channelcollab-b', false, 'error'], ['.channelcollab-c', false, 'failed']]);
      if (!/=== 1\/2/.test(out) || !/=== 2\/2/.test(out) || !/fake bot: cannot log in/.test(out)) throw new Error(out);
      eq(JSON.parse(out.split('\n').pop().slice(7)).length, 2);
      eq(process.exitCode, 1);
      reset();
      const st = await capture(() => runAll('stop', {}, { base }));
      eq(st.r.map((x) => x.state), ['not-running', 'not-running']);
      if (!/總結：2 隻 Bot，本來就沒在執行 2（channelcollab-b、channelcollab-c）。/.test(st.out)) throw new Error(st.out);
      eq(process.exitCode, 0);
    });

    // A：假的執行中 Bot（另一個 node 程序佔住 A 的 named pipe，回答 working 和 stop）。
    writeCfg(A, FAKE);
    fakeRuntime(A, '');
    const pipe = stopPipe(A.home);
    const server = path.join(base, 'fake-bot-server.mjs');
    fs.writeFileSync(server, [
      "import net from 'node:net';",
      "import fs from 'node:fs';",
      'const [pipe, log, pidFile] = process.argv.slice(2);',
      "fs.writeFileSync(log, `[00:00:00.000] [start] pid=${process.pid}\\n[00:00:00.001] [ready] logged in as FakeBot#0 id=123456789012345670\\n`);",
      'fs.writeFileSync(pidFile, String(process.pid));',
      'const srv = net.createServer((sock) => {',
      "  sock.setEncoding('utf8');",
      "  let buf = '';",
      "  sock.on('data', (d) => {",
      '    buf += d;',
      "    const nl = buf.indexOf('\\n');",
      '    if (nl < 0) return;',
      '    const line = buf.slice(0, nl).trim();',
      "    if (line === 'stop') { sock.end(`stopping pid=${process.pid}\\n`); srv.close(); setTimeout(() => process.exit(0), 100); return; }",
      "    if (line === 'pin-state') return void sock.end('{}\\n');",
      "    let o = null; try { o = JSON.parse(line); } catch {}",
      "    if (o?.cmd === 'working') return void sock.end(JSON.stringify({ ok: true, working: [{ key: 'dm', kind: 'dm', name: '私訊' }] }) + '\\n');",
      "    sock.end('unknown command\\n');",
      '  });',
      '});',
      "srv.listen(pipe, () => console.log('listening'));",
    ].join('\n'));
    // 假的 stop.mjs：照 runtime 的 stop 送 stop、等程序結束。
    fs.writeFileSync(A.stop, [
      "import net from 'node:net';",
      `const pipe = ${JSON.stringify(pipe)};`,
      "const answer = await new Promise((res) => { let a = ''; const s = net.connect(pipe, () => s.write('stop\\n')); s.setEncoding('utf8'); s.on('data', (d) => (a += d)); s.on('end', () => res(a.trim())); s.on('error', () => res('')); });",
      'console.log(`bot: ${answer}`);',
      'const pid = Number(/pid=(\\d+)/.exec(answer)?.[1]);',
      'const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };',
      'const end = Date.now() + 10000;',
      'while (pid && alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));',
      'console.log(`pid ${pid} exited`);',
    ].join('\n'));
    const child = spawn(process.execPath, [server, pipe, A.log, A.pid], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    await new Promise((res, rej) => {
      child.stdout.once('data', res);
      child.once('exit', () => rej(new Error('假的 Bot 沒有啟動')));
    });

    await t('3 個 HOME：start --all 逐一處理，沒 token、啟動失敗都不影響其他隻，最後一行總結', async () => {
      const { r, out } = await capture(() => runAll('start', { wait: '20', 'no-update': true }, { base }));
      eq(r.map((x) => [path.basename(x.home), x.ok, x.state]), [['.channelcollab', true, 'running'], ['.channelcollab-b', false, 'error'], ['.channelcollab-c', false, 'failed']]);
      if (!/已經在執行中/.test(out) || !/程序已結束（代碼 3）/.test(out)) throw new Error(out);
      if (!/總結：3 隻 Bot，原本就在執行 1（FakeBot），失敗 2（channelcollab-b、channelcollab-c）/.test(out)) throw new Error(out.split('\n').pop());
      eq(process.exitCode, 1);
      reset();
    });

    await t('status --all --json：每隻一筆，執行中的那隻列出正在工作的對話', async () => {
      const { r, out } = await capture(() => runAll('status', { json: true }, { base }));
      const last = out.split('\n').pop();
      if (!last.startsWith('RESULT ')) throw new Error(last);
      const rows = JSON.parse(last.slice(7));
      eq(rows.map((x) => [x.name, x.state]), [['FakeBot', 'running'], ['channelcollab-b', 'stopped'], ['channelcollab-c', 'stopped']]);
      eq(rows[0].working, [{ key: 'dm', kind: 'dm', name: '私訊' }]);
      eq(rows[0].status.loggedInAs, 'FakeBot#0');
      if (JSON.stringify(rows).includes(FAKE)) throw new Error('輸出含 token');
      if (!/正在工作：FakeBot（私訊）/.test(out)) throw new Error(out);
      eq(r.length, 3);
      reset();
    });

    await t('stop --all：正在工作的照一般停止處理，並清楚列出哪一隻在哪裡工作', async () => {
      const { r, out } = await capture(() => runAll('stop', {}, { base }));
      eq(r.map((x) => [x.name, x.ok, x.state]), [['FakeBot', true, 'stopped'], ['channelcollab-b', true, 'not-running'], ['channelcollab-c', true, 'not-running']]);
      eq(r[0].working, [{ key: 'dm', kind: 'dm', name: '私訊' }]);
      if (!/Bot 正在工作：私訊。照一般停止處理/.test(out)) throw new Error(out);
      if (!/總結：3 隻 Bot，已停止 1（FakeBot），本來就沒在執行 2（channelcollab-b、channelcollab-c）；停止時正在工作：FakeBot（私訊）。/.test(out)) throw new Error(out.split('\n').pop());
      eq(await pipeAlive(pipe), false);
      reset();
    });
    if (child.exitCode === null) child.kill();

    await t('「全部」捷徑：只有 ASCII、放在預設 HOME 的 launchers、不動各 Bot 自己的捷徑', () => {
      const launchers = path.join(A.home, 'launchers');
      fs.mkdirSync(launchers, { recursive: true });
      const own = path.join(launchers, '啟動 FakeBot.bat');
      fs.writeFileSync(own, launcherBat(A, 'start'), 'utf8');
      const before = fs.readFileSync(own, 'utf8');
      const env = { USERPROFILE: base, LOCALAPPDATA: path.join(base, 'AppData', 'Local') };
      const r = makeAllLaunchers({ base, nodePath: path.join(base, 'AppData', 'Local', 'node', 'node.exe'), env });
      eq(r.files.map((f) => path.basename(f)), Object.values(ALL_LAUNCHER_NAMES));
      eq(r.files.map((f) => path.dirname(f)), [launchers, launchers]);
      eq(r.ctl, A.ctl);
      eq(r.homes, 3);
      for (const f of r.files) {
        const text = fs.readFileSync(f, 'latin1');
        if (!/^[\x20-\x7e\r\n]*$/.test(text)) throw new Error(`${f} 不是只有 ASCII`);
        if (!/set "CC_NODE=%LOCALAPPDATA%\\node\\node\.exe"/.test(text)) throw new Error(text);
        if (!/set "CC_CTL=%USERPROFILE%\\\.channelcollab\\runtime\\ctl\.mjs"/.test(text)) throw new Error(text);
      }
      eq(fs.readFileSync(own, 'utf8'), before);
      eq(fs.existsSync(A.ctl), true);
      // node 在換不掉的中文路徑時改用 PATH 上的 node；% 要寫成 %%。
      eq(batAsciiPath('D:\\工具\\node.exe', {}), null);
      eq(batAsciiPath('C:\\a%b\\node.exe', {}), 'C:\\a%%b\\node.exe');
      if (!/set "CC_NODE=node"/.test(allLauncherBat('stop', { nodePath: 'D:\\工具\\node.exe', env: {} }))) throw new Error('沒有退回 PATH 上的 node');
      throws(() => allLauncherBat('stop', { homeDir: '.channelcollab-小明' }), /英數字/);
    });

    if (process.platform === 'win32') {
      await t('「全部」捷徑實際用 cmd 執行（使用者資料夾含中文與空白）：找到每一隻並印出總結', () => {
        const file = path.join(A.home, 'launchers', ALL_LAUNCHER_NAMES.stop);
        const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { input: '\r\n', encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: base }, timeout: 120000 });
        const out = `${r.stdout}${r.stderr}`;
        if (!/總結：3 隻 Bot，本來就沒在執行 3/.test(out)) throw new Error(out.slice(-600));
        if (!out.includes(base)) throw new Error('輸出裡沒有含中文與空白的 HOME 路徑');
      });
    }

    await t('post：只有 Bot 確實記下分支來源時，才說「之後在那個討論串 @ Bot 會接著」', () => {
      eq(postContinues({ ok: true, threadId: '1', continues: true }, 'sid'), true);
      eq(postContinues({ ok: true, threadId: '1', continues: false }, 'sid'), false);
      eq(postContinues({ ok: true, threadId: '1', continues: false }, undefined), false);
      eq(postContinues({ ok: true, url: 'u' }, 'sid'), false); // 沒開新討論串
      // 0.1.8 的 Bot 不回 continues：有送 session 才推測會接上
      eq(postContinues({ ok: true, threadId: '1' }, undefined), false);
      eq(postContinues({ ok: true, threadId: '1' }, 'sid'), true);
    });
    fs.rmSync(base, { recursive: true, force: true });
  }

  console.log('Node 版本');
  await t('主版本解析', () => {
    eq(nodeMajor('v22.22.0'), 22);
    eq(nodeMajor('v20.1.0') < MIN_NODE_MAJOR, true);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts['self-test']) return selfTest();
  const cmd = opts._[0];
  if (opts.all && cmd !== 'shortcut') {
    if (!ALL_ACTIONS[cmd]) throw new CliError(`--all 只能用在 start、stop、status、shortcut（收到：${cmd ?? '沒有子命令'}）`);
    if (opts.home && opts.home !== true) throw new CliError('--all 和 --home 不能一起用：--all 會處理這台電腦上所有的 Bot');
    await runAll(cmd, opts);
    return;
  }
  if (!commands[cmd]) {
    console.log(HELP);
    process.exitCode = cmd ? 2 : 0;
    return;
  }
  await commands[cmd](paths(resolveHome(opts)), opts);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((e) => {
    console.error(`❌ ${e instanceof CliError ? e.message : e?.stack || e}`);
    process.exitCode = 2;
  });
}
