/**
 * Approval PIN (PLAN §8). The owner sets it on the computer with the control
 * script (`set-pin`, typed in a console without echo); only a salted scrypt hash
 * is kept, in <HOME>\pin.json. The bot reads the file on every check, so
 * set-pin / clear-pin apply without a restart.
 *
 * A correct PIN unlocks approvals and direct messages for
 * `security.pin_unlock_minutes` (in memory: a restart locks again). Three wrong
 * PINs in a row lock both until `unlock` (over the bot's pipe) or a restart.
 * The PIN itself is never logged and never reaches Claude.
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, PIN_PATH } from '../config.js';

export const MAX_FAILURES = 3;

export type PinFile = { v: 1; algo: 'scrypt'; N: number; r: number; p: number; keylen: number; salt: string; hash: string; setAt?: string };

/** The PIN file, or undefined when no PIN is set (or the file is unusable). */
export function readPinFile(file = PIN_PATH): PinFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const f = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as PinFile;
    if (f.algo !== 'scrypt' || !f.salt || !f.hash || !(f.N > 1) || !(f.r > 0) || !(f.p > 0) || !(f.keylen >= 16)) return undefined;
    return f;
  } catch {
    return undefined;
  }
}

/** PINs are compared after trimming spaces (phone keyboards add them); same rule as set-pin. */
export const normalizePin = (pin: string) => pin.normalize('NFKC').trim();

/** Constant-time comparison of scrypt(pin) with the stored hash. */
export function verifyPin(pin: string, f: PinFile): boolean {
  const want = Buffer.from(f.hash, 'base64');
  let got: Buffer;
  try {
    got = scryptSync(normalizePin(pin), Buffer.from(f.salt, 'base64'), f.keylen, { N: f.N, r: f.r, p: f.p, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** `justLocked`: this attempt was the last allowed one (announce the lock once). */
export type Attempt = { result: 'ok' } | { result: 'wrong'; left: number } | { result: 'locked'; justLocked: boolean } | { result: 'not-set' };

/**
 * What a click on 「允許」／「一律允許」 does: someone other than the owner is
 * refused before any PIN prompt (so they can neither see it nor use up the
 * owner's tries); the owner is asked for the PIN only when one is needed.
 */
export function approvalStep(isOwner: boolean, gate: { locked: boolean; required: boolean }): 'refuse' | 'locked' | 'pin' | 'approve' {
  if (!isOwner) return 'refuse';
  if (gate.locked) return 'locked';
  return gate.required ? 'pin' : 'approve';
}

export class PinGate {
  private unlockedUntil = 0;
  private failures = 0;
  private lockedAt?: number;

  constructor(
    private readonly read: () => PinFile | undefined,
    private readonly unlockMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** A PIN has been set on this computer. */
  get configured(): boolean {
    return !!this.read();
  }

  get locked(): boolean {
    return this.lockedAt !== undefined;
  }

  /** A correct PIN was entered recently and nothing is locked. */
  get unlocked(): boolean {
    return !this.locked && this.now() < this.unlockedUntil;
  }

  /** Approving needs the PIN now: one is set and the unlock window has passed. Locked counts as needing it. */
  get required(): boolean {
    return this.configured && !this.unlocked;
  }

  attempt(pin: string): Attempt {
    if (this.locked) return { result: 'locked', justLocked: false };
    const f = this.read();
    if (!f) return { result: 'not-set' };
    if (verifyPin(pin, f)) {
      this.failures = 0;
      this.unlockedUntil = this.now() + this.unlockMs();
      return { result: 'ok' };
    }
    this.failures++;
    if (this.failures >= MAX_FAILURES) {
      this.lockedAt = this.now();
      this.unlockedUntil = 0;
      return { result: 'locked', justLocked: true };
    }
    return { result: 'wrong', left: MAX_FAILURES - this.failures };
  }

  /** `unlock` from the computer: clear the lock and the failure count (the PIN is still needed). */
  reset(): void {
    this.lockedAt = undefined;
    this.failures = 0;
  }

  state(): { configured: boolean; locked: boolean; unlockedUntil: number; failures: number } {
    return { configured: this.configured, locked: this.locked, unlockedUntil: this.unlocked ? this.unlockedUntil : 0, failures: this.failures };
  }
}

export const pinGate = new PinGate(
  () => readPinFile(),
  () => {
    try {
      return loadConfig().security.pin_unlock_minutes * 60 * 1000;
    } catch {
      return 30 * 60 * 1000;
    }
  },
);
