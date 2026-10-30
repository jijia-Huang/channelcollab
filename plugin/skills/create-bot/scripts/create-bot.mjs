#!/usr/bin/env node
// create-bot.mjs — 建立 Discord Bot 的輔助腳本（只用 Node 22 內建功能，無任何 npm 依賴）
//
// 子命令：
//   save-token     從剪貼簿讀取 Bot token、向 Discord 驗證後存檔（自己用 → config.json；幫成員建 → 交付檔）
//   import-handoff 成員把管理員給的交付檔匯入自己的 config.json（連同主人 ID 與名冊）
//   verify         檢查 token、Message Content Intent、Public Bot、所屬 Team、是否已在指定伺服器
//   invite         產生 OAuth2 邀請網址
//   roster         產生名冊資料並寫入／合併到 roster.json（加 --handoff 時一併附進交付檔）
//   --self-test    不需要 token 的自我測試
//
// HOME：--home <路徑> 優先，其次環境變數 CHANNELCOLLAB_HOME，預設 %USERPROFILE%\.channelcollab。
//   config.json、roster.json、handoff\ 都在 HOME 底下。
//
// 安全原則：
//   - token 絕不從命令列參數傳入（會留在 shell 歷史與對話中）。來源只有剪貼簿、config.json、交付檔。
//   - 所有輸出都經過遮罩：已知的 token 一律替換成「****末4碼」。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (channelcollab-create-bot, 1.0)';

/** Bot 的資料夾：--home 優先，其次 CHANNELCOLLAB_HOME，預設 ~/.channelcollab（與 src/config.ts 一致） */
export function resolveHome(opts = {}, env = process.env) {
  const h = typeof opts['home'] === 'string' ? opts['home'] : env.CHANNELCOLLAB_HOME || path.join(os.homedir(), '.channelcollab');
  return path.resolve(h);
}

/** config.json、roster.json、交付檔資料夾的預設位置，全部跟著 HOME */
export function defaultPaths(opts = {}, env = process.env) {
  const home = resolveHome(opts, env);
  return {
    home,
    config: path.join(home, 'config.json'),
    roster: path.join(home, 'roster.json'),
    handoffDir: path.join(home, 'handoff'),
  };
}

// ---------------------------------------------------------------------------
// 權限 bit（Discord「Bitwise Permission Flags」表）
// 來源：https://docs.discord.com/developers/topics/permissions
// 有幾個 bit 超過 32 位元，必須用 BigInt（JS 的 1 << 34 會溢位）。
// ---------------------------------------------------------------------------
export const PERMISSIONS = [
  // [Portal 上的名稱, API 名稱, 值]
  ['Add Reactions', 'ADD_REACTIONS', 1n << 6n], //                 0x0000000000000040
  ['View Channels', 'VIEW_CHANNEL', 1n << 10n], //                 0x0000000000000400
  ['Send Messages', 'SEND_MESSAGES', 1n << 11n], //                0x0000000000000800
  ['Embed Links', 'EMBED_LINKS', 1n << 14n], //                    0x0000000000004000
  ['Attach Files', 'ATTACH_FILES', 1n << 15n], //                  0x0000000000008000
  ['Read Message History', 'READ_MESSAGE_HISTORY', 1n << 16n], //  0x0000000000010000
  ['Manage Threads', 'MANAGE_THREADS', 1n << 34n], //              0x0000000400000000（改論壇標籤需要）
  ['Create Public Threads', 'CREATE_PUBLIC_THREADS', 1n << 35n], // 0x0000000800000000
  ['Send Messages in Threads', 'SEND_MESSAGES_IN_THREADS', 1n << 38n], // 0x0000004000000000
];

export function permissionInteger(perms = PERMISSIONS) {
  return perms.reduce((acc, [, , bit]) => acc | bit, 0n);
}

// ---------------------------------------------------------------------------
// Application flags（Discord「Application Flags」表）
// 來源：https://docs.discord.com/developers/resources/application#application-object-application-flags
//   GATEWAY_MESSAGE_CONTENT         1 << 18 = 262144  （Bot 在 100 個以上伺服器、已通過審核）
//   GATEWAY_MESSAGE_CONTENT_LIMITED 1 << 19 = 524288  （未滿 100 個伺服器，Portal 的 Bot 頁籤開關就是這個）
// 任一個有設定即代表 Message Content Intent 已開。
// ---------------------------------------------------------------------------
export const GATEWAY_MESSAGE_CONTENT = 1n << 18n;
export const GATEWAY_MESSAGE_CONTENT_LIMITED = 1n << 19n;

export function hasMessageContentIntent(app) {
  // flags 是 31 位元內的數字；較新的 flags_new 是字串，有就優先用
  const raw = app.flags_new ?? app.flags ?? 0;
  const flags = BigInt(raw);
  return (flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0n;
}

// ---------------------------------------------------------------------------
// 遮罩：所有寫到 stdout / stderr 的內容都會把已登記的 token 換成「****末4碼」
// ---------------------------------------------------------------------------
const SECRETS = new Set();

export function mask(token) {
  return token ? `****${token.slice(-4)}` : '(無)';
}

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 20) SECRETS.add(value);
}

export function redact(text) {
  let out = String(text);
  for (const s of SECRETS) out = out.split(s).join(mask(s));
  return out;
}

for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) chunk = redact(chunk.toString());
    return original(chunk, ...rest);
  };
}

class CliError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// token 格式檢查（只看形狀，真正有效與否交給 Discord API）
// ---------------------------------------------------------------------------
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

