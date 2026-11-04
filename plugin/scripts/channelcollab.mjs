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
//   start | stop | status      啟動（背景執行）、停止、查看狀態
//   shortcut [--dir <資料夾>]   產生雙擊用的「啟動／停止 channelcollab Bot.bat」（預設放桌面）
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
const SOURCE_RUNTIME = fs.existsSync(path.join(SCRIPT_DIR, 'bot.mjs')) ? SCRIPT_DIR : path.resolve(SCRIPT_DIR, '..', 'runtime');
const RUNTIME_FILES = ['bot.mjs', 'stop.mjs', 'package.json', 'package-lock.json'];
const MIN_NODE_MAJOR = 22;
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

/** 不含 token 的設定摘要（給 check／status 用）。 */
export function configSummary(file) {
  if (!fs.existsSync(file)) return { exists: false, hasToken: false, ownerId: null, guildId: null, channels: {} };
  const c = readConfig(file);
  const channels = {};
  for (const [id, ch] of Object.entries(c.channels ?? {})) {
    channels[id] = { cwd: ch?.cwd, model: ch?.model ?? null, permission_mode: ch?.permission_mode ?? null, launcher: ch?.launcher ?? null };
  }
  const dm = c.dm && typeof c.dm === 'object' && c.dm.cwd ? { cwd: c.dm.cwd, model: c.dm.model ?? null, permission_mode: c.dm.permission_mode ?? null, launcher: c.dm.launcher ?? null } : null;
  return {
    exists: true,
    hasToken: typeof c.discord?.token === 'string' && c.discord.token.length > 0,
    ownerId: c.discord?.owner_id ?? null,
    guildId: c.discord?.guild_id ?? null,
    defaultMode: c.defaults?.permission_mode ?? null,
    channels,
    dm,
    rosterOnly: c.access?.roster_only !== false,
    pinUnlockMinutes: typeof c.security?.pin_unlock_minutes === 'number' ? c.security.pin_unlock_minutes : 30,
    ownerWaitMinutes: typeof c.defaults?.owner_wait_minutes === 'number' ? c.defaults.owner_wait_minutes : 2,
  };
}

export function setOwner(file, ownerId) {
  if (!SNOWFLAKE.test(String(ownerId))) throw new CliError(`Discord 使用者 ID 格式不對（應為 17–20 位數字）：${ownerId}`);
  const c = readConfig(file);
  c.discord = { ...(c.discord ?? {}), owner_id: String(ownerId) };
  writeJson(file, c);
}

/** 新增或修改一個頻道綁定；只動 channels.<id>，其他欄位原樣保留。 */
export function bindChannel(file, { channel, cwd, model, permissionMode, launcher, tools }) {
  if (!SNOWFLAKE.test(String(channel ?? ''))) throw new CliError(`頻道 ID 格式不對（應為 17–20 位數字）：${channel}`);
  const c = readConfig(file);
  const prev = c.channels?.[channel];
  if (!prev && !cwd) throw new CliError('新增綁定時一定要給 --cwd（這個頻道的工作資料夾）');
  const next = applyBinding(prev, { cwd, model, permissionMode, launcher, tools });
  c.channels = { ...(c.channels ?? {}), [channel]: next };
  c.defaults = { permission_mode: 'default', ...(c.defaults ?? {}) };
  writeJson(file, c);
  return { action: prev ? 'updated' : 'added', channel: next };
}

