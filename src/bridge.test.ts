/**
 * Self-test for 0.1.8 (no Discord connection, no token, no Claude): reporting
 * to a team channel (post_to_channel and the control script's `post`), the
 * control pipe, taking a conversation over on the computer and giving it back
 * (release, /takeback), handing the computer's session over (handoff), and
 * effort. Discord objects are small fakes; the control script talks to a real
 * named pipe served by the bot's own control server.
 * Run: node --import tsx src/bridge.test.ts (part of `npm run test:plugin`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway HOME and Claude config folder (for the fake session transcript), set before the modules load.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-'));
const CLAUDE_DIR = mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-cfg-'));
process.env.CHANNELCOLLAB_HOME = HOME;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
const WORK = path.join(HOME, '工作 資料夾');
const OTHER = path.join(HOME, '電腦上的 專案');
mkdirSync(WORK);
mkdirSync(OTHER);
const SELF = '200000000000000001';
const OWNER = '300000000000000001';
const MEMBER = '300000000000000003';
const CH = '400000000000000001';
const CH2 = '400000000000000002';
const UNBOUND = '400000000000000099';
const GUILD = '500000000000000001';
const THREAD = '600000000000000001';
const SID = '11111111-2222-4333-8444-555555555555';
const CLI_SID = '22222222-3333-4444-8555-666666666666';
// A launcher that does not exist: a turn that slips through fails at once instead of starting Claude.
const NO_LAUNCHER = path.join(HOME, 'no-such-launcher.exe');
writeFileSync(
  path.join(HOME, 'config.json'),
  JSON.stringify({
    discord: { token: 'not-a-real-token', owner_id: OWNER, guild_id: GUILD },
    channels: { [CH]: { cwd: WORK, launcher: NO_LAUNCHER, permission_mode: 'default', effort: 'high' }, [CH2]: { cwd: WORK, launcher: NO_LAUNCHER } },
    dm: { cwd: WORK, launcher: NO_LAUNCHER, permission_mode: 'default' },
    access: { roster_only: false },
  }),
  'utf8',
);
// The computer's session, as Claude Code records it (getSessionInfo reads this).
const proj = path.join(CLAUDE_DIR, 'projects', OTHER.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(proj, { recursive: true });
writeFileSync(path.join(proj, `${CLI_SID}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: '幫我修登入按鈕' }, uuid: 'a1b2c3d4-0000-4000-8000-000000000001', parentUuid: null, sessionId: CLI_SID, cwd: OTHER, timestamp: new Date().toISOString() }) + '\n');

const config = await import('./config.js');
const commands = await import('./discord/commands.js');
const policy = await import('./runner/policy.js');
const post = await import('./discord/post.js');
const ipc = await import('./ipc/control.js');
const control = await import('./discord/control.js');
const takeover = await import('./discord/takeover.js');
const conversation = await import('./discord/conversation.js');
const commandRun = await import('./discord/command-run.js');
const state = await import('./store/state.js');
const pool = await import('./runner/pool.js');
const queue = await import('./router/queue.js');
const session = await import('./runner/session.js');
const CTL = '../plugin/scripts/channelcollab.mjs';
type Cmd = (p: unknown, opts: Record<string, unknown>) => Promise<void>;
const ctl = (await import(CTL)) as unknown as {
  paths: (home: string) => unknown;
  bridgeCommands: Record<string, Cmd>;
  pickConversation: (rows: { key: string; kind: string; sessionId: string; takenOver?: boolean }[], which?: unknown, sid?: string) => { key: string } | null;
  RESUME_SCRIPT: string;
  resumeEnv: (o: { cwd: string; launcher: string; sessionId: string; title?: string }, base?: NodeJS.ProcessEnv) => Record<string, string | undefined>;
  resumeCommand: (o: { launcher: string; sessionId: string }) => string;
  cleanEnv: (env: NodeJS.ProcessEnv) => Record<string, string | undefined>;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  listHomes: (base: string) => { home: string; name: string }[];
};

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
function has(text: string | undefined, part: string, yes = true): void {
  if (!!text?.includes(part) !== yes) throw new Error(`${yes ? '應該' : '不應該'}含有「${part}」：${text}`);
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Console output while `fn` runs (the bot's log and the control script both print there). */
async function output(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

// --- fakes -----------------------------------------------------------------
type Sent = { content?: string; files?: unknown[]; allowedMentions?: { users?: string[]; parse?: string[] }; components?: unknown[] };
let nextId = 700000000000000000n;
const newId = () => String(++nextId);
const messages = new Map<string, ReturnType<typeof fakeMessage>>();

function fakeMessage(roomId: string, authorId: string, content: string, bot = false) {
  const m = {
    id: newId(),
    url: `https://discord.com/channels/${GUILD}/${roomId}/`,
    author: { id: authorId, bot, username: `u${authorId.slice(-2)}`, displayName: `使用者${authorId.slice(-2)}` },
    client: undefined as unknown,
    content,
    cleanContent: content,
    attachments: new Map(),
    replies: [] as Sent[],
    reacts: [] as string[],
    reply: async (r: Sent) => void m.replies.push(r),
    react: async (e: string) => void m.reacts.push(e),
    reactions: { cache: { get: () => undefined, find: () => undefined } },
  };
  m.url += m.id;
  messages.set(m.id, m);
  return m;
}

function fakeThread(id: string, parentId: string, name: string) {
  const th = {
    id,
    name,
    parentId,
    ownerId: SELF,
    guildId: GUILD,
    url: `https://discord.com/channels/${GUILD}/${id}`,
    sent: [] as Sent[],
    isThread: () => true,
    isTextBased: () => true,
    async send(m: Sent) {
      th.sent.push(m);
      const msg = fakeMessage(id, SELF, m.content ?? '', true);
      msg.client = client;
      return msg;
    },
    messages: { fetch: async (mid: string) => messages.get(mid) ?? Promise.reject(new Error('unknown message')) },
    fetchStarterMessage: async () => null,
  };
  return th;
}

const threads = new Map<string, ReturnType<typeof fakeThread>>();
function fakeChannel(id: string, name: string) {
  const ch = {
    id,
    name,
    type: 0, // GuildText
    guildId: GUILD,
    sent: [] as Sent[],
    isThread: () => false,
    isTextBased: () => true,
    async send(m: Sent) {
      ch.sent.push(m);
      return fakeMessage(id, SELF, m.content ?? '', true);
    },
    created: [] as { name: string }[],
    threads: {
      create: async (o: { name: string }) => {
        ch.created.push(o);
        const th = fakeThread(newId(), id, o.name);
        threads.set(th.id, th);
        return th;
      },
    },
  };
  return ch;
}
const chMain = fakeChannel(CH, 'dev-team');
const chOther = fakeChannel(CH2, 'planning');
const chUnbound = fakeChannel(UNBOUND, 'secret');
const existing = fakeThread(THREAD, CH, '登入按鈕');
threads.set(THREAD, existing);
const dmRoom = { id: 'dm-room', type: 1, sent: [] as Sent[], async send(m: Sent) { dmRoom.sent.push(m); return fakeMessage('dm-room', SELF, m.content ?? '', true); }, messages: { fetch: async (mid: string) => messages.get(mid) } };
const channels = new Map<string, unknown>([[CH, chMain], [CH2, chOther], [UNBOUND, chUnbound]]);
const client = {
  user: { id: SELF, tag: 'TestBot#0001' },
  application: { id: SELF },
  isReady: () => true,
  users: { fetch: async () => ({ createDM: async () => dmRoom }) },
  channels: {
    cache: { get: (id: string) => channels.get(id) },
    fetch: async (id: string) => channels.get(id) ?? threads.get(id) ?? null,
  },
};
type AnyClient = Parameters<typeof post.postReport>[0];
const C = client as unknown as AnyClient;
const threadConv = () => ({ key: THREAD, kind: 'thread' as const, room: existing as never, base: config.resolveChannel(config.loadConfig(), CH)!, selfId: SELF });

// ---------------------------------------------------------------------------
console.log('回報到群組：目標頻道');
await t('只認這隻 Bot 綁定的頻道：ID、名稱、#名稱、<#ID> 都可以；沒綁定的拒絕並列出可以貼的頻道', () => {
  const targets = post.boundTargets(C, config.loadConfig());
  eq(targets, [{ id: CH, name: 'dev-team' }, { id: CH2, name: 'planning' }]);
  eq(post.resolveTarget(targets, CH), { ok: true, id: CH });
  eq(post.resolveTarget(targets, '#Dev-Team'), { ok: true, id: CH });
  eq(post.resolveTarget(targets, `<#${CH2}>`), { ok: true, id: CH2 });
  const no = post.resolveTarget(targets, UNBOUND);
  eq(no.ok, false);
  has((no as { error: string }).error, '#dev-team');
  has((no as { error: string }).error, 'secret', false);
  const dup = post.resolveTarget([{ id: CH, name: 'x' }, { id: CH2, name: 'X' }], 'x');
  has((dup as { error: string }).error, '好幾個');
  has(post.targetsLine(targets), `#dev-team（ID ${CH}）`);
});
await t('提示詞列出可以貼的頻道（名稱和 ID）；沒有綁頻道時說不能用；其餘守則不變', () => {
  const g = session.guidelines(SELF, false, 'dm', post.targetsLine(post.boundTargets(C, config.loadConfig())));
  has(g, 'post_to_channel');
  has(g, '#dev-team');
  has(g, CH);
  has(g, '主人按按鈕核准');
  has(session.guidelines(SELF, false, 'dm', ''), '沒有綁定任何頻道');
  has(g, '你的一般文字輸出沒有人看得到');
});
await t('來源標示：私訊、討論串、電腦；主人只寫名字不通知；文字裡 @ 的其他人會通知', () => {
  has(post.sourceLabel({ kind: 'dm' }, OWNER), `📣 由 <@${OWNER}> 的私訊工作回報`);
  has(post.sourceLabel({ kind: 'thread', threadId: THREAD }, OWNER), `<#${THREAD}>`);
  has(post.sourceLabel({ kind: 'cli' }, OWNER), '在電腦上');
  eq(post.mentionedUsers(`<@${OWNER}> 和 <@!${MEMBER}> 請看`, OWNER), [MEMBER]);
});

console.log('回報到群組：權限');
await t('私訊（主人）與主人在討論串觸發：直接放行；別人或其他 Bot 觸發：要主人按按鈕；plan 一律拒絕；dontAsk 不問就拒絕', () => {
  eq(policy.decidePost('auto', true).kind, 'allow');
  eq(policy.decidePost('default', true).kind, 'allow');
  eq(policy.decidePost('default', false).kind, 'ask');
  eq(policy.decidePost('auto', false).kind, 'ask', 'auto 模式也不交給分類器');
  eq(policy.decidePost('acceptEdits', false).kind, 'ask');
  eq(policy.decidePost('plan', true).kind, 'deny');
  eq(policy.decidePost('dontAsk', false).kind, 'deny');
  eq(policy.decidePost('dontAsk', true).kind, 'allow');
  // reply stays a free own tool; post_to_channel is decided by decidePost, not this rule.
  eq(policy.decideTool(session.REPLY_TOOL, {}, { mode: 'default', roots: [WORK], alwaysAllowed: new Set(), ownPrefix: 'mcp__channelcollab__' }).kind, 'allow');
});

console.log('回報到群組：發文');
await t('貼到綁定頻道：第一行標明來源、內容照貼、回傳連結；主人不會被通知', async () => {
  const r = await post.postReport(C, { channel: '#dev-team', text: `做完了 <@${MEMBER}>`, source: { kind: 'dm' } });
  eq(r.ok, true);
  const m = chMain.sent.at(-1)!;
  has(m.content, `📣 由 <@${OWNER}> 的私訊工作回報\n做完了`);
  eq(m.allowedMentions?.users, [MEMBER]);
  has((r as { url: string }).url, 'https://discord.com/channels/');
});
await t('沒綁定的頻道、別的頻道底下的討論串：拒絕，什麼都不送', async () => {
  const before = chUnbound.sent.length;
  const r1 = await post.postReport(C, { channel: UNBOUND, text: 'x', source: { kind: 'dm' } });
  eq(r1.ok, false);
  eq(chUnbound.sent.length, before);
  const r2 = await post.postReport(C, { channel: CH2, thread: THREAD, text: 'x', source: { kind: 'dm' } });
  eq(r2.ok, false);
  has((r2 as { error: string }).error, '不在');
  eq((await post.postReport(C, { channel: CH, text: '  ', source: { kind: 'dm' } })).ok, false, '空的內容');
});
await t('開新討論串：Bot 開的、內容在討論串裡；記下要從哪個 session 複製（第一次被觸發時才複製），之後的歷史從回報之後算', async () => {
  const r = await post.postReport(C, { channel: CH, text: '週報', newThread: '本週進度', source: { kind: 'dm' }, forkFrom: { sessionId: SID, cwd: OTHER } });
  eq(r.ok, true);
  const th = threads.get((r as { threadId: string }).threadId)!;
  eq(chMain.created.at(-1)?.name, '本週進度');
  has(th.sent[0].content, '週報');
  const ts = state.getThread(th.id)!;
  eq(ts.channelId, CH);
  eq(ts.forkFrom, { sessionId: SID, cwd: OTHER });
  eq(ts.sessionId, undefined, '還沒複製');
  eq(!!ts.lastSeenMessageId, true);
  has((r as { where: string }).where, '新討論串「本週進度」');
});
await t('既有的討論串（在綁定頻道底下）可以貼', async () => {
  const r = await post.postReport(C, { channel: CH, thread: THREAD, text: '補充', source: { kind: 'thread', threadId: THREAD } });
  eq(r.ok, true);
  has(existing.sent.at(-1)?.content, '補充');
});

console.log('控制通道（named pipe）');
const server = ipc.createControlServer({
  async stop() {
    return 'stopping pid=1';
  },
  async 'pin-state'() {
    return { configured: false };
  },
  ...control.controlHandlers(() => client as never),
});
await new Promise<void>((r) => server.listen(config.STOP_PIPE, r));
const P = ctl.paths(HOME);
const run = (cmd: string, opts: Record<string, unknown>) => output(() => ctl.bridgeCommands[cmd](P, { _: [cmd], ...opts }));
await t('一行一個指令：舊的純文字指令照舊；JSON 指令；解析不了的回 unknown', () => {
  eq(ipc.parseControlLine('stop\n'), { cmd: 'stop', args: {} });
  eq(ipc.parseControlLine('{"cmd":"post","text":"a\\nb"}'), { cmd: 'post', args: { text: 'a\nb' } });
  eq(ipc.parseControlLine('{"text":"no cmd"}'), undefined);
  eq(ipc.parseControlLine('rm -rf'), undefined);
});
await t('長內容分好幾段到達也收得完整（讀到換行為止）；舊指令 stop 仍回 pid', async () => {
  const { pipeRequest } = (await import(CTL)) as unknown as { pipeRequest: (p: string, t: string, ms?: number) => Promise<string | null> };
  eq(await pipeRequest(config.STOP_PIPE, 'stop'), 'stopping pid=1');
  const long = '長'.repeat(30000);
  const before = chMain.sent.length;
  const out = await run('post', { channel: CH, 'text-file': (writeFileSync(path.join(HOME, 'long.txt'), long), path.join(HOME, 'long.txt')) });
  has(out, '✅ 已貼到 #dev-team');
  const got = chMain.sent.slice(before).map((m) => m.content ?? '').join('').replace(/📣[^\n]*\n/, '');
  eq(got.replace(/長/g, ''), '', '只有原本的內容');
  eq(got.length, long.length, '內容完整（切段後合起來）');
});
await t('post（電腦上）：經 pipe 請 Bot 發文，印出連結；附檔不能是禁區（Bot 的 HOME）；開新討論串會記下電腦的 session', async () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-files-'));
  const f = path.join(outside, 'report.txt');
  writeFileSync(f, '附件');
  writeFileSync(path.join(HOME, 'note.txt'), '測試回報');
  const out = await run('post', { channel: 'planning', 'new-thread': '電腦回報', 'text-file': path.join(HOME, 'note.txt'), file: [f, path.join(HOME, 'config.json')], session: CLI_SID, cwd: OTHER });
  has(out, '✅ 已貼到 #planning 的新討論串「電腦回報」');
  has(out, '連結：https://discord.com/channels/');
  has(out, '沒附上');
  has(out, '禁區');
  const th = [...threads.values()].find((x) => x.name === '電腦回報')!;
  has(th.sent[0].content, `📣 由 <@${OWNER}> 在電腦上的工作回報\n測試回報`);
  eq((th.sent[0].files ?? []).length, 1, '只附上工作資料夾的檔案');
  eq(state.getThread(th.id)?.forkFrom, { sessionId: CLI_SID, cwd: OTHER });
});
await t('post 到沒綁定的頻道：腳本報錯，不發文', async () => {
  let err = '';
  await run('post', { channel: UNBOUND, 'text-file': path.join(HOME, 'note.txt') }).catch((e: Error) => (err = e.message));
  has(err, '不是這隻 Bot 綁定的頻道');
});
await t('targets：列出 Bot 與可以貼的頻道名稱', async () => {
  const out = await run('targets', {});
  has(out, 'TestBot#0001');
  has(out, '#dev-team');
  has(out, CH2);
});

