/**
 * Self-test for the roster prompt and the speaker labels (no Discord, no token).
 * Run: node --import tsx src/roster.test.ts (part of `npm run test:plugin`).
 */
import type { Message } from 'discord.js';
import { speaker } from './discord/prompt.js';
import { rosterPeople, rosterPrompt, type Roster } from './roster.js';

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}：${(e as Error).message}`);
  }
}
function has(text: string, part: string, yes = true): void {
  if (text.includes(part) !== yes) throw new Error(`${yes ? '缺少' : '不該有'}「${part}」\n${text}`);
}
function eq(a: unknown, b: unknown): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
}

// 假資料：ID 都是明顯編出來的數字
const SELF = '100000000000000001';
const OTHER_BOT = '100000000000000002';
const BARE_BOT = '100000000000000003';
const OWNER = '200000000000000001';
const OTHER_OWNER = '200000000000000002';
const PLANNER = '200000000000000003';

const oldRoster: Roster = {
  bots: [
    { botId: SELF, botName: '小明Bot', ownerName: '小明', ownerDiscordId: OWNER, role: 'engineer' },
    { botId: OTHER_BOT, botName: '小明Bot2', ownerName: '小明', ownerDiscordId: OWNER, role: 'engineer' },
  ],
  members: [],
};
const roster: Roster = {
  bots: [
    { botId: SELF, botName: '小明Bot', ownerName: '小明', ownerDiscordId: OWNER, role: 'engineer' },
    { botId: OTHER_BOT, botName: '小華Bot', ownerName: '小華', ownerDiscordId: OTHER_OWNER, role: 'planner' },
    { botId: BARE_BOT, botName: '只有ID的Bot' },
  ],
  members: [
    { name: '企劃小美', discordId: PLANNER, role: 'planner' },
    { name: '華哥', discordId: OTHER_OWNER, role: 'planner' },
  ],
};

console.log('名冊提示詞');
t('舊名冊（沒有 members）：照常產生；同一位主人的兩個 Bot 不會讓主人出現在【團隊成員】', () => {
  const p = rosterPrompt(SELF, OWNER, oldRoster);
  has(p, '【你的身分】你是 小明Bot（Discord ID 100000000000000001），小明 的 Bot，角色：工程師。');
  has(p, `【你的主人】小明，Discord ID ${OWNER}；要找主人就在 reply 文字裡寫 <@${OWNER}>。`);
  has(p, `- 小明Bot2：主人 小明，角色 工程師；要找它就在 reply 文字裡寫 <@${OTHER_BOT}>`);
  has(p, '【團隊成員】', false);
  has(p, '【和其他 Bot 協作】');
});
t('空名冊：只有身分與協作守則', () => {
  const p = rosterPrompt(SELF, undefined, { bots: [], members: [] });
  has(p, '（不在名冊中）');
  has(p, '【其他 Bot】', false);
  has(p, '【團隊成員】', false);
});
t('【團隊成員】：members 與其他 Bot 的主人各一行、有 <@ID>；同一人不重複；自己的主人不列', () => {
  const p = rosterPrompt(SELF, OWNER, roster);
  has(p, '【團隊成員】（名冊上的人；要 @ 某人就在 reply 文字裡寫 <@ID>');
  has(p, `- 企劃小美：角色 企劃；要找他就在 reply 文字裡寫 <@${PLANNER}>`);
  has(p, `- 華哥：角色 企劃，Bot：小華Bot；要找他就在 reply 文字裡寫 <@${OTHER_OWNER}>`);
  eq(p.split(`<@${OTHER_OWNER}>`).length - 1, 1);
  has(p, `- 小明：`, false);
  has(p, `- 只有ID的Bot；要找它就在 reply 文字裡寫 <@${BARE_BOT}>`);
});
t('rosterPeople：members 優先，Bot 主人只在不在 members 時補上', () => {
  eq(
    rosterPeople(roster).map((p) => [p.name, p.discordId, p.bots]),
    [
      ['企劃小美', PLANNER, []],
      ['華哥', OTHER_OWNER, ['小華Bot']],
      ['小明', OWNER, ['小明Bot']],
    ],
  );
});

console.log('發話者標籤');
const msg = (id: string, username: string, displayName: string, bot = false) =>
  ({ author: { id, username, displayName, bot }, member: { displayName } }) as unknown as Message;
t('不在名冊的人：附 Discord ID', () => {
  eq(speaker(msg('300000000000000001', 'someone', '路人'), roster), '路人（someone，ID 300000000000000001）');
});
t('名冊上的人：附 ID、名冊名字與角色', () => {
  eq(speaker(msg(PLANNER, 'mei', '小美'), roster), `小美（mei，ID ${PLANNER}，名冊：企劃小美，企劃）`);
});
t('只是 Bot 主人（不在 members）也標出名冊名字', () => {
  eq(speaker(msg(OWNER, 'ming', '阿明'), roster), `阿明（ming，ID ${OWNER}，名冊：小明，工程師）`);
});
t('名冊上的 Bot 標籤與之前相同；沒有主人資料的 Bot 只標 ID', () => {
  eq(speaker(msg(OTHER_BOT, 'xh-bot', '小華Bot', true), roster), `小華Bot（xh-bot，Bot，小華 的企劃，ID ${OTHER_BOT}）`);
  eq(speaker(msg(BARE_BOT, 'bare', '只有ID的Bot', true), roster), `只有ID的Bot（bare，Bot，ID ${BARE_BOT}）`);
});

console.log(`\n自我測試：${pass} 通過，${fail} 失敗`);
process.exitCode = fail ? 1 : 0;