/** 私訊設定（config 的 dm 區塊，欄位和頻道綁定相同）；只動 dm，其他欄位原樣保留。 */
export function bindDm(file, { cwd, model, permissionMode, launcher }) {
  const c = readConfig(file);
  const prev = c.dm && typeof c.dm === 'object' ? c.dm : undefined;
  if (!prev && !cwd) throw new CliError('開啟私訊時一定要給 --cwd（私訊用的工作資料夾）');
  const next = applyBinding(prev, { cwd, model, permissionMode, launcher });
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

function applyBinding(prev, { cwd, model, permissionMode, launcher, tools }) {
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
    sock.on('data', (d) => (out += d.toString()));
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

export function parseLog(lines) {
  let ready = null;
  let start = null;
  const errors = [];
  for (const l of lines) {
    if (/\[start\] pid=/.test(l)) start = l;
    const m = /\[ready\] logged in as (\S+) id=(\d+)/.exec(l);
    if (m) ready = { tag: m[1], id: m[2], line: l };
    if (/\[(error|stop)\]|cannot |failed|❌/i.test(l) && !/\[stop\] (done|stop command|SIG)/.test(l)) errors.push(l);
  }
  return { start, ready, errors: errors.slice(-5) };
}

async function getStatus(p) {
  const running = await isRunning(p);
  const pid = readPid(p);
  const log = parseLog(readLines(p.log));
  const errTail = readLines(p.errLog).slice(-5);
  return {
    home: p.home,
    running,
    pid: running ? pid : null,
    stalePid: !running && pid && pidAlive(pid) ? pid : null,
    loggedInAs: running ? log.ready?.tag ?? null : null,
    botId: running ? log.ready?.id ?? null : null,
    lastStart: log.start,
    recentErrors: log.errors,
    stderrTail: errTail,
    config: configSummary(p.config),
    pin: { set: fs.existsSync(p.pin), ...(running ? JSON.parse((await pipeRequest(stopPipe(p.home), 'pin-state')) || '{}') : {}) },
    roster: rosterCounts(p.roster),
    runtime: runtimeState(p),
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

async function start(p, { wait = READY_WAIT_S, update = true } = {}) {
  requireNode();
  const cfg = configSummary(p.config);
  if (!cfg.hasToken) throw new CliError(`${p.config} 裡沒有 Bot token。請先執行 setup，匯入管理員給的交付檔。`);
  syncCtl(p);
  if (await isRunning(p)) {
    const s = parseLog(readLines(p.log));
    console.log(`✅ Bot 已經在執行中（${s.ready ? `登入成 ${s.ready.tag}` : '尚未登入完成'}），不用再啟動。`);
    console.log('綁定的頻道：');
    printChannels(cfg.channels);
    return true;
  }
  const rt = runtimeState(p);
  if (!rt.upToDate) {
    if (!update && rt.installed) console.log('⚠️  runtime 不是最新版，這次先用舊版啟動。');
    else await installRuntime(p);
  }

  rotate(p.log, p.prevLog);
  rotate(p.errLog, p.prevErrLog);
  const out = fs.openSync(p.log, 'a');
  const err = fs.openSync(p.errLog, 'a');
  const child = spawn(process.execPath, [p.bot], {
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
  if (!wait) return true;

  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const s = parseLog(readLines(p.log));
    if (s.ready) {
      console.log(`✅ Bot 已上線：登入成 ${s.ready.tag}（Discord ID ${s.ready.id}）`);
      console.log('綁定的頻道：');
      printChannels(cfg.channels);
      console.log('Bot 在背景執行，關掉這個視窗或 Claude Code 都不會停；要停止請用 stop。');
      return true;
    }
    if (exited !== null) break;
  }
  const s = parseLog(readLines(p.log));
  console.log(exited !== null ? `❌ Bot 啟動失敗，程序已結束（代碼 ${exited}）。` : `❌ ${wait} 秒內沒有上線。`);
  for (const l of [...s.errors, ...readLines(p.errLog).slice(-8)]) console.log(`   ${l}`);
  console.log('   常見原因：token 失效（請管理員重給交付檔）、網路連不到 discord.com、Message Content Intent 沒開。');
  process.exitCode = 1;
  return false;
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

async function stop(p) {
  if (!(await isRunning(p))) {
    const pid = readPid(p);
    console.log('Bot 沒有在執行。');
    if (pid && pidAlive(pid)) console.log(`⚠️  ${p.pid} 記錄的程序 ${pid} 還在，如果確定是卡住的 Bot，可以執行：taskkill /T /F /PID ${pid}`);
    return true;
  }
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
    return false;
  }
  if (left.length) {
    console.log(`⚠️  Bot 已停止，但還有殘留程序：${left.join(', ')}。可以用 taskkill /T /F /PID <pid> 結束。`);
    process.exitCode = 1;
    return false;
  }
  console.log(`✅ Bot 已停止（pid ${pid ?? '?'}${kids.length ? `，連同 ${kids.length} 個子程序` : ''}），沒有殘留程序。`);
  return true;
}

// ---------------------------------------------------------------------------
// 雙擊用的啟動／停止檔（.bat）
// ---------------------------------------------------------------------------
export const LAUNCHER_NAMES = {
  start: '啟動 channelcollab Bot.bat',
  stop: '停止 channelcollab Bot.bat',
  'set-pin': '設定 channelcollab PIN.bat',
  unlock: '解除 channelcollab 鎖定.bat',
};

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

function makeLaunchers(p, dir) {
  if (!runtimeState(p).installed) throw new CliError('runtime 還沒安裝。請先執行 install-runtime 或 start。');
  syncCtl(p);
  const target = path.resolve(dir || desktopDir());
  fs.mkdirSync(target, { recursive: true });
  const files = [];
  for (const action of Object.keys(LAUNCHER_NAMES)) {
    const file = path.join(target, LAUNCHER_NAMES[action]);
    fs.writeFileSync(file, launcherBat(p, action), 'utf8');
    files.push(file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
function printDm(dm, pinSet) {
  if (!dm) return console.log('私訊：未開啟（要用的話：bind --dm --cwd <資料夾>，並先設定 PIN）');
  console.log(`私訊：開啟 → ${dm.cwd}（模型 ${dm.model ?? '預設'}，權限模式 ${dm.permission_mode ?? '沿用預設'}${dm.launcher ? `，啟動器 ${dm.launcher}` : ''}）${pinSet ? '' : '　⚠️ 還沒設定 PIN，私訊暫不開放'}`);
}

function printChannels(channels) {
  const ids = Object.keys(channels);
  if (!ids.length) return console.log('  （還沒有綁定任何頻道）');
  for (const id of ids) {
    const c = channels[id];
    console.log(`  - 頻道 ${id} → ${c.cwd}（模型 ${c.model ?? '預設'}，權限模式 ${c.permission_mode ?? '沿用預設'}${c.launcher ? `，啟動器 ${c.launcher}` : ''}）`);
  }
}

function printStatus(s) {
  console.log(`HOME：${s.home}`);
  if (s.running) console.log(`✅ Bot 執行中（pid ${s.pid ?? '?'}）${s.loggedInAs ? `，登入成 ${s.loggedInAs}（ID ${s.botId}）` : '，尚未登入完成'}`);
  else console.log('⏹  Bot 沒有在執行');
  if (s.stalePid) console.log(`⚠️  bot.pid 記錄的程序 ${s.stalePid} 還在，但沒有回應；可能卡住了`);
  const c = s.config;
  if (!c.exists) console.log('❌ 還沒有設定檔（請執行 setup）');
  else {
    console.log(`${c.hasToken ? '✅' : '❌'} Bot token ${c.hasToken ? '已設定' : '未設定'}`);
    console.log(`${c.ownerId ? '✅' : '⚠️ '} 主人 Discord ID：${c.ownerId ?? '未設定（權限按鈕需要）'}`);
    console.log('綁定的頻道：');
    printChannels(c.channels);
    printDm(c.dm, s.pin?.set);
    console.log(`白名單：${c.rosterOnly ? '開啟（只有主人和名冊上的人、Bot 能叫 Bot）' : '⚠️ 關閉（伺服器裡任何人都能叫 Bot）'}`);
  }
  const pin = s.pin ?? {};
  if (!pin.set) console.log('⚠️  PIN：未設定（建議設定：set-pin，或雙擊桌面的「設定 channelcollab PIN.bat」；私訊需要 PIN）');
  else console.log(`✅ PIN：已設定${pin.locked ? '，🔒 目前鎖定中（輸錯太多次，用 unlock 解除）' : ''}`);
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
// 參數與子命令
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
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
    await start(p, { wait: opts.wait === undefined ? READY_WAIT_S : Number(opts.wait), update: !opts['no-update'] });
  },
  async stop(p) {
    await stop(p);
  },
  async status(p, opts) {
    const s = await getStatus(p);
    if (opts.json) return console.log('RESULT ' + JSON.stringify(s));
    printStatus(s);
  },
  async shortcut(p, opts) {
    const files = makeLaunchers(p, typeof opts.dir === 'string' ? opts.dir : undefined);
    console.log('✅ 已建立雙擊用的檔案：');
    for (const f of files) console.log(`  - ${f}`);
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
       [--launcher <路徑>] [--tools Read,Grep,...]
                                          新增或修改頻道綁定（只給要改的欄位）
  bind --remove --channel <ID>            移除頻道綁定
  bind --dm --cwd <資料夾> [--model ...] [--permission-mode ...] [--launcher <路徑>]
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
  start [--wait <秒>] [--no-update]       在背景啟動 Bot，等它上線
  stop                                    停止 Bot，並確認沒有殘留程序
  status [--json]                         Bot 是否在跑、登入成誰、綁定、最近錯誤
  shortcut [--dir <資料夾>]               產生雙擊用的啟動／停止 .bat（預設放桌面）
  --self-test                             自我測試

HOME：--home 優先，其次 CHANNELCOLLAB_HOME，預設 %USERPROFILE%\\.channelcollab`;

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
