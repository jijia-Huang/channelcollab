#!/usr/bin/env node
// channelcollab.mjs — channelcollab 的總控腳本（只用 Node 22 內建功能，安裝 runtime 之前就能執行）
//
// 子命令：
//   check                      檢查 Node、npm、runtime、設定檔、Bot 是否在跑
//   install-runtime [--force]  把 plugin 內的 runtime 安裝到 <HOME>\runtime（npm ci，依賴版本固定）
//   set-owner <Discord ID>     寫入 config.json 的 discord.owner_id（Bot 的主人，可以按權限按鈕）
//   bind ...                   新增、修改、移除、列出頻道綁定
//   import-roster <檔案>       匯入管理員給的名冊，存成 <HOME>\roster.json
//   start | stop | status      啟動（背景執行）、停止、查看狀態
//   shortcut [--dir <資料夾>]   產生雙擊用的「啟動／停止 channelcollab Bot.bat」（預設放桌面）
//   --self-test                不需要 token 的自我測試
//
// HOME：--home <路徑> 優先，其次環境變數 CHANNELCOLLAB_HOME，預設 %USERPROFILE%\.channelcollab。
// 安全：config.json 含 Discord token。本腳本只讀寫 token 以外的欄位，任何輸出都不含 token。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  return {
    exists: true,
    hasToken: typeof c.discord?.token === 'string' && c.discord.token.length > 0,
    ownerId: c.discord?.owner_id ?? null,
    guildId: c.discord?.guild_id ?? null,
    defaultMode: c.defaults?.permission_mode ?? null,
    channels,
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
  c.channels = { ...(c.channels ?? {}), [channel]: next };
  c.defaults = { permission_mode: 'default', ...(c.defaults ?? {}) };
  writeJson(file, c);
  return { action: prev ? 'updated' : 'added', channel: next };
}

export function unbindChannel(file, channel) {
  const c = readConfig(file);
  if (!c.channels?.[channel]) return false;
  delete c.channels[channel];
  writeJson(file, c);
  return true;
}

/** 名冊格式檢查：{ version, bots: [{ botId, botName, ownerName, ownerDiscordId, role }] } */
export function validateRoster(data) {
  if (!data || !Array.isArray(data.bots)) throw new CliError('名冊格式不對：缺少 bots 陣列');
  data.bots.forEach((b, i) => {
    for (const k of ['botId', 'ownerDiscordId']) {
      if (!SNOWFLAKE.test(String(b?.[k] ?? ''))) throw new CliError(`名冊第 ${i + 1} 筆的 ${k} 格式不對`);
    }
    for (const k of ['botName', 'ownerName', 'role']) {
      if (typeof b?.[k] !== 'string' || !b[k]) throw new CliError(`名冊第 ${i + 1} 筆缺少 ${k}`);
    }
  });
  if (JSON.stringify(data).match(/[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/)) {
    throw new CliError('名冊裡有看起來像 token 的字串，已拒絕匯入。名冊不應該包含 token。');
  }
  return data;
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
    roster: fs.existsSync(p.roster) ? (readJson(p.roster, { bots: [] }).bots ?? []).length : null,
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
export const LAUNCHER_NAMES = { start: '啟動 channelcollab Bot.bat', stop: '停止 channelcollab Bot.bat' };

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
  for (const action of ['start', 'stop']) {
    const file = path.join(target, LAUNCHER_NAMES[action]);
    fs.writeFileSync(file, launcherBat(p, action), 'utf8');
    files.push(file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
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
  }
  console.log(`名冊：${s.roster === null ? '沒有（<HOME>\\roster.json 不存在）' : `${s.roster} 個 Bot`}`);
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
      return printChannels(configSummary(p.config).channels);
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
  async 'import-roster'(p, opts) {
    const src = opts._[1];
    if (!src) throw new CliError('用法：import-roster <名冊檔案>');
    const data = validateRoster(readJson(path.resolve(src), null));
    writeJson(p.roster, { version: data.version ?? 1, bots: data.bots });
    console.log(`✅ 已匯入名冊（${data.bots.length} 個 Bot）到 ${p.roster}；下一個新的對話開始生效，不用重啟 Bot。`);
    for (const b of data.bots) console.log(`  - ${b.botName}：主人 ${b.ownerName}，角色 ${b.role}`);
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
  bind --list                             列出頻道綁定
  import-roster <檔案>                    匯入管理員給的名冊
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

  console.log('名冊');
  const bot = { botId: '111111111111111111', botName: '範例Bot', ownerName: '小明', ownerDiscordId: '222222222222222222', role: 'planner' };
  await t('合法名冊通過；缺欄位、ID 錯誤、夾帶 token 都拒絕', () => {
    validateRoster({ version: 1, bots: [bot] });
    throws(() => validateRoster({}), /bots/);
    throws(() => validateRoster({ bots: [{ ...bot, botId: 'x' }] }), /botId/);
    throws(() => validateRoster({ bots: [{ ...bot, botName: '' }] }), /botName/);
    throws(() => validateRoster({ bots: [{ ...bot, note: FAKE }] }), /token/);
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
