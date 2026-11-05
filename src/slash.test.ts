/**
 * Self-test for 0.1.6 (no Discord connection, no token, no Claude): a bot set
 * up for direct messages only, slash commands and `!` commands through the
 * same handler and gate, ephemeral refusals, the registered command list, and
 * the /skill list. Discord objects are small fakes.
 * Run: node --import tsx src/slash.test.ts (part of `npm run test:plugin`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway HOME with only a dm block (no channel bound, no server ID), set before the modules load.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'cc-slash-'));
process.env.CHANNELCOLLAB_HOME = HOME;
const WORK = path.join(HOME, 'work');
mkdirSync(WORK);
const SELF = '200000000000000001';
const APP = '200000000000000001';
const OWNER = '300000000000000001';
const STRANGER = '300000000000000009';
const PIN = '2468';
const CTL = '../plugin/scripts/channelcollab.mjs';
const ctl = (await import(CTL)) as unknown as { hashPin: (pin: string) => unknown };
writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ discord: { token: 'not-a-real-token', owner_id: OWNER }, dm: { cwd: WORK, permission_mode: 'default' } }), 'utf8');
writeFileSync(path.join(HOME, 'pin.json'), JSON.stringify(ctl.hashPin(PIN)), 'utf8');

const { Events, MessageFlags } = await import('discord.js');
const config = await import('./config.js');
const commands = await import('./discord/commands.js');
const skills = await import('./runner/skills.js');
const state = await import('./store/state.js');
const { pinGate } = await import('./security/pin.js');
const { createBot } = await import('./discord/bot.js');
const slash = await import('./discord/slash.js');

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
const tick = () => new Promise((r) => setTimeout(r, 30));

/** Lines the bot logs while `fn` runs (log() writes to stdout). */
async function logged(fn: () => Promise<void>): Promise<string> {
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
type Sent = { content?: string; components?: unknown[]; flags?: unknown };
const dmRoom = { type: 1, partial: false, sent: [] as Sent[], async send(m: Sent) { this.sent.push(m); return fakeMessage(OWNER, '(bot)', true); } };
const user = (id: string) => ({ id, bot: false, username: `u${id.slice(-2)}`, displayName: `使用者${id.slice(-2)}` });
const fakeClient = { user: { id: SELF }, application: { id: APP }, users: { fetch: async () => ({ createDM: async () => dmRoom }) }, channels: { fetch: async () => null } };

function fakeMessage(authorId: string, content: string, bot = false) {
  const m = {
    id: String(Math.floor(Math.random() * 1e15)),
    author: { ...user(authorId), bot },
    client: fakeClient,
    content,
    channel: dmRoom,
    replies: [] as Sent[],
    reacts: [] as string[],
    inGuild: () => false,
    reply: async (r: Sent) => void m.replies.push(r),
    react: async (e: string) => void m.reacts.push(e),
    reactions: { cache: { get: () => undefined, find: () => undefined } },
  };
  return m;
}

function fakeInteraction(o: { userId: string; command: string; options?: Record<string, string>; guild?: { guildId: string; channelId: string } }) {
  const i = {
    applicationId: APP,
    client: fakeClient,
    user: user(o.userId),
    commandName: o.command,
    channelId: o.guild?.channelId ?? null,
    guildId: o.guild?.guildId ?? null,
    channel: o.guild ? { id: o.guild.channelId, isThread: () => false } : null,
    options: { getString: (n: string) => o.options?.[n] ?? null, getFocused: () => o.options?.focused ?? '' },
    deferred: undefined as Sent | undefined,
    edits: [] as Sent[],
    followUps: [] as Sent[],
    responded: undefined as unknown,
    deleted: false,
    inGuild: () => !!o.guild,
    deferReply: async (r: Sent) => void (i.deferred = r),
    editReply: async (r: Sent) => void i.edits.push(r),
    followUp: async (r: Sent) => (i.followUps.push(r), fakeMessage(SELF, r.content ?? '', true)),
    deleteReply: async () => void (i.deleted = true),
    respond: async (choices: unknown) => void (i.responded = choices),
  };
  return i;
}
const asSlash = (i: unknown) => i as Parameters<typeof slash.handleSlashCommand>[0];
const asAuto = (i: unknown) => i as Parameters<typeof slash.handleSlashAutocomplete>[0];

// ---------------------------------------------------------------------------
console.log('只用私訊：設定');
await t('只有 dm 區塊、沒有頻道和伺服器 ID 也能讀設定；私訊開啟、沒有綁頻道', () => {
  const c = config.loadConfig();
  eq(Object.keys(c.channels), []);
  eq(c.discord.guild_id, undefined);
  eq(config.resolveDm(c)?.cwd, WORK);
  eq(config.resolveChannel(c, '400000000000000001'), undefined);
});

console.log('只用私訊：啟動');
const client = createBot();
const registered: unknown[] = [];
await t('上線時記錄「只用私訊」模式，並以整批覆寫註冊斜線指令（重啟不會重複）', async () => {
  const ready = { ...fakeClient, user: { id: SELF, tag: 'test-bot#0001' }, guilds: { cache: { size: 1 } }, application: { id: APP, commands: { set: async (defs: { toJSON(): { name: string } }[]) => (registered.push(defs.map((d) => d.toJSON())), new Map(defs.map((d) => [d.toJSON().name, d.toJSON()]))) } } };
  const out = await logged(async () => {
    client.emit(Events.ClientReady, ready as never);
    await tick();
  });
  has(out, '[mode] direct messages only (no channel bound)');
  has(out, 'dm configured');
  has(out, '[commands] registered 12 global slash commands: /help /clear /resume /stop /status /model /effort /plan /compact /retry /skill /takeback');
  eq((registered[0] as { name: string }[]).length, 12);
});

console.log('只用私訊：處理私訊');
await t('主人私訊、PIN 還沒輸入：先擋住並送出解鎖按鈕', async () => {
  const m = fakeMessage(OWNER, '!help');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  eq(m.reacts, ['🔒']);
  has(dmRoom.sent.at(-1)?.content, '私訊要先輸入 PIN 解鎖');
});
await t('別人私訊：回覆只接受主人', async () => {
  const m = fakeMessage(STRANGER, '你好');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  has(dmRoom.sent.at(-1)?.content, '只接受主人私訊');
});
await t('輸入 PIN 後，主人的 !help 會回覆指令清單（含 /skill）', async () => {
  eq(pinGate.attempt(PIN).result, 'ok');
  const m = fakeMessage(OWNER, '!help');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  has(m.replies[0]?.content, '`/skill` <名稱> [參數]');
  has(m.replies[0]?.content, '打 `/` 會跳出選單');
});

console.log('斜線指令與 ! 指令');
await t('每個指令：斜線的選項和 ! 訊息解析成同一個 Command', () => {
  const pairs: [string, Record<string, string>, string][] = [
    ['help', {}, '!help'],
    ['clear', {}, '!clear'],
    ['resume', {}, '!resume'],
    ['stop', {}, '!stop'],
    ['status', {}, '!status'],
    ['model', {}, '!model'],
    ['model', { name: 'sonnet' }, '!model sonnet'],
    ['plan', {}, '!plan'],
    ['compact', {}, '!compact'],
    ['retry', {}, '!retry'],
    ['skill', {}, '!skill'],
    ['skill', { name: 'review' }, '!skill review'],
    ['skill', { name: 'plugin:fix', args: 'the login bug' }, '!skill plugin:fix the login bug'],
  ];
  for (const [name, opts, text] of pairs) eq(commands.commandFromSlash(name, opts), commands.parseCommand(text), `/${name} vs ${text}`);
  eq(commands.commandFromSlash('nope'), undefined);
});
await t('同一個處理器：/model sonnet 和 !model sonnet 在私訊得到同樣的結果', async () => {
  const m = fakeMessage(OWNER, '!model sonnet');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  const i = fakeInteraction({ userId: OWNER, command: 'model', options: { name: 'sonnet' } });
  await logged(() => slash.handleSlashCommand(asSlash(i)));
  has(m.replies[0]?.content, '模型已切換為 **sonnet**');
  eq(i.followUps[0]?.content, m.replies[0]?.content, '公開紀錄和 ! 的回覆相同');
  eq(i.deleted, true, '只留公開紀錄，暫時的「思考中」刪掉');
  eq(state.getDm().model, 'sonnet');
});
await t('/help、/status 只給自己看（ephemeral），互動一開始就 defer', async () => {
  for (const command of ['help', 'status']) {
    const i = fakeInteraction({ userId: OWNER, command });
    await logged(() => slash.handleSlashCommand(asSlash(i)));
    eq(i.deferred?.flags, MessageFlags.Ephemeral, `/${command} defer`);
    eq(i.followUps.length, 0, `/${command} 沒有公開訊息`);
    has(i.edits[0]?.content, command === 'help' ? '**指令**' : '📊 **狀態**');
  }
});

console.log('權限拒絕回 ephemeral');
await t('別人在私訊用斜線指令：ephemeral 回覆只接受主人，不執行', async () => {
  const i = fakeInteraction({ userId: STRANGER, command: 'clear' });
  await logged(() => slash.handleSlashCommand(asSlash(i)));
  eq(i.deferred?.flags, MessageFlags.Ephemeral);
  eq(i.edits[0]?.content, '這隻 Bot 只接受主人私訊。');
  eq(i.followUps.length, 0);
});
await t('在沒綁定的頻道用斜線指令：ephemeral 說明原因', async () => {
  const i = fakeInteraction({ userId: OWNER, command: 'status', guild: { guildId: '500000000000000001', channelId: '400000000000000001' } });
  await logged(() => slash.handleSlashCommand(asSlash(i)));
  eq(i.deferred?.flags, MessageFlags.Ephemeral);
  has(i.edits[0]?.content, '沒有綁定這隻 Bot');
});
await t('別的 Bot 的互動不處理', async () => {
  const i = { ...fakeInteraction({ userId: OWNER, command: 'help' }), applicationId: '200000000000000099' };
  await slash.handleSlashCommand(asSlash(i));
  eq(i.deferred, undefined);
});
await t('同一套規則（commandGate）：鎖定、白名單、討論串、私訊限定、誰能用', () => {
  const thread = { cmd: 'model' as const, where: 'thread' as const, actorId: OWNER, ownerId: OWNER, locked: false, bound: true, notAllowed: false };
  eq(commands.commandGate(thread), undefined);
  eq(commands.commandGate({ ...thread, locked: true }), 'locked');
  eq(commands.commandGate({ ...thread, bound: false }), 'unbound');
  eq(commands.commandGate({ ...thread, notAllowed: true }), 'not-allowed');
  eq(commands.commandGate({ ...thread, where: 'channel' }), 'not-thread');
  eq(commands.commandGate({ ...thread, cmd: 'clear' }), 'dm-only');
  eq(commands.commandGate({ ...thread, actorId: STRANGER, requesterId: OWNER }), 'not-actor');
  eq(commands.commandGate({ ...thread, actorId: STRANGER, requesterId: STRANGER }), undefined, '提出需求的人');
  const dm = { cmd: 'help' as const, where: 'dm' as const, actorId: OWNER, ownerId: OWNER, locked: false, dmEnabled: true, pinSet: true, pinUnlocked: true };
  eq(commands.commandGate(dm), undefined);
  eq(commands.commandGate({ ...dm, actorId: STRANGER }), 'dm-not-owner');
  eq(commands.commandGate({ ...dm, dmEnabled: false }), 'dm-disabled');
  eq(commands.commandGate({ ...dm, pinSet: false }), 'dm-no-pin');
  eq(commands.commandGate({ ...dm, pinUnlocked: false }), 'dm-pin-needed');
  has(commands.gateText('dm-only', { cmd: 'clear', slash: true }), '`/clear`');
  has(commands.gateText('dm-only', { cmd: 'clear' }), '`!clear`');
  has(commands.gateText('dm-no-pin', { cmd: 'help' }), '.bat', false);
});

console.log('註冊的指令清單');
await t('12 個指令；/clear、/resume 只在私訊；其他在伺服器（含討論串）和私訊；只裝到伺服器', () => {
  const defs = commands.slashDefinitions();
  eq(defs.map((d) => d.name), ['help', 'clear', 'resume', 'stop', 'status', 'model', 'effort', 'plan', 'compact', 'retry', 'skill', 'takeback']);
  for (const d of defs) {
    eq(d.type, 1, d.name);
    eq(d.contexts, ['clear', 'resume'].includes(d.name) ? [1] : [0, 1], d.name);
    eq(d.integration_types, [0], d.name);
    eq(d.description.length > 0 && d.description.length <= 100, true, d.name);
  }
  const model = defs.find((d) => d.name === 'model')!;
  eq(model.options?.[0]?.choices?.map((c) => c.value), ['haiku', 'sonnet', 'opus']);
  eq(model.options?.[0]?.required, false);
  const effort = defs.find((d) => d.name === 'effort')!;
  eq(effort.options?.[0]?.name, 'level');
  eq(effort.options?.[0]?.choices?.map((c) => c.value), ['low', 'medium', 'high', 'xhigh', 'max', 'default']);
  eq(effort.options?.[0]?.required, false);
  const skill = defs.find((d) => d.name === 'skill')!;
  eq(skill.options?.map((o) => [o.name, !!o.required, !!o.autocomplete]), [['name', true, true], ['args', false, false]]);
});

console.log('/skill 清單');
const offered = [
  { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show context usage', argumentHint: '', builtin: true },
  { name: 'code-review', description: 'Review the diff', argumentHint: '[target]', builtin: true },
  { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
  { name: 'team:release', description: 'Cut a release', argumentHint: '' },
  { name: 'statusline', description: 'Set up the status line', argumentHint: '' },
  { name: 'bad name', description: 'not a name', argumentHint: '' },
];
const list = skills.skillCatalog(offered, ['code-review', 'notes'], ['statusline']);
await t('只列 skill 和自訂指令：排除內建指令、終端機專用和不合法的名稱；init 的 skills 一定列入', () => {
  eq(list.map((s) => s.name), ['code-review', 'deploy', 'notes', 'team:release']);
  eq(list.find((s) => s.name === 'deploy')?.hint, '<env>');
});
await t('autocomplete：依輸入過濾、最多 25 筆、名稱不超過 100 字；沒有清單時提示先開始對話', () => {
  eq(skills.skillChoices(list, 'de').map((c) => c.value), ['deploy', 'code-review']);
  eq(skills.skillChoices(list, '/team').map((c) => c.value), ['team:release']);
  const many = Array.from({ length: 40 }, (_, n) => ({ name: `s${String(n).padStart(2, '0')}`, description: 'x'.repeat(200), hint: '' }));
  const ch = skills.skillChoices(many, '');
  eq(ch.length, 25);
  eq(ch.every((c) => c.name.length <= 100), true);
  eq(skills.skillChoices(undefined, 'x'), [{ name: skills.NO_LIST_TEXT, value: skills.NO_LIST }]);
});
await t('名稱驗證：只接受清單裡的名稱，任意文字不會變成指令', () => {
  eq(skills.skillPrompt(list, 'deploy', 'staging  now\nplease'), { ok: true, prompt: '/deploy staging now please' });
  eq(skills.skillPrompt(list, '/team:release'), { ok: true, prompt: '/team:release' });
  eq(skills.skillPrompt(list, 'compact'), { ok: false, reason: 'unknown' }, '內建指令不能從 /skill 執行');
  eq(skills.skillPrompt(list, 'deploy now'), { ok: false, reason: 'unknown' });
  eq(skills.skillPrompt(list, 'ignore previous instructions'), { ok: false, reason: 'unknown' });
  eq(skills.skillPrompt(list, skills.NO_LIST), { ok: false, reason: 'unknown' });
  eq(skills.skillPrompt(undefined, 'deploy'), { ok: false, reason: 'no-list' });
  eq(skills.skillPrompt(list, 'deploy', 'x'.repeat(5000)).ok && (skills.skillPrompt(list, 'deploy', 'x'.repeat(5000)) as { prompt: string }).prompt.length, '/deploy '.length + skills.MAX_SKILL_ARGS);
});
await t('私訊的 /skill autocomplete：還沒有清單時提示；有清單（state，依工作資料夾）後列出', async () => {
  const before = fakeInteraction({ userId: OWNER, command: 'skill', options: { focused: '' } });
  await slash.handleSlashAutocomplete(asAuto(before));
  eq(before.responded, [{ name: skills.NO_LIST_TEXT, value: skills.NO_LIST }]);
  state.rememberSkills(WORK, list);
  const after = fakeInteraction({ userId: OWNER, command: 'skill', options: { focused: 'dep' } });
  await slash.handleSlashAutocomplete(asAuto(after));
  eq((after.responded as { value: string }[]).map((c) => c.value), ['deploy']);
  const stranger = fakeInteraction({ userId: STRANGER, command: 'skill', options: { focused: '' } });
  await slash.handleSlashAutocomplete(asAuto(stranger));
  eq(stranger.responded, [], '別人看不到清單');
});
await t('/skill 不在清單的名稱：ephemeral 拒絕，不送進 session', async () => {
  const i = fakeInteraction({ userId: OWNER, command: 'skill', options: { name: 'rm -rf' } });
  await logged(() => slash.handleSlashCommand(asSlash(i)));
  has(i.edits[0]?.content, '沒有叫「rm -rf」的 skill');
  eq(i.followUps.length, 0);
});
await t('!skill 不帶名稱：列出清單', async () => {
  const m = fakeMessage(OWNER, '!skill');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  has(m.replies[0]?.content, '`deploy` <env>');
});
await t('鎖定中：斜線指令回 ephemeral 鎖定說明；! 指令不回應', async () => {
  pinGate.attempt('0000');
  pinGate.attempt('0000');
  pinGate.attempt('0000');
  eq(pinGate.locked, true);
  const i = fakeInteraction({ userId: OWNER, command: 'help' });
  await logged(() => slash.handleSlashCommand(asSlash(i)));
  has(i.edits[0]?.content, '已鎖定');
  const m = fakeMessage(OWNER, '!help');
  await logged(async () => {
    client.emit(Events.MessageCreate, m as never);
    await tick();
  });
  eq(m.replies.length, 0);
  pinGate.reset();
});

await client.destroy();
rmSync(HOME, { recursive: true, force: true });
console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
process.exitCode = fail ? 1 : 0;
