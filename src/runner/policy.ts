/**
 * Which tool calls need the owner's approval (PLAN §8), and who may answer
 * each kind of prompt. Pure functions: no Discord, no SDK, so they can be
 * checked on their own (spike/authz-check.ts).
 */
import path from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** Built-in tools that only read, or only touch the session's own bookkeeping. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'Skill']);
/** Tools that take their target as file_path / notebook_path and only write files. */
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Read-only tools whose target is a path; auto-allowed only inside the session's own folders. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

/** `allow`: run without asking. `ask`: the owner decides. `deny`: refused outright. `cli`: leave it to Claude Code. */
export type ToolDecision = { kind: 'allow' | 'ask' | 'deny' | 'cli'; why: string };

export type ToolContext = {
  mode: PermissionMode;
  /** Folders the session may read freely and (in acceptEdits) edit: its cwd and its inbox. */
  roots: string[];
  /** Tools the owner chose "always allow" for in this session. */
  alwaysAllowed: ReadonlySet<string>;
  /** The bot's own in-process MCP server prefix, e.g. mcp__channelcollab__. */
  ownPrefix: string;
};

export function inside(file: string, roots: string[]): boolean {
  const abs = path.resolve(roots[0] ?? '.', file);
  return roots.some((r) => {
    const rel = path.relative(path.resolve(r), abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function targetPath(input: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
  return undefined;
}

export function decideTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolDecision {
  // Answered by people through canUseTool; deciding it here would skip that.
  if (name === 'AskUserQuestion') return { kind: 'cli', why: 'question' };
  if (name.startsWith(ctx.ownPrefix)) return { kind: 'allow', why: 'own tool' };
  if (ctx.mode === 'auto') {
    // "Always allow" after a classifier block: the whole tool skips the classifier for the session.
    if (ctx.alwaysAllowed.has(name)) return { kind: 'allow', why: 'always allowed this session' };
    // Everything else goes to Claude Code's classifier; what it blocks reaches the owner
    // through the PermissionDenied hook (see blockedByClassifier).
    return { kind: 'cli', why: 'auto mode' };
  }
  if (READ_ONLY.has(name)) {
    const p = targetPath(input);
    // Reading outside the project (e.g. the bot's own config with its token) needs the owner.
    if (p && !inside(p, ctx.roots)) return { kind: 'ask', why: 'read outside cwd' };
    return { kind: 'allow', why: 'read-only' };
  }
  if (ctx.mode === 'plan') return { kind: 'deny', why: 'plan mode' };
  if (ctx.alwaysAllowed.has(name)) return { kind: 'allow', why: 'always allowed this session' };
  if (ctx.mode === 'acceptEdits' && EDITS.has(name)) {
    const p = targetPath(input);
    if (p && inside(p, ctx.roots)) return { kind: 'allow', why: 'acceptEdits inside cwd' };
  }
  if (ctx.mode === 'dontAsk') return { kind: 'deny', why: 'dontAsk mode' };
  return { kind: 'ask', why: 'needs approval' };
}

/**
 * post_to_channel (0.1.8): unlike reply, which only answers where the person
 * who asked is reading, a post puts text in a team channel other people read.
 * So it is not a free "own tool": when the owner asked for the turn (a direct
 * message, or the owner in a thread) the request itself is the approval;
 * anyone else (another person, another bot) needs the owner's button, as for
 * any outward action. plan mode only discusses, so it never posts; dontAsk
 * never asks, so it refuses what would need asking.
 */
export function decidePost(mode: PermissionMode, ownerTriggered: boolean): ToolDecision {
  if (mode === 'plan') return { kind: 'deny', why: 'plan mode' };
  if (ownerTriggered) return { kind: 'allow', why: 'the owner asked for this turn' };
  if (mode === 'dontAsk') return { kind: 'deny', why: 'dontAsk mode' };
  return { kind: 'ask', why: 'post requested by someone other than the owner' };
}

/**
 * auto mode: the classifier blocked a call (PermissionDenied hook). Only the
 * classifier fires that hook (deny rules do not, spike/auto-check.ts), so in
 * auto mode the block goes to the owner; in any other mode it stands.
 */
export function blockedByClassifier(mode: PermissionMode): 'ask' | 'keep' {
  return mode === 'auto' ? 'ask' : 'keep';
}

/**
 * Identifies "the same call" when Claude retries a blocked call the owner has
 * answered. `description` is Claude's own label for the call and changes
 * between attempts, so it is not part of the call.
 */
export function retryKey(name: string, input: Record<string, unknown>): string {
  const { description: _label, ...rest } = input;
  return `${name} ${JSON.stringify(rest)}`;
}

/** Prompt kinds and who may act on them (PLAN §8). */
export type PromptKind = 'permission' | 'question' | 'stop';

export function canAct(kind: PromptKind, clickerId: string, who: { ownerId?: string; requesterId?: string }): boolean {
  if (who.ownerId && clickerId === who.ownerId) return true;
  if (kind === 'permission') return false;
  return !!who.requesterId && clickerId === who.requesterId;
}
