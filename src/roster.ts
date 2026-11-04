/**
 * The roster (PLAN §12): roster.json in HOME. Each person keeps their own
 * (`channelcollab.mjs roster add|remove|import`); no file means an empty roster.
 * Tells a session who it is, how to reach the other bots, and who the people are.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

export const ROSTER_PATH = path.join(DATA_DIR, 'roster.json');

/** Owner and role are optional: a bot added by ID alone may have neither. */
export type RosterBot = {
  botId: string;
  botName: string;
  ownerName?: string;
  ownerDiscordId?: string;
  role?: string;
};

/** A person on the team (optional `members` in roster.json; older rosters have none). */
export type RosterMember = {
  name: string;
  discordId: string;
  role?: string;
};

export type Roster = { bots: RosterBot[]; members: RosterMember[] };

const ROLE_NAMES: Record<string, string> = { engineer: '工程師', planner: '企劃' };

/** Read on every call so an updated roster applies to the next session. A missing or broken file means an empty roster. */
export function loadRosterFile(): Roster {
  if (!existsSync(ROSTER_PATH)) return { bots: [], members: [] };
  try {
    const raw = JSON.parse(readFileSync(ROSTER_PATH, 'utf8').replace(/^﻿/, '')) as { bots?: RosterBot[]; members?: RosterMember[] };
    return {
      bots: Array.isArray(raw.bots) ? raw.bots.filter((b) => b && b.botId && b.botName) : [],
      members: Array.isArray(raw.members) ? raw.members.filter((m) => m && m.discordId && m.name) : [],
    };
  } catch (e) {
    log('roster', `cannot read ${ROSTER_PATH} (${(e as Error).name})`);
    return { bots: [], members: [] };
  }
}

/** The bots in the roster. */
export function loadRoster(): RosterBot[] {
  return loadRosterFile().bots;
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

/** 「主人 X，角色 Y」 for a bot, leaving out what the roster does not say. */
function botDetails(b: RosterBot): string {
  return [b.ownerName ? `主人 ${b.ownerName}` : '', b.role ? `角色 ${roleName(b.role)}` : ''].filter(Boolean).join('，');
}

export type RosterPerson = RosterMember & { bots: string[] };

/**
 * Every person in the roster, once per Discord ID: `members` first, then bot
 * owners who are not in `members`. `bots` lists the bots each person owns.
 */
export function rosterPeople(roster: Roster): RosterPerson[] {
  const people = new Map<string, RosterPerson>();
  for (const m of roster.members) {
    if (!people.has(m.discordId)) people.set(m.discordId, { name: m.name, discordId: m.discordId, role: m.role, bots: [] });
  }
  for (const b of roster.bots) {
    if (!b.ownerDiscordId) continue;
    const p = people.get(b.ownerDiscordId);
    if (p) p.bots.push(b.botName);
    else people.set(b.ownerDiscordId, { name: b.ownerName || `${b.botName} 的主人`, discordId: b.ownerDiscordId, role: b.role, bots: [b.botName] });
  }
  return [...people.values()];
}

/** Identity, the other bots, the people and the collaboration rules, appended to the system prompt. */
export function rosterPrompt(selfId: string, ownerId?: string, roster: Roster = loadRosterFile(), opts: { dm?: boolean } = {}): string {
  if (opts.dm) return dmRosterPrompt(selfId, ownerId, roster);
  const self = roster.bots.find((b) => b.botId === selfId);
  const others = roster.bots.filter((b) => b.botId !== selfId);
  const people = rosterPeople(roster);
  const owner = ownerId ? people.find((p) => p.discordId === ownerId) : undefined;
  const team = people.filter((p) => p.discordId !== ownerId);
  const lines = [
    self
      ? `【你的身分】你是 ${self.botName}（Discord ID ${selfId}）${self.ownerName ? `，${self.ownerName} 的 Bot` : ''}${self.role ? `，角色：${roleName(self.role)}` : ''}。`
      : `【你的身分】你是 Discord ID ${selfId} 的 Bot（不在名冊中）。`,
  ];
  if (ownerId) lines.push(`【你的主人】${owner ? `${owner.name}，` : ''}Discord ID ${ownerId}；要找主人就在 reply 文字裡寫 <@${ownerId}>。`);
  if (others.length) {
    lines.push('【其他 Bot】（名冊；討論串裡可能出現這些 Bot）');
    for (const b of others) {
      const details = botDetails(b);
      lines.push(`- ${b.botName}${details ? `：${details}` : ''}；要找它就在 reply 文字裡寫 <@${b.botId}>`);
    }
  }
  if (team.length) {
    lines.push('【團隊成員】（名冊上的人；要 @ 某人就在 reply 文字裡寫 <@ID>，和 Bot 一樣只在需要對方做事或回答時才 @）');
    for (const p of team) {
      const bots = p.bots.length ? `Bot：${p.bots.join('、')}` : '';
      const role = p.role ? `角色 ${roleName(p.role)}` : '';
      const details = [role, bots].filter(Boolean).join('，');
      lines.push(`- ${p.name}${details ? `：${details}` : ''}；要找他就在 reply 文字裡寫 <@${p.discordId}>`);
    }
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

/**
 * Direct messages: the same identity and team list, so Claude knows who is
 * who, but no hand-off rules and no <@ID> hints: nobody else is in a DM.
 */
function dmRosterPrompt(selfId: string, ownerId: string | undefined, roster: Roster): string {
  const self = roster.bots.find((b) => b.botId === selfId);
  const others = roster.bots.filter((b) => b.botId !== selfId);
  const people = rosterPeople(roster);
  const owner = ownerId ? people.find((p) => p.discordId === ownerId) : undefined;
  const team = people.filter((p) => p.discordId !== ownerId);
  const lines = [
    self
      ? `【你的身分】你是 ${self.botName}（Discord ID ${selfId}）${self.ownerName ? `，${self.ownerName} 的 Bot` : ''}${self.role ? `，角色：${roleName(self.role)}` : ''}。`
      : `【你的身分】你是 Discord ID ${selfId} 的 Bot（不在名冊中）。`,
  ];
  if (ownerId) lines.push(`【你的主人】${owner ? `${owner.name}，` : ''}Discord ID ${ownerId}；你現在就是在和主人私訊。`);
  if (others.length || team.length) {
    lines.push('【團隊】（名冊，讓你知道團隊有誰）');
    for (const b of others) {
      const details = botDetails(b);
      lines.push(`- Bot ${b.botName}${details ? `：${details}` : ''}`);
    }
    for (const p of team) {
      const details = [p.role ? `角色 ${roleName(p.role)}` : '', p.bots.length ? `Bot：${p.bots.join('、')}` : ''].filter(Boolean).join('，');
      lines.push(`- ${p.name}${details ? `：${details}` : ''}`);
    }
  }
  lines.push(
    '【私訊守則】',
    '- 這是你和主人的一對一私訊，別人看不到，也收不到通知。',
    '- 不要 @ 任何人或任何 Bot；需要別人協助時，告訴主人該找誰，由主人決定。',
  );
  return lines.join('\n');
}
