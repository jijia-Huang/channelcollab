/**
 * The roster (PLAN §12): roster.json in HOME, handed out by the admin (in the
 * handoff file, or imported with update-roster). No file means an empty roster.
 * Tells a session who it is and how to reach the other bots.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

export const ROSTER_PATH = path.join(DATA_DIR, 'roster.json');

export type RosterBot = {
  botId: string;
  botName: string;
  ownerName: string;
  ownerDiscordId: string;
  role: string;
};

const ROLE_NAMES: Record<string, string> = { engineer: '工程師', planner: '企劃' };

/** Read on every call so an updated roster applies to the next session. A missing or broken file means an empty roster. */
export function loadRoster(): RosterBot[] {
  if (!existsSync(ROSTER_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as { bots?: RosterBot[] };
    return Array.isArray(raw.bots) ? raw.bots : [];
  } catch (e) {
    log('roster', `cannot read ${ROSTER_PATH} (${(e as Error).name})`);
    return [];
  }
}

/** Who owns this bot according to the roster. */
export function rosterOwner(selfId: string): string | undefined {
  return loadRoster().find((b) => b.botId === selfId)?.ownerDiscordId;
}

/** Who may approve permission requests: discord.owner_id, else this bot's owner in the roster. */
export function botOwner(configured: string | undefined, selfId: string): string | undefined {
  return configured || rosterOwner(selfId);
}

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/** Identity, the other bots and the collaboration rules, appended to the system prompt. */
export function rosterPrompt(selfId: string, ownerId?: string, roster: RosterBot[] = loadRoster()): string {
  const self = roster.find((b) => b.botId === selfId);
  const others = roster.filter((b) => b.botId !== selfId);
  const lines = [
    self
      ? `【你的身分】你是 ${self.botName}（Discord ID ${selfId}），${self.ownerName} 的 Bot，角色：${roleName(self.role)}。`
      : `【你的身分】你是 Discord ID ${selfId} 的 Bot（不在名冊中）。`,
  ];
  if (ownerId) lines.push(`【你的主人】Discord ID ${ownerId}；要找主人就在 reply 文字裡寫 <@${ownerId}>。`);
  if (others.length) {
    lines.push('【其他 Bot】（名冊；討論串裡可能出現這些 Bot）');
    for (const b of others) lines.push(`- ${b.botName}：主人 ${b.ownerName}，角色 ${roleName(b.role)}；要找它就在 reply 文字裡寫 <@${b.botId}>`);
  }
  lines.push(
    '【和其他 Bot 協作】',
    '- 要讓某個 Bot 收到訊息，必須在 reply 的文字裡寫 `<@BotID>`（見上方名冊）。對話紀錄裡顯示的「@名稱」只是文字，照抄不會通知對方。',
    '- 只有需要對方做事或回答時才 @ 它；只是提到它，直接寫名稱，不要 @。',
    '- 其他 Bot 向你提問或交辦事情時，在回答裡 @ 它，它才收得到。你向別人要的答案拿到之後，直接照著做，不必再 @ 對方。',
    '- 不要禮貌性地互 @ 道謝、確認收到或寒暄，避免無意義的來回。',
    '- 一輪裡只在最後一則 reply 放 @，不要每則都 @。',
    '- 任務完成就停：完成報告是寫給人看的，不要 @ 任何 Bot（包括提供答案給你的 Bot）。',
    '- 被其他 Bot @ 但沒有需要你做的事（例如對方只是通知完成）時，不要呼叫 reply，這一輪直接結束。',
  );
  return lines.join('\n');
}
