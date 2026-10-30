/**
 * Files people attach to a triggering message are saved to
 * <HOME>\inbox\<threadId>\ so Claude can Read them (PLAN §7). Discord CDN
 * links expire, so they are fetched right away.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Message } from 'discord.js';
import { INBOX_DIR } from '../config.js';
import { log } from '../log.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Attachment ID → local path, or why it was not saved. */
export type SavedAttachments = Map<string, { path?: string; note?: string }>;

function safeName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return base.slice(-120) || 'file';
}

export async function saveAttachments(message: Message, threadId: string): Promise<SavedAttachments> {
  const saved: SavedAttachments = new Map();
  if (!message.attachments.size) return saved;
  const dir = path.join(INBOX_DIR, threadId);
  mkdirSync(dir, { recursive: true });
  for (const a of message.attachments.values()) {
    if (a.size > MAX_ATTACHMENT_BYTES) {
      saved.set(a.id, { note: `超過 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 上限，沒有下載` });
      log('attach', `${message.id} skip ${a.name} size=${a.size}`);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error('too large');
      const file = path.join(dir, `${message.id}-${safeName(a.name)}`);
      writeFileSync(file, buf);
      saved.set(a.id, { path: file });
      log('attach', `${message.id} saved ${a.name} bytes=${buf.length} -> ${file}`);
    } catch (e) {
      saved.set(a.id, { note: `下載失敗（${(e as Error).message}）` });
      log('attach', `${message.id} download ${a.name} failed: ${(e as Error).message}`);
    }
  }
  return saved;
}
