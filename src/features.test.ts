/**
 * Self-test for 0.1.5 (no Discord, no token, no Claude): commands, direct
 * messages, context and plan usage reminders, failure messages, mentions of
 * the bot's role, PIN, allowlist, no-go zones and approve-later.
 * Run: node --import tsx src/features.test.ts (part of `npm run test:plugin`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything that writes state goes to a throwaway HOME (set before the modules load).
const HOME = mkdtempSync(path.join(os.tmpdir(), 'cc-features-'));
process.env.CHANNELCOLLAB_HOME = HOME;

const commands = await import('./discord/commands.js');
const usage = await import('./runner/usage.js');
const failure = await import('./runner/failure.js');
const pin = await import('./security/pin.js');
const zones = await import('./security/zones.js');
const access = await import('./security/access.js');
const approvals = await import('./runner/approvals.js');
const policy = await import('./runner/policy.js');
const roster = await import('./roster.js');
// The control script is plain JS without types; a non-literal path keeps tsc from resolving it.
const CTL = '../plugin/scripts/channelcollab.mjs';
const ctl = (await import(CTL)) as unknown as { hashPin: (pin: string) => import('./security/pin.js').PinFile };

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}：${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown, msg = ''): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
}
function has(text: string, part: string, yes = true): void {
  if (text.includes(part) !== yes) throw new Error(`${yes ? '缺少' : '不該有'}「${part}」\n${text}`);
}

// 假資料：ID 都是明顯編出來的數字
const SELF = '100000000000000001';
const OTHER_BOT = '100000000000000002';
const OWNER = '200000000000000001';
const MEMBER = '200000000000000003';
const STRANGER = '300000000000000009';

console.log('指令解析');
await t('只有指令本身才算；大小寫不分；只有 !model 可以帶一個參數；前面的 @ 會略過', () => {
  eq(commands.parseCommand('!help'), { name: 'help' });
  eq(commands.parseCommand('  !STATUS  '), { name: 'status' });
  eq(commands.parseCommand('!model sonnet'), { name: 'model', arg: 'sonnet' });
  eq(commands.parseCommand(`<@${SELF}> !stop`), { name: 'stop' });
  eq(commands.parseCommand(`<@&${SELF}> !plan`), { name: 'plan' });
  eq(commands.parseCommand('!help me please'), undefined);
  eq(commands.parseCommand('!stop now'), undefined);
  eq(commands.parseCommand('please !stop'), undefined);
  eq(commands.parseCommand('!unknown'), undefined);
  eq(commands.parseCommand('!model sonnet extra'), undefined);
});
await t('!model 的參數：haiku／sonnet／opus 或完整模型名稱', () => {
  eq(commands.normalizeModel('Sonnet'), 'sonnet');
  eq(commands.normalizeModel('claude-opus-5-5'), 'claude-opus-5-5');
  eq(commands.normalizeModel('gpt'), undefined);
});
await t('help：私訊列出全部（斜線寫法，並說明 ! 備用寫法）；討論串不列 /clear、/resume 並說明誰能用', () => {
  const dm = commands.helpText('dm');
  const th = commands.helpText('thread');
  for (const n of ['help', 'clear', 'resume', 'stop', 'status', 'model', 'plan', 'compact', 'retry', 'skill']) has(dm, `\`/${n}\``);
  has(dm, '`!model sonnet`');
  has(th, '`/clear`　', false);
  has(th, '`/resume`　', false);
  has(th, '主人或提出需求的人');
});

console.log('私訊權限');
await t('不是主人的私訊被擋；沒設主人也擋；主人但沒開 dm 是 disabled', () => {
  eq(commands.dmAccess({ authorId: STRANGER, ownerId: OWNER, dmEnabled: true }), 'not-owner');
  eq(commands.dmAccess({ authorId: OWNER, ownerId: undefined, dmEnabled: true }), 'not-owner');
  eq(commands.dmAccess({ authorId: OWNER, ownerId: OWNER, dmEnabled: false }), 'disabled');
  eq(commands.dmAccess({ authorId: OWNER, ownerId: OWNER, dmEnabled: true }), 'run');
});
await t('婉拒訊息同一人 10 分鐘內只回一次', () => {
  const seen = new Map<string, number>();
  eq(commands.throttle(seen, 'a', 0), true);
  eq(commands.throttle(seen, 'a', 60_000), false);
  eq(commands.throttle(seen, 'b', 60_000), true);
  eq(commands.throttle(seen, 'a', 11 * 60_000), true);
});

console.log('!resume 清單');
await t('最新的在前、同一個 session 只列一次、最多 10 筆；選單文字不超過 100 字', () => {
  const mk = (n: number, kind: 'dm' | 'thread', sid = `s${n}`) => ({ kind, id: `i${n}`, sessionId: sid, cwd: 'D:\\w', at: new Date(2026, 0, 1, 0, n).toISOString(), source: kind === 'dm' ? '私訊' : `串${n}`, summary: `摘要${n}` });
  const list = commands.resumeList([...Array.from({ length: 12 }, (_, n) => mk(n, n % 2 ? 'dm' : 'thread')), mk(13, 'dm', 's11')]);
  eq(list.length, 10);
  eq(list[0].sessionId, 's11');
  eq(list[0].id, 'i13');
  eq(list.filter((c) => c.sessionId === 's11').length, 1);
  const opt = commands.resumeOption({ ...mk(1, 'thread'), source: 'x'.repeat(200), summary: 'y'.repeat(300) });
  eq(opt.label.length <= 100 && opt.description.length <= 100, true);
  has(commands.resumeOption(mk(2, 'dm')).label, '私訊');
  has(commands.resumeOption(mk(3, 'thread')).label, '討論串「串3」');
});

console.log('上下文提醒');
await t('70%、95% 各提醒一次；85% 只用附註；跳過門檻時照樣提醒；壓縮後重新計算', () => {
  let n: number[] = [];
  let r = usage.contextAlert(50, n);
  eq(r.notify, undefined);
  r = usage.contextAlert(72, (n = r.notified));
  eq(r.notify, 70);
  r = usage.contextAlert(74, (n = r.notified));
  eq(r.notify, undefined, '70 不重複');
  r = usage.contextAlert(88, (n = r.notified));
  eq(r.notify, undefined, '85 只用附註');
  r = usage.contextAlert(96, (n = r.notified));
  eq(r.notify, 95);
  r = usage.contextAlert(97, (n = r.notified));
  eq(r.notify, undefined, '95 不重複');
  r = usage.contextAlert(20, (n = r.notified));
  eq(r.notified, [], '壓縮後重新計算');
  r = usage.contextAlert(90, r.notified);
  eq(r.notify, 70, '從 20 跳到 90：還是提醒一次');
  eq(usage.contextAlert(99, []).notify, 95);
});
await t('提醒文字：私訊提到 !clear，討論串不提', () => {
  has(usage.contextNotice(86, 'dm'), '!clear');
  has(usage.contextNotice(86, 'thread'), '!clear', false);
  has(usage.contextNotice(96, 'thread'), '快滿了');
});
await t('85% 起每則 reply 附一行；低於 85% 或不知道時不附', () => {
  eq(usage.contextFooter(84), '');
  eq(usage.contextFooter(undefined), '');
  eq(usage.contextFooter(87), '🧠 上下文 87%，可打 !compact');
  has(usage.contextFooter(96), '快滿了');
});
await t('長訊息切段時附註只在最後一段，而且每段都不超過 2000 字', () => {
  const footer = usage.contextFooter(90);
  const text = Array.from({ length: 80 }, (_, i) => `第 ${i} 行 ${'字'.repeat(40)}`).join('\n');
  const parts = commands.splitReply(text, footer);
  eq(parts.length > 1, true);
  eq(parts.every((p) => p.length <= 2000), true, '長度');
  eq(parts.filter((p) => p.includes('🧠')).length, 1);
  eq(parts.at(-1)!.endsWith(footer), true);
  const tight = commands.splitReply('a'.repeat(1990), footer);
  eq(tight.every((p) => p.length <= 2000) && tight.at(-1)!.endsWith(footer), true, '剛好塞不下時另起一段');
  eq(commands.splitReply('短訊息', ''), ['短訊息']);
  eq(commands.splitReply('', footer), [footer], '只有附檔時');
});
await t('拿不到 /context 數字時：最後一次 API 呼叫的 token ÷ context window', () => {
  eq(usage.contextFromUsage({ input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 20_000, output_tokens: 10 }, 200_000), { pct: 85, tokens: 170_020, max: 200_000 });
  eq(usage.contextFromUsage(undefined, 200_000), undefined);
});

console.log('額度提醒');
await t('utilization 是 0～1 的比例：80%、95% 各提醒一次；新的重置時間重新計算；被拒絕時說何時重置', () => {
  const seen = new Map<string, { level: number; resetsAt?: number }>();
  const now = new Date(2026, 10, 4, 10, 0).getTime();
  const reset = Math.floor(new Date(2026, 10, 4, 14, 30).getTime() / 1000);
  const ev = (u5: number, status = 'allowed', resetsAt = reset) => ({ status, unifiedWindows: { five_hour: { utilization: u5, resetsAt, status }, seven_day: { utilization: 0.4, resetsAt: resetsAt + 86400 * 3 } } }) as never;
  eq(usage.rateAlerts(ev(0.06), seen, now), []);
  eq(usage.rateAlerts(ev(0.85, 'allowed_warning'), seen, now), ['⚠️ 5 小時額度已用 85%，約 14:30 重置。']);
  eq(usage.rateAlerts(ev(0.86, 'allowed_warning'), seen, now), [], '不重複');
  eq(usage.rateAlerts(ev(0.96, 'allowed_warning'), seen, now), ['⚠️ 5 小時額度已用 96%，約 14:30 重置。']);
  eq(usage.rateAlerts(ev(1, 'rejected'), seen, now), ['⛔ 5 小時額度已用完，約 14:30 重置，到時再試。']);
  eq(usage.rateAlerts(ev(0.9, 'allowed_warning', reset + 18000), seen, now), ['⚠️ 5 小時額度已用 90%，約 19:30 重置。'], '新的視窗');
});
await t('沒有 unifiedWindows 時用最上層的欄位；只有警告狀態沒有數字時顯示「接近上限」', () => {
  const seen = new Map<string, { level: number; resetsAt?: number }>();
  eq(usage.rateAlerts({ status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: 1 } as never, seen), [`⚠️ 每週額度接近上限，約 ${usage.formatReset(1)} 重置。`]);
});
await t('!status 的額度：沒收到過就寫未知；有就列出各視窗', () => {
  has(usage.rateSummary(undefined), '未知');
  const s = usage.rateSummary({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1793789400 }, seven_day: { utilization: 0.4, resetsAt: 1793822400 } } } as never);
  has(s, '5 小時 6%');
  has(s, '每週 40%');
});

console.log('@ Bot 的身分組');
await t('提到自己的 managed bot role 視同 @ 了 Bot；一般身分組、別人的 bot role 不算', () => {
  eq(commands.mentionsSelf({ userIds: [], roles: [{ id: '900', botId: SELF }] }, SELF), true);
  eq(commands.mentionsSelf({ userIds: [], roles: [{ id: '901' }] }, SELF, '901'), true, 'guild.members.me.roles.botRole');
  eq(commands.mentionsSelf({ userIds: [], roles: [{ id: '902', botId: null }] }, SELF, '901'), false, '一般身分組');
  eq(commands.mentionsSelf({ userIds: [], roles: [{ id: '903', botId: OTHER_BOT }] }, SELF, '901'), false, '別人的 bot role');
  eq(commands.mentionsSelf({ userIds: [SELF], roles: [] }, SELF), true);
  eq(commands.mentionsOtherBotRole([{ id: '903', botId: OTHER_BOT }], SELF), true);
  eq(commands.mentionsOtherBotRole([{ id: '900', botId: SELF }, { id: '902' }], SELF), false);
});

console.log('錯誤訊息');
await t('is_error 但 subtype 是 success（沒登入）：顯示錯誤內容與白話建議，不再只寫 success', () => {
  const text = failure.explainFailure({ subtype: 'success', error: 'Not logged in · Please run /login' });
  has(text, '執行失敗：success', false);
  has(text, '（success）', false);
  has(text, '> Not logged in · Please run /login');
  has(text, 'Claude 沒登入');
});
await t('各種錯誤的建議；只取前 3 行；token 樣式的字串會遮掉', () => {
  const tok = ['MTAwMDAwMDAwMDAwMDAwMDAx', 'AbCdEf', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');
  const text = failure.explainFailure({ subtype: 'error_during_execution', error: `API Error: 529 overloaded\nline2 ${tok}\nline3 sk-ant-api03-abcdefghijklmnop\nline4` });
  has(text, tok, false);
  has(text, 'sk-ant-api03', false);
  has(text, 'line4', false);
  has(text, '服務暫時忙碌');
  has(failure.explainFailure({ subtype: 'success', apiError: 'rate_limit', error: '' }), '額度');
  has(failure.explainFailure({ subtype: 'success', error: 'Prompt is too long' }), '!compact');
  has(failure.explainFailure({ subtype: 'timeout' }), '10 分鐘');
  eq(failure.maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer ***');
  eq(failure.maskSecrets('D:\\work\\game\\assets\\scripts\\GameMain.ts 第 12 行'), 'D:\\work\\game\\assets\\scripts\\GameMain.ts 第 12 行');
});

console.log('PIN');
const pinFile = ctl.hashPin('135790');
await t('總控寫的雜湊，Bot 端驗得過；錯的不過（固定時間比對）', () => {
  eq(pin.verifyPin('135790', pinFile), true);
  eq(pin.verifyPin(' 135790 ', pinFile), true);
  eq(pin.verifyPin('135791', pinFile), false);
});
await t('非主人按「允許」：直接拒絕，不開 PIN 視窗、不累計錯誤次數', () => {
  let clock = 0;
  const gate = new pin.PinGate(() => pinFile, () => 30 * 60_000, () => clock);
  eq(pin.approvalStep(false, gate), 'refuse');
  eq(gate.state().failures, 0);
  eq(pin.approvalStep(true, gate), 'pin');
});
await t('PIN 正確後 30 分鐘內免輸入；時間到又要；沒設 PIN 時直接核准', () => {
  let clock = 1_000;
  const gate = new pin.PinGate(() => pinFile, () => 30 * 60_000, () => clock);
  eq(gate.attempt('135790'), { result: 'ok' });
  eq(pin.approvalStep(true, gate), 'approve');
  clock += 30 * 60_000;
  eq(pin.approvalStep(true, gate), 'pin');
  const none = new pin.PinGate(() => undefined, () => 1, () => 0);
  eq(none.configured, false);
  eq(pin.approvalStep(true, none), 'approve');
});
await t('連錯 3 次鎖定（只宣告一次）；鎖定中連對的也不收；unlock 後要重新輸入', () => {
  const gate = new pin.PinGate(() => pinFile, () => 60_000, () => 0);
  eq(gate.attempt('0000'), { result: 'wrong', left: 2 });
  eq(gate.attempt('0000'), { result: 'wrong', left: 1 });
  eq(gate.attempt('0000'), { result: 'locked', justLocked: true });
  eq(gate.attempt('135790'), { result: 'locked', justLocked: false });
  eq(pin.approvalStep(true, gate), 'locked');
  gate.reset();
  eq(gate.locked, false);
  eq(pin.approvalStep(true, gate), 'pin');
  eq(gate.attempt('135790'), { result: 'ok' });
});
await t('答對會把錯誤次數歸零', () => {
  const gate = new pin.PinGate(() => pinFile, () => 60_000, () => 0);
  gate.attempt('0000');
  gate.attempt('0000');
  gate.attempt('135790');
  eq(gate.attempt('0000'), { result: 'wrong', left: 2 });
});

console.log('白名單');
await t('主人、名冊成員、名冊 Bot 的主人、名冊上的 Bot 可以；其他人不行', () => {
  const r = { bots: [{ botId: OTHER_BOT, botName: 'B', ownerDiscordId: '200000000000000002' }], members: [{ name: 'M', discordId: MEMBER }] };
  eq(access.allowedTrigger(OWNER, OWNER, r), true);
  eq(access.allowedTrigger(MEMBER, OWNER, r), true);
  eq(access.allowedTrigger('200000000000000002', OWNER, r), true);
  eq(access.allowedTrigger(OTHER_BOT, OWNER, r), true);
  eq(access.allowedTrigger(STRANGER, OWNER, r), false);
  eq(access.allowedTrigger(STRANGER, undefined, { bots: [], members: [] }), false);
});

console.log('禁區');
const userHome = 'C:\\Users\\someone';
const ccHome = `${userHome}\\.channelcollab`;
const z = { homes: [ccHome], allow: [`${ccHome}\\inbox\\dm`] };
const cwd = 'D:\\work\\repo';
const use = (name: string, input: Record<string, unknown>) => zones.forbiddenUse(name, input, cwd, z, 'mcp__channelcollab__');
await t('檔案工具：HOME、其他 .channelcollab*、.ssh、.env、.env.*、.credentials.json 都擋；大小寫與斜線正規化', () => {
  eq(!!use('Read', { file_path: `${ccHome}\\config.json` }), true);
  eq(!!use('Read', { file_path: 'c:/users/SOMEONE/.ChannelCollab/config.json' }), true, '大小寫與斜線');
  eq(!!use('Read', { file_path: `${userHome}\\.channelcollab-bot2\\pin.json` }), true);
  eq(!!use('Edit', { file_path: `${userHome}\\.ssh\\id_ed25519` }), true);
  eq(!!use('Write', { file_path: '.env' }), true);
  eq(!!use('Read', { file_path: 'config\\.env.production' }), true);
  eq(!!use('Read', { file_path: `${userHome}\\.claude\\.credentials.json` }), true);
  eq(!!use('Grep', { pattern: 'x', path: `${userHome}\\.ssh` }), true);
  eq(!!use('Glob', { pattern: '**/.env*' }), true);
  eq(!!use('NotebookEdit', { notebook_path: `${ccHome}\\x.ipynb` }), true);
});
await t('自己的附件資料夾可以讀；一般檔案、.envrc、environment.ts 不擋', () => {
  eq(use('Read', { file_path: `${ccHome}\\inbox\\dm\\123-a.png` }), undefined);
  eq(use('Read', { file_path: 'src\\environment.ts' }), undefined);
  eq(use('Read', { file_path: '.envrc' }), undefined);
  eq(use('Write', { file_path: 'D:\\work\\repo\\README.md' }), undefined);
  eq(!!use('Read', { file_path: `${ccHome}\\inbox\\dm\\..\\..\\config.json` }), true, '用 .. 跳出附件資料夾');
});
await t('Bash／PowerShell 盡力比對；執行 channelcollab 自己的腳本也擋', () => {
  eq(!!use('Bash', { command: 'cat ~/.ssh/id_rsa' }), true);
  eq(!!use('PowerShell', { command: 'Get-Content $env:USERPROFILE\\.channelcollab\\config.json' }), true);
  eq(!!use('Bash', { command: 'source .env && npm test' }), true);
  eq(!!use('Bash', { command: 'type C:\\Users\\someone\\.claude\\.credentials.json' }), true);
  eq(!!use('Bash', { command: 'node "C:/x/plugins/cache/channelcollab/channelcollab/0.1.5/scripts/channelcollab.mjs" clear-pin' }), true);
  eq(!!use('Bash', { command: `dir ${ccHome}\\inbox\\dm\\..\\` }), true, '從附件資料夾跳出去');
  eq(use('Bash', { command: 'git status && npm run build' }), undefined);
  eq(use('Bash', { command: 'node -e "console.log(process.env.HOME)"' }), undefined);
  eq(use('Bash', { command: `dir ${ccHome}\\inbox\\dm` }), undefined, '自己的附件資料夾');
});
await t('reply 附檔：禁區的檔案不能附；其他 MCP 工具掃參數；TodoWrite 之類不擋', () => {
  eq(!!use('mcp__channelcollab__reply', { text: '.env 的說明', files: ['.env'] }), true);
  eq(use('mcp__channelcollab__reply', { text: '設定放在 .env 檔' }), undefined);
  eq(!!use('mcp__fs__read', { target: { p: '~/.ssh/config' } }), true);
  eq(use('TodoWrite', { todos: [{ content: '讀取 .env 設定' }] }), undefined);
  has(zones.zoneDenyMessage('x'), '不要再試');
});