export function normalizeToken(raw) {
  let t = String(raw ?? '').trim();
  if (/^bot\s+/i.test(t)) t = t.replace(/^bot\s+/i, '');
  if (!t) return { ok: false, reason: '剪貼簿是空的。請在 Bot 頁籤 token 旁按「Copy」後再試一次。' };
  if (/\s/.test(t)) {
    return { ok: false, reason: `剪貼簿內容不像 token（含空白或多行，共 ${t.length} 字元）。請只複製 token 本身。` };
  }
  if (!t.includes('.') && /^[A-Za-z0-9_-]{32}$/.test(t)) {
    return {
      ok: false,
      reason: '剪貼簿內容看起來是 OAuth2 頁面的 Client Secret，不是 Bot token。請到 Bot 頁籤按 Reset Token 後複製。',
    };
  }
  if (!TOKEN_SHAPE.test(t)) {
    return { ok: false, reason: `剪貼簿內容不像 Bot token（長度 ${t.length}）。請確認複製的是 Bot 頁籤的 token。` };
  }
  return { ok: true, token: t };
}

export function isSnowflake(v) {
  return typeof v === 'string' && /^\d{17,20}$/.test(v);
}

// ---------------------------------------------------------------------------
// 剪貼簿
// ---------------------------------------------------------------------------
function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readClipboard() {
  try {
    if (process.platform === 'win32') {
      return run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw',
      ]);
    }
    if (process.platform === 'darwin') return run('pbpaste', []);
    for (const [cmd, args] of [
      ['wl-paste', ['-n']],
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['-b', '-o']],
    ]) {
      try {
        return run(cmd, args);
      } catch {}
    }
    throw new Error('找不到 wl-paste / xclip / xsel');
  } catch (e) {
    throw new CliError(`讀不到剪貼簿：${e.message.split('\n')[0]}`);
  }
}

