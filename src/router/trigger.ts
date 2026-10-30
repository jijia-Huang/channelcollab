/**
 * Trigger rules (PLAN §6). Pure: the caller gathers the facts.
 *
 * - Only bound channels and threads opened under them.
 * - Main channel: only when @-mentioned; the bot then opens a thread.
 * - Thread, human message: the @-mentioned bots answer; with no bot mentioned,
 *   only the bot that opened the thread answers.
 * - Own messages are ignored; other bots only when they @ this bot explicitly.
 */
export type TriggerFacts = {
  fromSelf: boolean;
  isSystem: boolean;
  fromBot: boolean;
  /** Explicit user mention of this bot (not @everyone, not a role). */
  mentionsMe: boolean;
  /** Explicit user mention of some other bot. */
  mentionsOtherBot: boolean;
  inThread: boolean;
  /** Main channel id, or the thread's parent channel id. */
  baseChannelId: string;
  baseChannelBound: boolean;
  /** This bot created the thread (thread.ownerId). */
  openedByMe: boolean;
};

export type TriggerDecision =
  | { action: 'ignore'; reason: string }
  /** Main channel mention: open a public thread from the message. */
  | { action: 'open-thread' }
  /** Run in the current thread. */
  | { action: 'run' };

export function decide(f: TriggerFacts): TriggerDecision {
  if (f.fromSelf) return { action: 'ignore', reason: 'own-message' };
  if (f.isSystem) return { action: 'ignore', reason: 'system-message' };
  if (!f.baseChannelBound) return { action: 'ignore', reason: 'unbound-channel' };
  if (f.fromBot && !f.mentionsMe) return { action: 'ignore', reason: 'bot-without-mention' };
  if (!f.inThread) return f.mentionsMe ? { action: 'open-thread' } : { action: 'ignore', reason: 'not-mentioned' };
  if (f.mentionsMe) return { action: 'run' };
  // A human addressed other bots only: stay quiet, even in our own thread.
  if (f.mentionsOtherBot) return { action: 'ignore', reason: 'other-bot-mentioned' };
  return f.openedByMe ? { action: 'run' } : { action: 'ignore', reason: 'not-opener' };
}

/** What hop counting needs from one thread message. */
export type HopMessage = { isSystem: boolean; fromBot: boolean; mentionsBot: boolean };

/**
 * Bot-to-bot hand-offs since the last human message. `messages` runs newest
 * first and starts with the trigger. A bot message that @-mentions another bot
 * is one hop; a human message ends the count. Every bot computes this from the
 * same thread history, so they agree on the number for a given message.
 */
export function countHops<T extends HopMessage>(messages: Iterable<T>): { hops: number; human?: T } {
  let hops = 0;
  for (const m of messages) {
    if (m.isSystem) continue;
    if (!m.fromBot) return { hops, human: m };
    if (m.mentionsBot) hops++;
  }
  return { hops };
}