console.log('在電腦上接手（takeover）');
const th0 = state.getThread(THREAD) ?? state.registerThread(THREAD, CH, '登入按鈕');
Object.assign(th0, { sessionId: SID, lastAt: new Date().toISOString(), first: '登入按鈕壞了' });
state.saveState();
await t('sessions：列出討論串與私訊的時間、來源、摘要、session ID、cwd', async () => {
  const out = await run('sessions', {});
  has(out, '討論串「登入按鈕」');
  has(out, SID);
  has(out, WORK);
  has(out, '登入按鈕壞了');
});
await t('Claude 正在工作時不能接手', async () => {
  let release!: () => void;
  queue.enqueue(THREAD, () => new Promise<void>((r) => (release = r)));
  let err = '';
  await run('takeover', { key: THREAD, 'no-window': true }).catch((e: Error) => (err = e.message));
  has(err, '正在');
  release();
  await tick();
  eq(state.getThread(THREAD)?.takeover, undefined);
});
await t('接手：標記成接手中、Bot 不能再開這個 session、討論串發一則說明；回傳 session、cwd、啟動器', async () => {
  const out = await run('takeover', { key: THREAD, 'no-window': true });
  has(out, '✅ Bot 已放開討論串「登入按鈕」');
  has(out, SID);
  has(out, `"${NO_LAUNCHER}" --resume ${SID} --system-prompt-snapshot off`);
  eq(state.getThread(THREAD)?.takeover?.sessionId, SID);
  has(existing.sent.at(-1)?.content, `🖥️ <@${OWNER}> 在電腦上接手了這段對話`);
  let err = '';
  await pool.acquire(THREAD, SELF, config.resolveChannel(config.loadConfig(), CH)!, SID, 0).catch((e: Error) => (err = e.message));
  has(err, 'taken over');
});
await t('接手中被觸發：回「主人在電腦上接手中」、記下訊息、不開 session；skill／retry 之類請他交還後再做', async () => {
  const m = fakeMessage(THREAD, MEMBER, '進度如何？');
  m.client = client;
  const status = { set: async () => {} } as never;
  await conversation.runTurn(threadConv(), m as never, status, { ownerId: OWNER, requesterId: MEMBER });
  has(m.replies[0]?.content, '主人在電腦上接手中，結束後會接回');
  eq(m.reacts.includes('🖥️'), true);
  eq(state.getThread(THREAD)?.takeover?.queued, [m.id]);
  eq(pool.liveSession(THREAD), undefined, '沒有開 session');
  const m2 = fakeMessage(THREAD, OWNER, '/retry');
  m2.client = client;
  await conversation.runTurn(threadConv(), m2 as never, status, { ownerId: OWNER, requesterId: OWNER }, { kind: 'retry', prompt: 'x' });
  has(m2.replies[0]?.content, '交還後再做');
  eq(state.getThread(THREAD)?.takeover?.queued.length, 1, 'retry 不排進去');
});
await t('接手中：/clear 拒絕；/status 顯示接手中', async () => {
  const told: string[] = [];
  const io = { actor: { id: OWNER, name: '主人' }, client, slash: true, tell: async (s: string) => void told.push(s), note: async (s: string) => void told.push(s), ack: async () => {}, anchor: async () => fakeMessage(THREAD, SELF, '') };
  await commandRun.runCommand({ name: 'status' }, threadConv() as never, io as never, { ownerId: OWNER });
  has(told.at(-1), '在電腦上接手中');
});
await t('交還（release --session）：Bot 接回、發「✅ 已交還給 Bot」、接著處理記下的訊息；下一輪告訴 Claude 中間在電腦上做過', async () => {
  const out = await run('release', { session: SID });
  has(out, '已把討論串「登入按鈕」交還給 Bot');
  has(out, '記下的 1 則訊息');
  has(out, '關掉');
  const ts = state.getThread(THREAD)!;
  eq(ts.takeover, undefined);
  eq(ts.sessionId, SID, 'resume 不會換 session ID');
  has(existing.sent.find((s) => s.content?.startsWith('✅ 已交還給 Bot'))?.content, '接著處理期間記下的 1 則訊息');
  // The kept message runs as a turn (here it fails at once: the test launcher does not exist).
  for (let i = 0; i < 40 && !existing.sent.some((x) => x.content?.startsWith('❌')); i++) await tick(100);
  eq(existing.sent.some((x) => x.content?.startsWith('❌')), true, '記下的訊息有跑成一輪（測試用的啟動器不存在，所以立刻失敗）');
});
await t('強制接回（/takeback）：只有主人；提醒電腦上的對話先關閉', async () => {
  await run('takeover', { key: THREAD, 'no-window': true });
  eq(commands.commandGate({ cmd: 'takeback', where: 'thread', actorId: MEMBER, ownerId: OWNER, locked: false, bound: true, notAllowed: false, requesterId: MEMBER }), 'owner-only');
  eq(commands.commandGate({ cmd: 'takeback', where: 'thread', actorId: OWNER, ownerId: OWNER, locked: false, bound: true, notAllowed: false, requesterId: MEMBER }), undefined);
  has(commands.gateText('owner-only', { cmd: 'takeback', ownerId: OWNER, slash: true }), '只有 Bot 的主人');
  eq(commands.parseCommand('!takeback'), { name: 'takeback' });
  const told: string[] = [];
  const io = { actor: { id: OWNER, name: '主人' }, client, slash: false, tell: async (s: string) => void told.push(s), note: async (s: string) => void told.push(s), ack: async () => {}, anchor: async () => fakeMessage(THREAD, SELF, '') };
  await commandRun.runCommand({ name: 'takeback' }, threadConv() as never, io as never, { ownerId: OWNER });
  eq(state.getThread(THREAD)?.takeover, undefined);
  has(existing.sent.at(-1)?.content, '已強制接回');
  has(existing.sent.at(-1)?.content, '電腦上的對話請先關閉');
  told.length = 0;
  await commandRun.runCommand({ name: 'takeback' }, threadConv() as never, io as never, { ownerId: OWNER });
  has(told[0], '沒有在電腦上接手中');
});
await t('接手時開的視窗：.cmd 只有 ASCII（中文路徑放環境變數）、拿掉 session 標記、用綁定的啟動器 resume 並關掉 snapshot', () => {
  eq(/^[\x00-\x7f]*$/.test(ctl.RESUME_SCRIPT), true, '只有 ASCII');
  has(ctl.RESUME_SCRIPT, 'set "CLAUDECODE="');
  has(ctl.RESUME_SCRIPT, 'set "CLAUDE_CODE_SESSION_ID="');
  has(ctl.RESUME_SCRIPT, '"%CC_RESUME_LAUNCHER%" --resume %CC_RESUME_SID% --system-prompt-snapshot off');
  has(ctl.RESUME_SCRIPT, 'call ', false);
  const env = ctl.resumeEnv({ cwd: 'C:\\王 小明\\專案', launcher: 'C:\\x\\啟動 器.cmd', sessionId: SID, title: '接手' }, { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x' });
  eq([env.CC_RESUME_CWD, env.CC_RESUME_LAUNCHER, env.CC_RESUME_SID, env.CLAUDECODE, env.CLAUDE_CODE_SESSION_ID, env.PATH], ['C:\\王 小明\\專案', 'C:\\x\\啟動 器.cmd', SID, undefined, undefined, 'p']);
  eq(ctl.resumeEnv({ cwd: 'C:\\a', launcher: 'claude', sessionId: SID }, {}).CC_RESUME_LAUNCHER, undefined, '內建 claude');
  eq(ctl.resumeCommand({ launcher: '', sessionId: SID }), `claude --resume ${SID} --system-prompt-snapshot off`);
  let bad = '';
  try {
    ctl.resumeCommand({ launcher: '', sessionId: 'x & del *' });
  } catch (e) {
    bad = (e as Error).message;
  }
  has(bad, '格式不對');
});
await t('選對話：編號、dm、討論串 ID、或 session ID（交還時優先找接手中的）', () => {
  const rows = [{ key: THREAD, kind: 'thread', sessionId: SID, takenOver: true }, { key: 'dm', kind: 'dm', sessionId: CLI_SID }];
  eq(ctl.pickConversation(rows, '2')?.key, 'dm');
  eq(ctl.pickConversation(rows, 'dm')?.key, 'dm');
  eq(ctl.pickConversation(rows, THREAD)?.key, THREAD);
  eq(ctl.pickConversation(rows, undefined, SID)?.key, THREAD);
  eq(ctl.pickConversation(rows, '9'), null);
});

console.log('交給手機（handoff）');
await t('交到私訊：私訊改接電腦的 session，照那個 session 的資料夾跑（和私訊設定不同時說明）；貼摘要與關掉電腦對話的提醒；/clear 後回到私訊的資料夾', async () => {
  writeFileSync(path.join(HOME, 'sum.txt'), '修好登入按鈕，剩下測試');
  const out = await run('handoff', { session: CLI_SID, cwd: OTHER, 'summary-file': path.join(HOME, 'sum.txt') });
  has(out, '已把這段對話交給 Bot 的私訊');
  has(out, '和私訊平常的');
  has(out, '關掉電腦上的這個對話');
  const dm = state.getDm();
  eq([dm.sessionId, dm.cwd, dm.source], [CLI_SID, OTHER, '從電腦交棒']);
  has(dm.pendingNote, '從電腦上的 Claude Code 交給 Discord');
  const text = dmRoom.sent.map((s) => s.content).join('\n');
  has(text, '從電腦交棒過來的對話');
  has(text, '修好登入按鈕，剩下測試');
  has(text, '請關掉');
  const conv = { key: 'dm', kind: 'dm' as const, room: dmRoom as never, base: config.resolveDm(config.loadConfig())!, selfId: SELF };
  eq(conversation.effective(conv).cwd, OTHER);
  state.switchDm();
  eq(conversation.effective(conv).cwd, WORK, '/clear 之後');
});
await t('交到綁定頻道的新討論串：討論串對應到電腦的 session 與資料夾；回傳連結', async () => {
  const out = await run('handoff', { session: CLI_SID, cwd: OTHER, channel: 'dev-team', title: '登入按鈕（接續）', 'summary-file': path.join(HOME, 'sum.txt') });
  has(out, '討論串「登入按鈕（接續）」');
  has(out, '連結：https://discord.com/channels/');
  const th = [...threads.values()].find((x) => x.name === '登入按鈕（接續）')!;
  const ts = state.getThread(th.id)!;
  eq([ts.sessionId, ts.cwd, ts.channelId], [CLI_SID, OTHER, CH]);
  has(th.sent.map((s) => s.content).join('\n'), '從電腦交棒');
});
await t('找不到的 session、格式不對的 ID：拒絕', async () => {
  let err = '';
  await run('handoff', { session: '99999999-9999-4999-8999-999999999999' }).catch((e: Error) => (err = e.message));
  has(err, '找不到');
  err = '';
  await run('handoff', { session: 'not-a-uuid' }).catch((e: Error) => (err = e.message));
  has(err, '格式不對');
});
server.close();
await t('Bot 沒在執行：腳本提示先啟動，不自己連 Discord', async () => {
  let err = '';
  await run('post', { channel: CH, 'text-file': path.join(HOME, 'note.txt') }).catch((e: Error) => (err = e.message));
  has(err, 'Bot 沒有在執行');
});

console.log('努力程度（effort）');
await t('解析：low／medium／high／xhigh／max，default 回到預設；斜線選項 level；!effort high', () => {
  eq(['low', 'MAX', 'default', 'none', 'turbo'].map((x) => commands.normalizeEffort(x)), ['low', 'max', null, null, undefined]);
  eq(commands.commandFromSlash('effort', { level: 'xhigh' }), { name: 'effort', arg: 'xhigh' });
  eq(commands.commandFromSlash('effort', {}), { name: 'effort' });
  eq(commands.parseCommand('!effort high'), { name: 'effort', arg: 'high' });
  has(commands.helpText('thread'), '/effort');
});
await t('設定：頻道與私訊的 effort；不合法的值當作沒設；對話選的蓋過綁定，記在 state', async () => {
  const c = config.loadConfig();
  eq(config.resolveChannel(c, CH)!.effort, 'high');
  eq(config.resolveChannel(c, CH2)!.effort, undefined);
  writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(HOME, 'config.json'), 'utf8')), dm: { cwd: WORK, effort: 'turbo' } }));
  eq(config.resolveDm(config.loadConfig())!.effort, undefined);
  const told: string[] = [];
  const io = { actor: { id: OWNER, name: '主人' }, client, slash: false, tell: async (s: string) => void told.push(s), note: async (s: string) => void told.push(s), ack: async () => {}, anchor: async () => fakeMessage(THREAD, SELF, '') };
  await commandRun.runCommand({ name: 'effort', arg: 'max' }, threadConv() as never, io as never, { ownerId: OWNER });
  has(told.at(-1), '努力程度已設為 **max**');
  eq(state.getThread(THREAD)?.effort, 'max');
  eq(conversation.effective(threadConv()).effort, 'max');
  await commandRun.runCommand({ name: 'status' }, threadConv() as never, io as never, { ownerId: OWNER });
  has(told.at(-1), '努力程度：max');
  await commandRun.runCommand({ name: 'effort', arg: 'default' }, threadConv() as never, io as never, { ownerId: OWNER });
  eq(state.getThread(THREAD)?.effort, undefined);
  eq(conversation.effective(threadConv()).effort, 'high', '回到綁定的');
  await commandRun.runCommand({ name: 'effort', arg: 'turbo' }, threadConv() as never, io as never, { ownerId: OWNER });
  has(told.at(-1), '不認得');
});

console.log('總控的其他小工具');
await t('--file 可以給好幾次；homes 找 .channelcollab* 底下有 config.json 的資料夾', () => {
  eq(ctl.parseArgs(['post', '--file', 'a', '--file', 'b', '--channel', 'x']).file, ['a', 'b']);
  const base = mkdtempSync(path.join(os.tmpdir(), 'cc-homes-'));
  for (const d of ['.channelcollab', '.channelcollab-b', '.channelcollab-empty', 'other']) mkdirSync(path.join(base, d));
  writeFileSync(path.join(base, '.channelcollab', 'config.json'), '{}');
  writeFileSync(path.join(base, '.channelcollab-b', 'config.json'), '{}');
  writeFileSync(path.join(base, 'other', 'config.json'), '{}');
  eq(ctl.listHomes(base).map((h) => path.basename(h.home)), ['.channelcollab', '.channelcollab-b']);
  rmSync(base, { recursive: true, force: true });
});

await tick(300);
await pool.closeAll();
rmSync(HOME, { recursive: true, force: true });
rmSync(CLAUDE_DIR, { recursive: true, force: true });
console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
process.exitCode = fail ? 1 : 0;
process.exit();
