/**
 * Discord side of the approval PIN (src/security/pin.ts): the modal that asks
 * for it and what happens after. The typed PIN only goes to PinGate.attempt;
 * it is never logged, echoed or passed to Claude.
 */
import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from 'discord.js';
import { log } from '../log.js';
import { MAX_FAILURES, pinGate } from '../security/pin.js';

export const LOCK_NOTICE = `🔒 PIN 連續輸錯 ${MAX_FAILURES} 次，已鎖定：核准權限和私訊都暫停。請在電腦上執行 channelcollab 的 unlock（或重啟 Bot）解除。`;
export const LOCKED_REPLY = '🔒 已鎖定（PIN 輸錯太多次）。請在電腦上執行 unlock 或重啟 Bot 解除。';

export function pinModal(customId: string, title: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('pin')
          .setLabel('PIN（輸入框不會遮住，注意旁人）')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(4)
          .setMaxLength(32),
      ),
    );
}

const unlockMinutes = () => Math.round((pinGate.state().unlockedUntil - Date.now()) / 60000);

/**
 * Check the PIN typed into a modal. Wrong / locked are answered here
 * (ephemeral); on success the caller answers the interaction. A lock is
 * announced once in `announce` (the channel or DM where it happened).
 */
export async function checkPin(i: ModalSubmitInteraction, announce?: (text: string) => Promise<unknown>): Promise<boolean> {
  const r = pinGate.attempt(i.fields.getTextInputValue('pin'));
  if (r.result === 'ok') {
    log('pin', `correct PIN from ${i.user.username}; no PIN needed for ${unlockMinutes()} min`);
    return true;
  }
  if (r.result === 'not-set') {
    log('pin', `no PIN set any more; ${i.user.username} passes`);
    return true;
  }
  if (r.result === 'wrong') {
    log('pin', `wrong PIN from ${i.user.username} (${r.left} tries left)`);
    await i.reply({ content: `❌ PIN 不對，還可以再試 ${r.left} 次（連續錯 ${MAX_FAILURES} 次會鎖定）。`, flags: MessageFlags.Ephemeral });
    return false;
  }
  log('pin', r.justLocked ? `wrong PIN from ${i.user.username}; locked after ${MAX_FAILURES} wrong PINs` : `attempt by ${i.user.username} while locked`);
  await i.reply({ content: r.justLocked ? LOCK_NOTICE : LOCKED_REPLY, flags: MessageFlags.Ephemeral });
  if (r.justLocked) await announce?.(LOCK_NOTICE)?.catch((e: Error) => log('pin', `lock notice failed: ${e.message}`));
  return false;
}

/** Follow-up after a correct PIN, only for the person who typed it. */
export async function pinOkFollowUp(i: ModalSubmitInteraction): Promise<void> {
  const min = unlockMinutes();
  await i.followUp({ content: `🔓 PIN 正確${min > 0 ? `，接下來約 ${min} 分鐘內核准和私訊不用再輸入` : ''}。`, flags: MessageFlags.Ephemeral }).catch(() => {});
}