console.log('稍後核准');
const { askPermission } = await import('./discord/prompts.js');
const { sendApprovalBatch } = await import('./discord/approvals-ui.js');
await t('等候時間：owner_wait_minutes 與 permission_timeout_minutes 取短的', () => {
  eq(approvals.ownerWaitMs(2, 10), 120_000);
  eq(approvals.ownerWaitMs(5, 3), 180_000);
});
await t('主人在時限內沒按：延後（deny + deferred），告訴 Claude 先做能做的、整理成待主人核准', async () => {
  const sent: string[] = [];
  const fakeMsg = { id: 'm1', edit: async (o: { content: string }) => (sent.push(`edit:${o.content}`), fakeMsg) };
  const room = { send: async (o: { content: string }) => (sent.push(o.content), fakeMsg) } as never;
  const ctrl = new AbortController();
  const a = await askPermission(room, { toolName: 'Bash', input: { command: 'npm publish' }, toolUseId: 'u1', signal: ctrl.signal }, { ownerId: OWNER }, 50);
  eq(a.behavior, 'deny');
  eq('deferred' in a && a.deferred, true);
  has('message' in a ? a.message : '', '已排入待核准清單');
  has('message' in a ? a.message : '', '不要重試同一個動作');
  has(sent.at(-1)!, '已排入待核准清單');
});
await t('延後的動作送私訊卡片給主人；討論串只有一則簡短通知（不放按鈕）', async () => {
  const dms: unknown[] = [];
  const posts: { content: string; components?: unknown[] }[] = [];
  const room = {
    client: { users: { fetch: async () => ({ send: async (o: unknown) => (dms.push(o), { id: 'card1', channelId: 'dmch' }) }) } },
    send: async (o: { content: string; components?: unknown[] }) => (posts.push(o), { id: `n${posts.length}`, channelId: 'th1' }),
  };
  const conv = { key: '400000000000000001', kind: 'thread', room, base: {}, selfId: SELF } as never;
  const b = await sendApprovalBatch(conv, [approvals.deferItem('Bash', { command: 'npm publish', description: 'publish' })], { ownerId: OWNER, requesterId: MEMBER });
  eq(dms.length, 1, '私訊');
  eq(b.card?.where, 'dm');
  eq(posts.length, 1, '討論串一則');
  has(posts[0].content, `等 <@${OWNER}> 核准（已私訊主人）`);
  eq(posts[0].components, undefined, '通知沒有按鈕');
});
await t('私訊送不出去時，卡片退回討論串（只有主人能按）', async () => {
  const posts: { content: string; components?: unknown[] }[] = [];
  const room = {
    client: { users: { fetch: async () => ({ send: async () => Promise.reject(new Error('Cannot send messages to this user')) }) } },
    send: async (o: { content: string; components?: unknown[] }) => (posts.push(o), { id: `n${posts.length}`, channelId: 'th1' }),
  };
  const conv = { key: '400000000000000002', kind: 'thread', room, base: {}, selfId: SELF } as never;
  const b = await sendApprovalBatch(conv, [approvals.deferItem('Bash', { command: 'git push' })], { ownerId: OWNER });
  eq(b.card?.where, 'thread');
  eq(posts.length, 2);
  eq(Array.isArray(posts[0].components) && posts[0].components.length > 0, true, '卡片有按鈕');
  has(posts[1].content, '請主人按下方的卡片');
});
await t('核准後只放行清單上的動作：retryKey 相同才放行（說明文字不同沒關係），參數不同不放行', () => {
  const item = approvals.deferItem('Bash', { command: 'npm publish', description: '發佈' });
  const keys = approvals.deferredKeys([item]);
  eq(keys.includes(policy.retryKey('Bash', { command: 'npm publish', description: '再發佈一次' })), true);
  eq(keys.includes(policy.retryKey('Bash', { command: 'npm publish --force' })), false);
  eq(keys.includes(policy.retryKey('PowerShell', { command: 'npm publish' })), false);
});
await t('全部允許／逐項選擇／全部拒絕；處理過的不能再按', () => {
  const items = [approvals.deferItem('Bash', { command: 'a' }), approvals.deferItem('Write', { file_path: 'b' }), approvals.deferItem('Bash', { command: 'a' })];
  const b1 = approvals.newBatch({ id: 'x1', convKey: 't', kind: 'thread', items, now: 0 });
  eq(b1.items.length, 2, '同一個動作只列一次');
  const d1 = approvals.decide(b1, 'all', 1);
  eq(d1.result === 'decided' && d1.status, 'approved');
  eq(approvals.decide(b1, 'none', 2).result, 'already');
  const b2 = approvals.newBatch({ id: 'x2', convKey: 't', kind: 'thread', items, now: 0 });
  const d2 = approvals.decide(b2, [1], 1);
  eq(d2.result === 'decided' && [d2.status, d2.allow.length, d2.deny.length], ['partial', 1, 1]);
  const p = approvals.approvedPrompt(d2.result === 'decided' ? d2.allow : [], d2.result === 'decided' ? d2.deny : []);
  has(p, '主人已核准');
  has(p, '請用相同參數執行');
  has(p, '主人拒絕了這些動作，不要做');
});
await t('全部拒絕：通知改成已拒絕，下一則訊息告訴 Claude 不要做', () => {
  const b = approvals.newBatch({ id: 'x3', convKey: 't', kind: 'thread', items: [approvals.deferItem('Bash', { command: 'rm -rf build' })], now: 0 });
  const d = approvals.decide(b, 'none', 1);
  eq(d.result === 'decided' && d.status, 'denied');
  has(approvals.noticeText(b, OWNER, 'dm'), '🚫 主人拒絕了');
  has(approvals.deniedNote(d.result === 'decided' ? d.deny : []), '不要做這些動作');
});
await t('過期（24 小時）：按鈕失效，通知改成已過期', () => {
  const b = approvals.newBatch({ id: 'x4', convKey: 't', kind: 'thread', items: [approvals.deferItem('Bash', { command: 'x' })], now: 0 });
  eq(approvals.decide(b, 'all', approvals.APPROVAL_TTL_MS).result, 'expired');
  eq(b.status, 'expired');
  has(approvals.noticeText(b, OWNER, 'dm'), '已過期');
  has(approvals.outcomeText({ result: 'expired' }, ''), '按鈕失效');
});

console.log('私訊提示詞');
await t('私訊：名冊仍列出團隊，但沒有 <@ID> 與交棒守則，並說明不要 @ 人', () => {
  const r = { bots: [{ botId: SELF, botName: '小明Bot', ownerName: '小明', ownerDiscordId: OWNER }, { botId: OTHER_BOT, botName: '小華Bot', ownerName: '小華' }], members: [{ name: '企劃小美', discordId: MEMBER, role: 'planner' }] };
  const p = roster.rosterPrompt(SELF, OWNER, r, { dm: true });
  has(p, '小華Bot');
  has(p, '企劃小美');
  has(p, '<@', false);
  has(p, '【和其他 Bot 協作】', false);
  has(p, '不要 @ 任何人');
});

rmSync(HOME, { recursive: true, force: true });
console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
process.exitCode = fail ? 1 : 0;
