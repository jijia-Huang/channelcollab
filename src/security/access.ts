/**
 * Who may trigger the bot (PLAN §8, `access.roster_only`, on by default): the
 * owner, people in the roster's members, owners of the roster's bots, and the
 * roster's bots themselves (so bots can hand work to each other). Pure.
 */
import type { Roster } from '../roster.js';

export function allowedTrigger(authorId: string, ownerId: string | undefined, roster: Roster): boolean {
  if (ownerId && authorId === ownerId) return true;
  if (roster.members.some((m) => m.discordId === authorId)) return true;
  return roster.bots.some((b) => b.botId === authorId || b.ownerDiscordId === authorId);
}
