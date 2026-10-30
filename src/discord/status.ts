/**
 * Status reactions on the message that triggered a run (PLAN §7):
 * 👀 received → ⏳ queued → ⚙️ running (⏳ while a prompt waits for someone)
 * → ✅ done / ❌ failed / ⏹️ stopped.
 */
import type { Message } from 'discord.js';
import { log } from '../log.js';

export const STATUS = {
  received: '👀',
  waiting: '⏳',
  running: '⚙️',
  done: '✅',
  failed: '❌',
  stopped: '⏹️',
} as const;

export type Status = keyof typeof STATUS;

export class StatusReactions {
  private current?: string;

  constructor(private readonly message: Message) {}

  /** Swap the bot's own status reaction. Failures (e.g. missing Add Reactions) are logged, never thrown. */
  async set(status: Status): Promise<void> {
    const emoji = STATUS[status];
    if (emoji === this.current) return;
    const previous = this.current;
    this.current = emoji;
    try {
      await this.message.react(emoji);
      if (previous) {
        const me = this.message.client.user.id;
        await this.message.reactions.cache.find((r) => r.emoji.name === previous)?.users.remove(me);
      }
    } catch (e) {
      log('status', `${this.message.id} ${status} failed: ${(e as Error).message}`);
    }
  }
}