function clearClipboard() {
  try {
    if (process.platform === 'win32') {
      run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()',
      ]);
    } else if (process.platform === 'darwin') {
      run('pbcopy', [], '');
    } else {
      try {
        run('wl-copy', ['--clear']);
      } catch {
        run('xclip', ['-selection', 'clipboard'], '');
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSON 檔讀寫（合併、不覆蓋其他欄位、原子寫入）
// ---------------------------------------------------------------------------
export function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${file} 不是合法的 JSON（${e.message}）。為避免覆蓋你的設定，已停止；請先修正該檔案。`);
  }
}

export function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 把 token 合併進 config.json 的 discord.token，其他欄位原樣保留 */
export function mergeTokenIntoConfig(file, token) {
  const config = readJsonFile(file, {});
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new CliError(`${file} 的最外層不是物件，已停止以免覆蓋。`);
  }
  if (config.discord !== undefined && (typeof config.discord !== 'object' || config.discord === null)) {
    throw new CliError(`${file} 的 discord 欄位不是物件，已停止以免覆蓋。`);
  }
  const previous = config.discord?.token;
  config.discord = { ...(config.discord ?? {}), token };
  writeJsonFile(file, config);
  return { replaced: typeof previous === 'string' && previous !== token, previousTail: previous ? mask(previous) : null };
}

export function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'member';
}

// ---------------------------------------------------------------------------
// 名冊
// 格式：{ "version": 1, "bots": [ { botId, botName, applicationId, ownerName, ownerDiscordId, role, updatedAt } ] }
// 以 botId 為鍵合併；role 只能是 engineer（工程師）或 planner（企劃）。
// ---------------------------------------------------------------------------
const ROLE_ALIASES = { engineer: 'engineer', 工程師: 'engineer', planner: 'planner', 企劃: 'planner', 企画: 'planner' };

export function normalizeRole(role) {
  const r = ROLE_ALIASES[String(role ?? '').trim().toLowerCase()] ?? ROLE_ALIASES[String(role ?? '').trim()];
  if (!r) throw new CliError(`角色必須是 engineer／工程師 或 planner／企劃（收到：${role}）`);
  return r;
}

export function buildRosterEntry({ botId, botName, applicationId, ownerName, ownerDiscordId, role }) {
  if (!isSnowflake(botId)) throw new CliError(`Bot ID 格式不對（應為 17–20 位數字）：${botId}`);
  if (!botName) throw new CliError('缺少 Bot 名稱');
  if (!ownerName) throw new CliError('缺少主人名稱（--owner-name）');
  if (!isSnowflake(ownerDiscordId)) {
    throw new CliError(`主人的 Discord 使用者 ID 格式不對（應為 17–20 位數字）：${ownerDiscordId}`);
  }
  const entry = { botId, botName, ownerName, ownerDiscordId, role: normalizeRole(role) };
  if (applicationId) entry.applicationId = applicationId;
  entry.updatedAt = new Date().toISOString();
  return entry;
}

export function upsertRoster(file, entry) {
  const roster = readJsonFile(file, { version: 1, bots: [] });
  if (!Array.isArray(roster.bots)) throw new CliError(`${file} 格式不對（缺少 bots 陣列），已停止以免覆蓋。`);
  const idx = roster.bots.findIndex((b) => b.botId === entry.botId);
  const warnings = roster.bots
    .filter((b) => b.botId !== entry.botId && b.ownerDiscordId === entry.ownerDiscordId)
    .map((b) => `注意：主人 ${entry.ownerDiscordId} 已經有另一個 Bot「${b.botName}」(${b.botId})`);
  if (idx >= 0) roster.bots[idx] = { ...roster.bots[idx], ...entry };
  else roster.bots.push(entry);
  roster.version ??= 1;
  writeJsonFile(file, roster);
  return { action: idx >= 0 ? 'updated' : 'added', count: roster.bots.length, warnings };
}

// ---------------------------------------------------------------------------
// 邀請網址
// 來源：https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow
//   https://discord.com/oauth2/authorize?client_id=…&scope=bot%20applications.commands&permissions=…
//   guild_id 預先選好伺服器；disable_guild_select=true 讓使用者不能改；integration_type=0 為安裝到伺服器
// ---------------------------------------------------------------------------
export function buildInviteUrl({ applicationId, guildId, lockGuild = false }) {
  if (!isSnowflake(applicationId)) throw new CliError(`Application ID 格式不對：${applicationId}`);
  if (guildId !== undefined && !isSnowflake(guildId)) throw new CliError(`伺服器 ID 格式不對：${guildId}`);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', applicationId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', permissionInteger().toString());
  url.searchParams.set('integration_type', '0');
  if (guildId) {
    url.searchParams.set('guild_id', guildId);
    if (lockGuild) url.searchParams.set('disable_guild_select', 'true');
  }
  // URLSearchParams 會把空白編成 +；改成 %20 比較通用
  return url.toString().replace(/\+/g, '%20');
}

// ---------------------------------------------------------------------------
// Discord REST API v10
// ---------------------------------------------------------------------------
async function api(token, route, { retried = false } = {}) {
  let res;
  try {
    res = await globalThis.fetch(API + route, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '逾時' : e?.cause?.code || e?.message || String(e);
    throw new CliError(`連不到 Discord API（${why}）。請確認網路連線，或公司網路是否擋了 discord.com。`, 'network');
  }
  if (res.status === 401) {
    throw new CliError(
      'Discord 回應 401：token 無效。可能是複製錯了、或 token 之後又被 Reset 過。請回 Bot 頁籤重新 Reset Token 並複製。',
      'unauthorized',
    );
  }
  if (res.status === 429 && !retried) {
    const body = await res.json().catch(() => ({}));
    const wait = Math.min(Number(body.retry_after ?? 1), 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(token, route, { retried: true });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CliError(`Discord API ${route} 回應 ${res.status}${body.message ? `：${body.message}` : ''}`, 'http');
  }
  return res.json();
}

async function listBotGuilds(token) {
  const guilds = [];
  let after;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: '200' });
    if (after) q.set('after', after);
    const batch = await api(token, `/users/@me/guilds?${q}`);
    guilds.push(...batch);
    if (batch.length < 200) break;
    after = batch[batch.length - 1].id;
  }
  return guilds;
}

/** 取得 Bot 與 Application 基本資料；token 無效會丟 CliError */
export async function fetchIdentity(token) {
  const me = await api(token, '/users/@me');
  const app = await api(token, '/applications/@me');
  return { me, app };
}

/** 跑所有檢查，回傳結果陣列（不直接印出，方便測試） */
export async function runChecks(token, { guildId, teamId } = {}) {
  const checks = [];
  let me, app;
  try {
    ({ me, app } = await fetchIdentity(token));
  } catch (e) {
    checks.push({ ok: false, title: 'token 驗證失敗', detail: e.message, fatal: true });
    return { checks };
  }
  const botName = me.global_name || me.username;
  checks.push({ ok: true, title: `token 有效：Bot「${botName}」（使用者名稱 ${me.username}，ID ${me.id}）` });

  const appId = app.id;
  const portal = `https://discord.com/developers/applications/${appId}`;

  if (hasMessageContentIntent(app)) {
    checks.push({ ok: true, title: 'Message Content Intent 已開啟' });
  } else {
    checks.push({
      ok: false,
      title: 'Message Content Intent 沒有開',
      fix: `到 ${portal}/bot → Privileged Gateway Intents → 打開「Message Content Intent」→ 按 Save Changes。`,
    });
  }

  if (app.bot_public === false) {
    checks.push({ ok: true, title: 'Public Bot 已關閉（只有擁有者能把 Bot 加進伺服器）' });
  } else {
    checks.push({
      ok: false,
      title: 'Public Bot 還是開著（任何人拿到邀請網址都能把 Bot 拉進他的伺服器）',
      fix:
        `1) 先到 ${portal}/installation，把 Install Link 改成「None」並儲存` +
        '（否則關 Public Bot 時會出現「Private application cannot have a default authorization link」錯誤）；' +
        `2) 再到 ${portal}/bot 關閉「Public Bot」→ Save Changes。`,
    });
  }

  if (app.team) {
    const ok = !teamId || app.team.id === teamId;
    checks.push({
      ok,
      title: ok
        ? `建在 Team「${app.team.name}」(ID ${app.team.id}) 底下`
        : `建在 Team「${app.team.name}」(ID ${app.team.id})，不是指定的 Team ${teamId}`,
      fix: ok ? undefined : `到 ${portal}/information 底部使用「Transfer App to Team」轉移到正確的 Team。`,
    });
  } else {
    const ownerName = app.owner?.global_name || app.owner?.username || '個人帳號';
    checks.push({
      ok: !teamId,
      warn: !teamId,
      title: `建在個人帳號「${ownerName}」底下（不在 Team 裡）`,
      fix: `之後可到 ${portal}/information 底部使用「Transfer App to Team」轉移到 Team（需要兩步驟驗證）。`,
    });
  }

  let inviteUrl;
  if (guildId) {
    inviteUrl = buildInviteUrl({ applicationId: appId, guildId, lockGuild: true });
    try {
      const guilds = await listBotGuilds(token);
      const hit = guilds.find((g) => g.id === guildId);
      if (hit) {
        checks.push({ ok: true, title: `已在伺服器「${hit.name}」(ID ${guildId}) 裡` });
      } else {
        checks.push({
          ok: false,
          title: `還沒加入伺服器 ${guildId}（目前在 ${guilds.length} 個伺服器）`,
          fix:
            `開啟邀請網址，確認伺服器後按「授權」：${inviteUrl}` +
            '（授權頁的伺服器欄位如果是空白，請確認 --guild-id 是伺服器 ID 而不是頻道 ID）',
        });
      }
    } catch (e) {
      checks.push({ ok: false, title: '無法取得 Bot 所在的伺服器清單', detail: e.message });
    }
  } else {
    checks.push({ ok: true, warn: true, title: '沒有指定 --guild-id，略過伺服器檢查' });
  }

  return {
    checks,
    bot: { id: me.id, name: botName, username: me.username },
    applicationId: appId,
    team: app.team ? { id: app.team.id, name: app.team.name } : null,
    inviteUrl,
  };
}

// ---------------------------------------------------------------------------
// token 來源（只有剪貼簿、config.json、交付檔；不收命令列參數）
// ---------------------------------------------------------------------------
function loadToken(opts) {
  if (opts['token']) throw new CliError('為了安全，token 不能從命令列傳入。請用剪貼簿（--from-clipboard）或設定檔。');
  if (opts['from-clipboard']) {
    const raw = readClipboard();
    registerSecret(raw.trim());
    const n = normalizeToken(raw);
    if (!n.ok) throw new CliError(n.reason, 'bad-token');
    registerSecret(n.token);
    return { token: n.token, source: '剪貼簿' };
  }
  const file = opts['handoff'] ? path.resolve(opts['handoff']) : path.resolve(opts['config'] ?? defaultPaths(opts).config);
  if (!fs.existsSync(file)) {
    throw new CliError(`找不到 ${file}。請先執行 save-token（或 import-handoff）把 token 存進來。`, 'no-token');
  }
  const data = readJsonFile(file, {});
  const token = data?.discord?.token;
  if (typeof token !== 'string' || !token) throw new CliError(`${file} 裡沒有 discord.token。`, 'no-token');
  registerSecret(token);
  return { token, source: file };
}

// ---------------------------------------------------------------------------
// 參數解析
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

function printChecks(result) {
  for (const c of result.checks) {
    const icon = c.ok ? (c.warn ? '⚠️ ' : '✅') : '❌';
    console.log(`${icon} ${c.title}`);
    if (c.detail) console.log(`   ${c.detail}`);
    if (c.fix && (!c.ok || c.warn)) console.log(`   修正：${c.fix}`);
  }
}

function printPermissions() {
  console.log(`權限整數：${permissionInteger()}`);
  for (const [name, api, bit] of PERMISSIONS) {
    console.log(`  - ${name} (${api}) = 0x${bit.toString(16).padStart(16, '0')}`);
  }
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function cmdSaveToken(opts) {
  const forWho = opts['for'] ?? 'self';
  if (!['self', 'member'].includes(forWho)) throw new CliError('--for 只能是 self 或 member');
  if (forWho === 'member' && !opts['member']) throw new CliError('幫成員建時要加 --member <成員名稱>');
  if (opts['owner-id'] !== undefined && !isSnowflake(opts['owner-id'])) {
    throw new CliError(`--owner-id 格式不對（應為 17–20 位數字）：${opts['owner-id']}`);
  }

  const { token } = loadToken({ 'from-clipboard': true });
  console.log(`已從剪貼簿讀到 token（${mask(token)}），向 Discord 驗證中…`);
  const { me, app } = await fetchIdentity(token);
  const botName = me.global_name || me.username;
  console.log(`✅ token 有效：Bot「${botName}」(ID ${me.id})，Application ID ${app.id}`);

  let savedTo;
  if (forWho === 'self') {
    const file = path.resolve(opts['config'] ?? defaultPaths(opts).config);
    const r = mergeTokenIntoConfig(file, token);
    savedTo = file;
    console.log(`✅ 已寫入 ${file} 的 discord.token（其他欄位保留不動）`);
    if (r.replaced) console.log(`   取代了舊的 token（${r.previousTail}）`);
  } else {
    const dir = path.resolve(opts['handoff-dir'] ?? defaultPaths(opts).handoffDir);
    const file = path.join(dir, `${safeFileName(opts['member'])}-bot.json`);
    const owner = { name: opts['member'] };
    if (opts['owner-id']) owner.discordId = opts['owner-id'];
    writeJsonFile(file, {
      _readme:
        '這是 Discord Bot token 交付檔。請私下交給本人（私訊或當面），不要貼在任何公開頻道或群組。' +
        '本人匯入後請刪除此檔。',
      discord: { token },
      bot: { id: me.id, name: botName, applicationId: app.id },
      owner,
      createdAt: new Date().toISOString(),
    });
    savedTo = file;
    console.log(`✅ 已存成交付檔：${file}`);
    console.log('   寫好名冊後執行 roster --handoff <這個檔案>，名冊和主人 ID 會一起附進交付檔。');
    console.log('   請私下（私訊或當面）把這個檔案交給本人，不要貼在公開頻道；對方匯入後請刪除兩邊的檔案。');
    console.log('   對方在 Claude Code 執行 /channelcollab:setup，照指示匯入即可。');
  }

  if (!opts['keep-clipboard']) {
    // 只有剪貼簿內容還是這個 token 時才清除，避免清掉使用者後來複製的其他東西
    let still = false;
    try {
      still = normalizeToken(readClipboard()).token === token;
    } catch {}
    if (still) console.log(clearClipboard() ? '✅ 已清除剪貼簿中的 token' : '⚠️  無法自動清除剪貼簿，請隨便複製一段其他文字覆蓋掉。');
  }

  if (opts['json']) {
    console.log('RESULT ' + JSON.stringify({ botId: me.id, botName, applicationId: app.id, savedTo }));
  }
}

/**
 * 把交付檔寫進成員自己的 HOME：token → config.json 的 discord.token；主人 ID → discord.owner_id；
 * 附帶的名冊 → roster.json。config.json 已經有「另一個」Bot 的 token 時，沒有 replace 就停止，
 * 避免一台電腦上的既有 Bot 被覆蓋（要跑第二個 Bot 請用另一個 HOME）。
 */
export function applyHandoff({ handoff, token, configFile, rosterFile, replace = false }) {
  const config = readJsonFile(configFile, {});
  const previous = config?.discord?.token;
  if (typeof previous === 'string' && previous && previous !== token && !replace) {
    throw new CliError(
      `${configFile} 已經有另一個 Bot 的 token（${mask(previous)}），為避免覆蓋已停止。` +
        '要在這台電腦再跑一個 Bot，請用另一個 HOME；確定要取代時加 --replace。',
      'exists',
    );
  }
  mergeTokenIntoConfig(configFile, token);
  let ownerId = null;
  const wantOwner = handoff?.owner?.discordId;
  if (isSnowflake(wantOwner)) {
    const c = readJsonFile(configFile, {});
    c.discord = { ...(c.discord ?? {}), owner_id: wantOwner };
    writeJsonFile(configFile, c);
    ownerId = wantOwner;
  }
  let rosterCount = null;
  if (Array.isArray(handoff?.roster?.bots)) {
    writeJsonFile(rosterFile, { version: handoff.roster.version ?? 1, bots: handoff.roster.bots });
    rosterCount = handoff.roster.bots.length;
  }
  return { ownerId, rosterCount, replaced: typeof previous === 'string' && !!previous && previous !== token };
}

async function cmdImportHandoff(opts) {
  const src = opts._[1] ?? opts['handoff'];
  if (!src || src === true) throw new CliError('用法：import-handoff <交付檔路徑>');
  const handoffFile = path.resolve(src);
  const { token } = loadToken({ handoff: handoffFile });
  const handoff = readJsonFile(handoffFile, {});
  const { me } = await fetchIdentity(token);
  const botName = me.global_name || me.username;
  if (handoff.bot?.id && handoff.bot.id !== me.id) {
    console.log(`⚠️  交付檔記載的 Bot ID（${handoff.bot.id}）與 token 實際的 Bot（${me.id}）不同，以 token 為準。`);
  }
  const paths = defaultPaths(opts);
  const configFile = path.resolve(opts['config'] ?? paths.config);
  const rosterFile = path.resolve(opts['roster'] ?? paths.roster);
  const r = applyHandoff({ handoff, token, configFile, rosterFile, replace: !!opts['replace'] });
  console.log(`✅ token 有效（Bot「${botName}」，ID ${me.id}），已寫入 ${configFile} 的 discord.token`);
  if (r.replaced) console.log('   取代了原本的 token');
  console.log(r.ownerId ? `✅ 主人 Discord ID：${r.ownerId}` : '⚠️  交付檔裡沒有主人的 Discord ID，請另外設定（set-owner）。');
  console.log(r.rosterCount !== null ? `✅ 名冊（${r.rosterCount} 個 Bot）已寫入 ${rosterFile}` : '⚠️  交付檔沒有附名冊，之後請向管理員要 roster.json 匯入。');
  let deleted = false;
  if (opts['delete-handoff']) {
    try {
      fs.rmSync(handoffFile);
      deleted = true;
      console.log(`✅ 已刪除交付檔 ${handoffFile}`);
    } catch (e) {
      console.log(`⚠️  無法刪除交付檔（${e.code ?? e.name}），請手動刪除：${handoffFile}`);
    }
  } else {
    console.log(`   交付檔裡是明文 token，請刪除：${handoffFile}`);
  }
  if (opts['json']) {
    console.log('RESULT ' + JSON.stringify({ botId: me.id, botName, ownerId: r.ownerId, rosterCount: r.rosterCount, configFile, deleted }));
  }
}

async function cmdVerify(opts) {
  const { token, source } = loadToken(opts);
  for (const k of ['guild-id', 'team-id']) {
    if (opts[k] !== undefined && !isSnowflake(opts[k])) throw new CliError(`--${k} 格式不對（應為 17–20 位數字）`);
  }
  console.log(`Discord Bot 設定檢查（token 來源：${source}，${mask(token)}）`);
  const result = await runChecks(token, { guildId: opts['guild-id'], teamId: opts['team-id'] });
  printChecks(result);
  const failed = result.checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n共 ${failed} 項需要修正。` : '\n全部通過。');
  if (opts['json']) {
    const { checks, ...rest } = result;
    console.log('RESULT ' + JSON.stringify({ ...rest, failed, checks: checks.map(({ ok, warn, title }) => ({ ok, warn: !!warn, title })) }));
  }
  process.exitCode = failed ? 1 : 0;
}

async function cmdInvite(opts) {
  let applicationId = opts['app-id'];
  if (!applicationId) {
    const { token } = loadToken(opts);
    ({ app: { id: applicationId } } = await fetchIdentity(token));
  }
  const url = buildInviteUrl({ applicationId, guildId: opts['guild-id'], lockGuild: !!opts['lock-guild'] });
  printPermissions();
  console.log(`\n邀請網址：\n${url}`);
}

async function cmdRoster(opts) {
  let { 'bot-id': botId, 'bot-name': botName, 'app-id': applicationId } = opts;
  if (!botId || !botName) {
    const { token } = loadToken(opts);
    const { me, app } = await fetchIdentity(token);
    botId = me.id;
    botName = me.global_name || me.username;
    applicationId = app.id;
  }
  const entry = buildRosterEntry({
    botId,
    botName,
    applicationId,
    ownerName: opts['owner-name'],
    ownerDiscordId: opts['owner-id'],
    role: opts['role'],
  });
  if (opts['print']) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }
  const file = path.resolve(opts['roster'] ?? defaultPaths(opts).roster);
  const r = upsertRoster(file, entry);
  console.log(`✅ 名冊${r.action === 'added' ? '新增' : '更新'}一筆：${entry.botName} → ${entry.ownerName}（${entry.role}），共 ${r.count} 筆`);
  console.log(`   檔案：${file}`);
  for (const w of r.warnings) console.log(`⚠️  ${w}`);
  if (opts['handoff']) {
    attachToHandoff(path.resolve(opts['handoff']), readJsonFile(file, { version: 1, bots: [] }), entry);
    console.log(`✅ 已把名冊（${r.count} 筆）與主人 ID 附進交付檔 ${path.resolve(opts['handoff'])}`);
  }
}

/** 把目前的名冊快照與主人資料寫進交付檔，成員匯入時一次到位。token 欄位原樣保留。 */
export function attachToHandoff(handoffFile, roster, entry) {
  const h = readJsonFile(handoffFile, null);
  if (!h?.discord?.token) throw new CliError(`${handoffFile} 不是交付檔（沒有 discord.token），已停止。`);
  h.owner = { ...(h.owner ?? {}), name: entry.ownerName, discordId: entry.ownerDiscordId, role: entry.role };
  h.roster = { version: roster.version ?? 1, bots: roster.bots };
  writeJsonFile(handoffFile, h);
}

// ---------------------------------------------------------------------------
// 自我測試（不需要 token、不連網路）
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
    if (a !== b) throw new Error(`${msg} 預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-bot-test-'));
  const FAKE = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', 'GxYzAb', 'fake_token_for_self_test_0123456789abcd'].join('.'); // 拆開寫，原始碼才不像真 token
  const APP = '123456789012345678';
  const GUILD = '987654321098765432';

  console.log('權限整數');
  await t('每個 bit 與官方表格的十六進位值一致', () => {
    const doc = {
      ADD_REACTIONS: 0x40n,
      VIEW_CHANNEL: 0x400n,
      SEND_MESSAGES: 0x800n,
      EMBED_LINKS: 0x4000n,
      ATTACH_FILES: 0x8000n,
      READ_MESSAGE_HISTORY: 0x10000n,
      MANAGE_THREADS: 0x400000000n,
      CREATE_PUBLIC_THREADS: 0x800000000n,
      SEND_MESSAGES_IN_THREADS: 0x4000000000n,
    };
    eq(PERMISSIONS.length, 9, '權限數量');
    for (const [, name, bit] of PERMISSIONS) eq(bit, doc[name], name);
  });
  await t('加總 = 326417632320（9 個 bit 互不重疊）', () => {
    const p = permissionInteger();
    eq(p, 326417632320n);
    eq(PERMISSIONS.reduce((a, [, , b]) => a + b, 0n), p, '相加與 OR 結果');
  });

  console.log('邀請網址');
  await t('基本格式：client_id、scope、permissions、integration_type', () => {
    const u = new URL(buildInviteUrl({ applicationId: APP }));
    eq(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
    eq(u.searchParams.get('client_id'), APP);
    eq(u.searchParams.get('scope'), 'bot applications.commands');
    eq(u.searchParams.get('permissions'), '326417632320');
    eq(u.searchParams.get('integration_type'), '0');
    eq(u.searchParams.has('guild_id'), false, 'guild_id');
    eq(buildInviteUrl({ applicationId: APP }).includes('scope=bot%20applications.commands'), true, '空白編碼');
  });
  await t('帶 guild_id 與鎖定伺服器', () => {
    const u = new URL(buildInviteUrl({ applicationId: APP, guildId: GUILD, lockGuild: true }));
    eq(u.searchParams.get('guild_id'), GUILD);
    eq(u.searchParams.get('disable_guild_select'), 'true');
  });
  await t('ID 格式錯誤會拒絕', () => {
    throws(() => buildInviteUrl({ applicationId: 'abc' }), /Application ID/);
    throws(() => buildInviteUrl({ applicationId: APP, guildId: '12' }), /伺服器 ID/);
  });

  console.log('Message Content Intent 判斷');
  await t('LIMITED (1<<19)、完整 (1<<18)、都沒有、flags_new 字串', () => {
    eq(hasMessageContentIntent({ flags: 524288 }), true, 'LIMITED');
    eq(hasMessageContentIntent({ flags: 262144 }), true, 'FULL');
    eq(hasMessageContentIntent({ flags: 8192 | 32768 }), false, '只有其他 intent');
    eq(hasMessageContentIntent({ flags: 0, flags_new: '524288' }), true, 'flags_new');
    eq(hasMessageContentIntent({}), false, '沒有 flags');
  });

  console.log('token 格式與遮罩');
  await t('合法形狀、去掉 "Bot " 前綴與換行', () => {
    eq(normalizeToken(FAKE).ok, true);
    eq(normalizeToken(`Bot ${FAKE}\r\n`).token, FAKE);
  });
  await t('空白、多行、Client Secret、亂碼都拒絕，且訊息不含內容', () => {
    eq(normalizeToken('').ok, false);
    eq(normalizeToken('   \n').ok, false);
    const multi = normalizeToken(`${FAKE}\n${FAKE}`);
    eq(multi.ok, false);
    eq(multi.reason.includes(FAKE), false, '訊息不可含 token');
    eq(/Client Secret/.test(normalizeToken('a'.repeat(32)).reason), true, 'Client Secret 提示');
    eq(normalizeToken('https://discord.com/developers/applications').ok, false);
  });
  await t('mask 只顯示末 4 碼；redact 會遮掉已登記的 token', () => {
    eq(mask(FAKE), '****abcd');
    registerSecret(FAKE);
    const out = redact(`錯誤：Authorization: Bot ${FAKE} 失敗`);
    eq(out.includes(FAKE), false, 'redact');
    eq(out.includes('****abcd'), true, 'redact 後綴');
  });

  console.log('config.json 合併');
  await t('檔案不存在 → 建立（含上層資料夾）', () => {
    const f = path.join(tmp, 'new', 'config.json');
    mergeTokenIntoConfig(f, FAKE);
    eq(JSON.parse(fs.readFileSync(f, 'utf-8')).discord.token, FAKE);
  });
  await t('既有欄位（含 discord 底下其他欄位、中文）完整保留', () => {
    const f = path.join(tmp, 'config.json');
    const before = {
      discord: { guild_id: GUILD, token: 'OLD.old.old' },
      defaults: { history: 30, max_hops: 5 },
      channels: { '1234567890': { cwd: 'D:\\專案\\中文路徑', launcher: 'claude' } },
      unbound: 'ignore',
    };
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify(before), 'utf-8'); // 帶 BOM 也要能讀
    const r = mergeTokenIntoConfig(f, FAKE);
    const after = JSON.parse(fs.readFileSync(f, 'utf-8'));
    eq(after.discord.token, FAKE);
    eq(after.discord.guild_id, GUILD);
    eq(JSON.stringify(after.defaults), JSON.stringify(before.defaults), 'defaults');
    eq(JSON.stringify(after.channels), JSON.stringify(before.channels), 'channels');
    eq(after.unbound, 'ignore');
    eq(r.replaced, true, 'replaced');
  });
  await t('JSON 壞掉 → 停止且不改動原檔', () => {
    const f = path.join(tmp, 'broken.json');
    fs.writeFileSync(f, '{ "discord": ', 'utf-8');
    throws(() => mergeTokenIntoConfig(f, FAKE), /不是合法的 JSON/);
    eq(fs.readFileSync(f, 'utf-8'), '{ "discord": ');
  });
  await t('最外層或 discord 不是物件 → 停止', () => {
    const f1 = path.join(tmp, 'arr.json');
    fs.writeFileSync(f1, '[]', 'utf-8');
    throws(() => mergeTokenIntoConfig(f1, FAKE), /最外層/);
    const f2 = path.join(tmp, 'str.json');
    fs.writeFileSync(f2, '{"discord":"x"}', 'utf-8');
    throws(() => mergeTokenIntoConfig(f2, FAKE), /discord 欄位/);
  });

  console.log('名冊');
  const rf = path.join(tmp, 'roster.json');
  const base = { botId: '111111111111111111', botName: '小明Bot', ownerName: '小明', ownerDiscordId: '222222222222222222' };
  await t('新增（檔案不存在時建立）', () => {
    const r = upsertRoster(rf, buildRosterEntry({ ...base, role: '工程師' }));
    eq(r.action, 'added');
    const data = JSON.parse(fs.readFileSync(rf, 'utf-8'));
    eq(data.version, 1);
    eq(data.bots[0].role, 'engineer');
  });
  await t('同一個 botId 更新而不是重複新增', () => {
    const r = upsertRoster(rf, buildRosterEntry({ ...base, botName: '小明Bot2', role: 'engineer' }));
    eq(r.action, 'updated');
    eq(r.count, 1);
  });
  await t('第二個 Bot 新增；同一主人兩個 Bot 會警告', () => {
    const r = upsertRoster(rf, buildRosterEntry({ ...base, botId: '333333333333333333', role: '企劃' }));
    eq(r.count, 2);
    eq(r.warnings.length, 1, 'warnings');
    eq(JSON.parse(fs.readFileSync(rf, 'utf-8')).bots[1].role, 'planner');
  });
  await t('角色與 ID 格式錯誤會拒絕', () => {
    throws(() => buildRosterEntry({ ...base, role: '美術' }), /角色/);
    throws(() => buildRosterEntry({ ...base, ownerDiscordId: '小明', role: 'planner' }), /使用者 ID/);
  });

  console.log('交付檔名稱');
  await t('移除 Windows 不允許的字元、保留中文', () => {
    eq(safeFileName('王小明'), '王小明');
    eq(safeFileName('a/b:c*?'), 'a_b_c__');
    eq(safeFileName('...'), 'member');
  });

  console.log('驗證流程（模擬 Discord 回應，不連網路）');
  const realFetch = globalThis.fetch;
  const mockFetch = (routes) => async (url, init) => {
    if (init?.headers?.Authorization !== `Bot ${FAKE}`) return new Response('{"message":"401: Unauthorized"}', { status: 401 });
    const route = url.replace(API, '').split('?')[0];
    const body = routes[route];
    return body === undefined ? new Response('{}', { status: 404 }) : Response.json(body);
  };
  const okRoutes = {
    '/users/@me': { id: APP, username: 'example_bot', global_name: null, bot: true },
    '/applications/@me': { id: APP, flags: 524288, bot_public: false, team: { id: '555555555555555555', name: 'Studio' } },
    '/users/@me/guilds': [{ id: GUILD, name: '測試伺服器' }],
  };
  try {
    await t('全部設定正確 → 全部 ✅', async () => {
      globalThis.fetch = mockFetch(okRoutes);
      const r = await runChecks(FAKE, { guildId: GUILD, teamId: '555555555555555555' });
      eq(r.checks.filter((c) => !c.ok).length, 0, '失敗項數');
      eq(r.applicationId, APP);
    });
    await t('Intent 沒開、Public Bot 開著、不在伺服器 → 3 項 ❌ 並附修正方法與邀請網址', async () => {
      globalThis.fetch = mockFetch({
        ...okRoutes,
        '/applications/@me': { id: APP, flags: 0, bot_public: true, team: null, owner: { username: 'example_user' } },
        '/users/@me/guilds': [],
      });
      const r = await runChecks(FAKE, { guildId: GUILD });
      const bad = r.checks.filter((c) => !c.ok);
      eq(bad.length, 3, '失敗項數');
      eq(bad.every((c) => c.fix), true, '每項都有修正方法');
      eq(bad.some((c) => /Install Link/.test(c.fix)), true, 'Public Bot 修正要提 Install Link');
      eq(bad.some((c) => c.fix.includes('oauth2/authorize')), true, '附邀請網址');
      eq(r.checks.some((c) => c.warn && /個人帳號/.test(c.title)), true, '個人帳號提醒');
    });
    await t('token 無效 (401) → 友善訊息且不含 token', async () => {
      globalThis.fetch = async () => new Response('{"message":"401: Unauthorized"}', { status: 401 });
      const r = await runChecks(FAKE, {});
      eq(r.checks[0].fatal, true);
      eq(/token 無效/.test(r.checks[0].detail), true);
      eq(JSON.stringify(r).includes(FAKE), false, '結果不可含 token');
    });
    await t('網路錯誤 → 友善訊息', async () => {
      globalThis.fetch = async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      };
      const r = await runChecks(FAKE, {});
      eq(/連不到 Discord API（ENOTFOUND）/.test(r.checks[0].detail), true);
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('安全');
  await t('拒絕從命令列傳入 token', () => {
    throws(() => loadToken({ token: FAKE }), /不能從命令列/);
  });

  console.log('HOME（CHANNELCOLLAB_HOME）');
  await t('--home 優先，其次 CHANNELCOLLAB_HOME，都沒有時用 ~/.channelcollab', () => {
    eq(resolveHome({ home: tmp }, { CHANNELCOLLAB_HOME: 'X:\\other' }), path.resolve(tmp));
    eq(resolveHome({}, { CHANNELCOLLAB_HOME: tmp }), path.resolve(tmp));
    eq(resolveHome({}, {}), path.join(os.homedir(), '.channelcollab'));
  });
  await t('config.json、roster.json、handoff 都跟著 HOME', () => {
    const p = defaultPaths({}, { CHANNELCOLLAB_HOME: tmp });
    eq(p.config, path.join(path.resolve(tmp), 'config.json'));
    eq(p.roster, path.join(path.resolve(tmp), 'roster.json'));
    eq(p.handoffDir, path.join(path.resolve(tmp), 'handoff'));
  });
  await t('子程序設了 CHANNELCOLLAB_HOME 時，說明文字顯示該 HOME', () => {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf-8',
      env: { ...process.env, CHANNELCOLLAB_HOME: tmp },
    });
    eq(out.includes(`目前的 HOME：${path.resolve(tmp)}`), true, '說明文字');
  });

  console.log('交付檔：名冊與主人 ID');
  const OTHER = ['MTExMTExMTExMTExMTExMTExMTE', 'AbCdEf', 'other_token_for_self_test_9876543210wxyz'].join('.');
  const home = path.join(tmp, 'member-home');
  const hf = path.join(tmp, 'handoff.json');
  const cfgFile = path.join(home, 'config.json');
  const rosterFile = path.join(home, 'roster.json');
  await t('roster --handoff：名冊快照與主人 ID 附進交付檔，token 保留', () => {
    writeJsonFile(hf, { discord: { token: FAKE }, bot: { id: APP, name: 'x' }, owner: { name: '小明' } });
    const roster = JSON.parse(fs.readFileSync(rf, 'utf-8'));
    attachToHandoff(hf, roster, roster.bots[0]);
    const h = JSON.parse(fs.readFileSync(hf, 'utf-8'));
    eq(h.discord.token, FAKE, 'token');
    eq(h.owner.discordId, '222222222222222222');
    eq(h.roster.bots.length, 2);
    throws(() => attachToHandoff(rf, roster, roster.bots[0]), /不是交付檔/);
  });
  await t('匯入：token、owner_id、名冊寫進成員的 HOME', () => {
    const h = JSON.parse(fs.readFileSync(hf, 'utf-8'));
    const r = applyHandoff({ handoff: h, token: FAKE, configFile: cfgFile, rosterFile });
    eq(r.ownerId, '222222222222222222');
    eq(r.rosterCount, 2);
    const c = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    eq(c.discord.token, FAKE);
    eq(c.discord.owner_id, '222222222222222222');
    eq(JSON.parse(fs.readFileSync(rosterFile, 'utf-8')).bots.length, 2);
  });
  await t('同一個 token 重新匯入可以；另一個 Bot 的 token 不加 --replace 會拒絕且不改檔', () => {
    applyHandoff({ handoff: {}, token: FAKE, configFile: cfgFile, rosterFile });
    const before = fs.readFileSync(cfgFile, 'utf-8');
    throws(() => applyHandoff({ handoff: {}, token: OTHER, configFile: cfgFile, rosterFile }), /另一個 Bot/);
    eq(fs.readFileSync(cfgFile, 'utf-8'), before, '原檔不變');
    const r = applyHandoff({ handoff: {}, token: OTHER, configFile: cfgFile, rosterFile, replace: true });
    eq(r.replaced, true);
  });
  await t('舊格式交付檔（沒有主人 ID、沒有名冊）：只寫 token，既有 owner_id 不被清掉', () => {
    const r = applyHandoff({ handoff: { owner: { name: '小明' } }, token: OTHER, configFile: cfgFile, rosterFile });
    eq(r.ownerId, null);
    eq(r.rosterCount, null);
    eq(JSON.parse(fs.readFileSync(cfgFile, 'utf-8')).discord.owner_id, '222222222222222222');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
}

// ---------------------------------------------------------------------------
const HELP = `用法：node create-bot.mjs <子命令> [選項]

  save-token --for self [--config <path>]            從剪貼簿讀 token，驗證後寫入 config.json
  save-token --for member --member <名稱> [--owner-id <成員的 Discord ID>]
             [--handoff-dir <dir>] [--keep-clipboard] [--json]
                                                      從剪貼簿讀 token，存成交付檔（幫成員建）
  import-handoff <交付檔> [--config <path>] [--roster <path>] [--replace] [--delete-handoff] [--json]
                                                      把交付檔的 token、主人 ID、名冊匯入自己的 HOME
  verify [--config <path> | --handoff <檔> | --from-clipboard]
         [--guild-id <id>] [--team-id <id>] [--json] 檢查 Bot 設定
  invite (--app-id <id> | token 來源) [--guild-id <id>] [--lock-guild]
                                                      產生邀請網址
  roster --owner-name <名稱> --owner-id <Discord ID> --role engineer|planner
         [--bot-id <id> --bot-name <名稱> --app-id <id> | token 來源] [--roster <path>] [--print]
                                                      寫入／合併名冊；token 來源是 --handoff 時，
                                                      名冊與主人 ID 也會附進該交付檔
  --self-test                                         自我測試（不需要 token）

所有子命令都接受 --home <路徑>（預設：CHANNELCOLLAB_HOME，沒設時 %USERPROFILE%\\.channelcollab）。
目前的 HOME：${resolveHome()}
token 來源預設為 <HOME>\\config.json；token 不接受命令列參數。`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts['self-test']) return selfTest();
  const cmd = opts._[0];
  const table = {
    'save-token': cmdSaveToken,
    'import-handoff': cmdImportHandoff,
    verify: cmdVerify,
    invite: cmdInvite,
    roster: cmdRoster,
  };
  if (!table[cmd]) {
    console.log(HELP);
    process.exitCode = cmd ? 2 : 0;
    return;
  }
  await table[cmd](opts);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`❌ ${e instanceof CliError ? e.message : redact(e?.stack || e)}`);
    process.exitCode = 2;
  });
}
