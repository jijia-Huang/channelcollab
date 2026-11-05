/**
 * A live session per thread: one query() fed by streaming input and kept
 * running between turns. Each turn pushes one user message and ends at the
 * `result` message. Claude speaks only through the in-process `reply` tool;
 * everything else is collected for the details view.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DATA_DIR, INBOX_DIR, loadConfig, type ResolvedChannel } from '../config.js';
import { brief, log } from '../log.js';
import { botOwner, rosterPrompt } from '../roster.js';
import { forbiddenPath, forbiddenUse, zoneDenyMessage, type Zones } from '../security/zones.js';
import { killTree, launcherOptions, type Spawned } from './launcher.js';
import { blockedByClassifier, decideTool, inside, retryKey } from './policy.js';
import { contextFromUsage, recordRateLimit, type RateInfo } from './usage.js';
import { skillCatalog, type OfferedCommand } from './skills.js';
import { limitLabel, TIMEOUT_TOOL_MESSAGE, timeoutWarning, TurnClock } from './turn-clock.js';
import { rememberSkills } from '../store/state.js';

const OWN_PREFIX = 'mcp__channelcollab__';
export const REPLY_TOOL = `${OWN_PREFIX}reply`;
/** A graceful close of a session that is still working waits this long for the turn (then kills). */
const BUSY_CLOSE_WAIT_MS = 10 * 60 * 1000;
/** After the turn time limit: how long the interrupted turn gets to end before the session is killed. */
const INTERRUPT_GRACE_MS = 30 * 1000;
/** After stdin EOF, how long the CLI gets to exit on its own before it is killed. */
const CLOSE_GRACE_MS = 15 * 1000;
/** Files Claude can attach to one reply (Discord's limit per message). */
const MAX_REPLY_FILES = 10;

export type ConversationKind = 'thread' | 'dm';

export function guidelines(selfId: string, auto: boolean, kind: ConversationKind = 'thread'): string {
  let configured: string | undefined;
  try {
    configured = loadConfig().discord.owner_id;
  } catch {}
  const dm = kind === 'dm';
  const where = dm ? '私訊' : '討論串';
  return [
    dm
      ? '你正在 Discord 私訊裡和你的主人一對一對話（主人可能在手機上，遠端請你在這台電腦上做事）。每則使用者訊息會標示發話者與位置。'
      : '你正在一個 Discord 討論串裡和人協作，討論串裡可能還有其他人的 Bot。每則使用者訊息會標示發話者、位置和最近的對話。',
    `- 你的一般文字輸出沒有人看得到；要讓人看到的內容，一律呼叫 ${REPLY_TOOL} 工具。`,
    dm ? '- 回覆要簡短，只講結論（主人多半在手機上看）；做了修改就說明改了什麼。' : '- 回覆要簡短，只講結論；做了修改就說明改了什麼。',
    auto
      ? `- 這個${dm ? '私訊' : '頻道'}用自動模式：動作由 Claude Code 自動判斷；被自動模式擋下的動作會改在 Discord 上請 Bot 的主人決定，等待期間不必另外說明。之後若被告知可以重試這個呼叫，代表主人已經回覆：請用完全相同的參數重試一次（不要改指令）；若結果是主人拒絕，照拒絕理由調整做法，不要再試。`
      : '- 需要權限的工具會在 Discord 上請 Bot 的主人核准，等待期間不必另外說明。被拒絕時照拒絕理由調整做法，不要原樣重試。',
    '- 權限請求的結果若是「主人暫時不在…已排入待核准清單」：不要重試同一個動作；改用不需要權限的方式把能做的做完，做不到的部分在 reply 裡整理成「待主人核准」（要做什麼、為什麼），然後結束這一輪。主人核准後會再告訴你，到時用相同參數執行。',
    '- 被「禁區」擋下的動作（channelcollab 的資料夾、.ssh、.env、Claude 的登入資料）任何情況都不能做，不要再試，也不要換方法繞過。',
    '- 需要使用者做選擇時，可以用 AskUserQuestion 工具，選項會以按鈕或選單呈現在 Discord 上。',
    dm
      ? '- 需要主人好好思考的決策（例如方向、取捨、影響範圍大的改動），直接在 reply 裡問主人，不要自己決定。'
      : '- 需要主人好好思考的決策（例如方向、取捨、影響範圍大的改動），在 reply 裡 @ 主人，請主人決定，不要自己決定。',
    '- 使用者附的檔案會下載到本機，路徑寫在訊息的【附件】裡，用 Read 讀取。',
    `- 要把檔案傳到${where}，呼叫 ${REPLY_TOOL} 時在 files 帶本機路徑（只能是工作目錄或附件資料夾底下的檔案）。`,
    rosterPrompt(selfId, botOwner(configured, selfId), undefined, { dm }),
  ].join('\n');
}

/** The deny reason Claude sees for a call refused by the current permission mode. */
export function modeDenyMessage(mode: PermissionMode, toolName: string): string {
  if (mode === 'plan') return `目前是計畫模式（主人打了 !plan）：只討論、不動手，不能執行 ${toolName}。請用 reply 把你的計畫說明給主人，等主人再打一次 !plan 切回後再動手。`;
  return `這個頻道的權限模式（${mode}）不允許執行 ${toolName}。`;
}

export type ToolUse = { name: string; input: string };

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Set when auto mode's classifier blocked the call: its reason (may be empty). */
  blockedReason?: string;
  /** Aborted when the turn is stopped or the session closes; the prompt should then go away. */
  signal: AbortSignal;
};

/** `always`: allow, and stop asking for this tool for the rest of the session. */
/** `deferred`: nobody answered in time; the call went on the approve-later list (runner/approvals.ts). */
export type PermissionAnswer = { behavior: 'allow' | 'always' } | { behavior: 'deny'; message: string; deferred?: boolean };

export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

export type TurnCallbacks = {
  sendReply: (text: string, files: string[]) => Promise<void>;
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>;
  /** Answers keyed by question text (multi-select joined with ", "), or undefined when nobody answered. */
  askQuestion: (questions: Question[], signal: AbortSignal) => Promise<Record<string, string> | undefined>;
  /** A short notice for the people in the conversation (e.g. plan usage reminders). */
  notice?: (text: string) => Promise<void>;
};

export type TurnResult = {
  ok: boolean;
  subtype: string;
  sessionId?: string;
  model?: string;
  costTotal: number;
  turnCost: number;
  numTurns: number;
  durationMs: number;
  tools: ToolUse[];
  replies: number;
  lastText: string;
  denials: string[];
  /** Who pressed 🛑, when the turn was stopped. */
  stoppedBy?: string;
  /** The turn hit its working-time limit (turn_timeout_minutes) and was stopped by the bot. */
  timedOut?: boolean;
  error?: string;
  /** SDKAssistantMessageError from the last assistant message that carried one (e.g. authentication_failed). */
  apiError?: string;
};

type Turn = TurnCallbacks & {
  apiError?: string;
  n: number;
  started: number;
  acted: boolean;
  tools: ToolUse[];
  denials: string[];
  replies: number;
  lastText: string;
  /** The optional working-time limit; it stops while a prompt waits for someone. */
  clock: TurnClock;
  /** The limit hit: replies and tools are refused from then on, the bot posts the notice itself. */
  timedOut?: boolean;
  /** Kills the session when the interrupted turn does not end in time. */
  killTimer?: NodeJS.Timeout;
  waits: number;
  /** Cancels prompts still waiting when the turn is stopped or the session ends. */
  abort: AbortController;
  /** auto mode: the owner's answer to a classifier block, waiting for Claude's retry of that call (retryKey). */
  retries: Map<string, { allow: true } | { deny: string }>;
  stoppedBy?: string;
  resolve: (r: TurnResult) => void;
};

type Result = Extract<SDKMessage, { type: 'result' }>;

/**
 * Set by a running Claude Code session for the processes it starts. When the
 * bot itself is started from inside a session, these would make the child think
 * it is nested in (or talking to) that session. Everything else is kept,
 * including user configuration such as CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK,
 * CLAUDE_CODE_GIT_BASH_PATH or CLAUDE_CODE_OAUTH_TOKEN.
 */
const SESSION_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_AGENT_SDK_VERSION',
]);

/** Child environment: drop a parent session's markers and any API key (the owner's claude.ai login is used). */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    if (SESSION_ENV.has(k.toUpperCase()) || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
    env[k] = v;
  }
  return env;
}

/** Check files Claude asked to attach: they must exist and resolve (symlinks included) inside `roots`. */
function checkFiles(files: string[], roots: string[], zones: Zones): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const realRoots = roots.filter((r) => existsSync(r)).map((r) => realpathSync(r));
  for (const f of files) {
    try {
      const real = realpathSync(path.resolve(roots[0], f));
      const zone = forbiddenPath(real, roots[0], zones);
      if (zone) rejected.push(`${f}: no-go zone (${zone})`);
      else if (!inside(real, realRoots)) rejected.push(`${f}: not under the working directory or the attachment folder`);
      else if (!statSync(real).isFile()) rejected.push(`${f}: not a file`);
      else ok.push(real);
    } catch {
      rejected.push(`${f}: not found`);
    }
  }
  if (ok.length > MAX_REPLY_FILES) rejected.push(...ok.splice(MAX_REPLY_FILES).map((f) => `${f}: at most ${MAX_REPLY_FILES} files per message`));
  return { ok, rejected };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export class LiveSession {
  sessionId?: string;
  model?: string;
  /** When the last turn ended (or the session started); drives idle close and eviction. */
  lastActivity = Date.now();
  /** Resolves when the reader loop has finished, i.e. the CLI has exited. */
  readonly done: Promise<void>;
  /** Tools the owner chose "always allow" for; seeded from the thread state so a resume keeps them. */
  readonly alwaysAllowed: Set<string>;

  private readonly tag: string;
  private readonly q: Query;
  private readonly abort = new AbortController();
  private readonly inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private inputEnded = false;
  private exited = false;
  private closing?: Promise<void>;
  private turn?: Turn;
  private turns = 0;
  private cost: number;
  private failure?: string;
  private forced = false;
  private clean = false;
  private child?: Spawned;
  private readonly stderrTail: string[] = [];
  /** Usage of the last main-thread API call, and the context window from the last result (fallback for contextUsage). */
  private lastUsage?: Parameters<typeof contextFromUsage>[0];
  private contextWindow?: number;

  /** Permission mode in effect now (!plan switches it); the hooks read this. */
  mode: PermissionMode;
  /** When this process was started (for !status). */
  readonly startedAt = Date.now();
  readonly cwd: string;
  /** Working time per turn before it is stopped; 0 = no limit. */
  readonly turnTimeoutMs: number;

  /**
   * `costBase` is the cumulative total a resumed CLI starts counting from: what
   * it saved on its last clean exit (0 when new). A CLI that was killed does not
   * save, so its later turns are not part of the base.
   */
  constructor(
    readonly threadId: string,
    /** This bot's Discord user ID; picks its identity from the roster. */
    selfId: string,
    channel: ResolvedChannel,
    resume: string | undefined,
    costBase: number,
    alwaysAllowed: Iterable<string> = [],
    readonly kind: ConversationKind = 'thread',
  ) {
    this.tag = `live ${threadId}`;
    this.sessionId = resume;
    this.cost = costBase;
    this.alwaysAllowed = new Set(alwaysAllowed);
    this.mode = channel.permissionMode;
    this.cwd = channel.cwd;
    this.turnTimeoutMs = channel.turnTimeoutMs;
    // The session reads freely, and in acceptEdits edits, inside its cwd and its thread's attachment folder.
    const roots = [channel.cwd, path.join(INBOX_DIR, threadId)];
    // No-go zones: every channelcollab HOME except this conversation's own attachment folder.
    const zones: Zones = { homes: [DATA_DIR], allow: [roots[1]] };

    // Created once per session, so the tool and the permission callbacks act on whichever turn is current.
    const server = createSdkMcpServer({
      name: 'channelcollab',
      version: '0.1.0',
      alwaysLoad: true,
      tools: [
        tool(
          'reply',
          `Send a message to ${kind === 'dm' ? 'your owner in the current Discord direct message' : 'the people in the current Discord thread'}. This is the only way anyone sees what you say. Optionally attach local files (under the working directory or the attachment folder).`,
          {
            text: z.string().describe('Message text (Markdown)'),
            files: z.array(z.string()).optional().describe('Local file paths to upload with the message'),
          },
          async ({ text, files }) => {
            const t = this.turn;
            const checked = checkFiles(files ?? [], roots, zones);
            log('reply', `${threadId} ${brief(text, 300)}${files?.length ? ` files=${JSON.stringify(checked.ok)} rejected=${JSON.stringify(checked.rejected)}` : ''}`);
            if (!t) return { content: [{ type: 'text', text: 'Not delivered: no active turn.' }], isError: true };
            // After the time limit the bot reports the stop itself; a last word from Claude could mislead.
            if (t.timedOut) return { content: [{ type: 'text', text: `Not delivered. ${TIMEOUT_TOOL_MESSAGE}` }], isError: true };
            try {
              await t.sendReply(text, checked.ok);
            } catch (e) {
              log('reply', `${threadId} send failed: ${(e as Error).message}`);
              return { content: [{ type: 'text', text: `Not delivered: ${(e as Error).message}` }], isError: true };
            }
            t.replies++;
            const note = checked.rejected.length ? ` Not attached: ${checked.rejected.join('; ')}` : '';
            return { content: [{ type: 'text', text: `Delivered${checked.ok.length ? ` with ${checked.ok.length} file(s)` : ''}.${note}` }] };
          },
        ),
      ],
    });

    // Permission flow (PLAN §8). The hook sees every tool call, even ones a user
    // settings allow rule would pass without consulting canUseTool (spike/phase2-check.ts).
    const preToolUse: HookCallback = async (hookInput, toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const name = hookInput.tool_name;
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      // Past the turn's time limit nothing more runs (and the refusal must not read like a permission block).
      if (this.turn?.timedOut) {
        log('permission', `${threadId} deny ${name} (turn timeout) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TIMEOUT_TOOL_MESSAGE } };
      }
      // No-go zones come first: no mode, "always allow" or owner's answer opens them.
      const zone = forbiddenUse(name, toolInput, channel.cwd, zones, OWN_PREFIX);
      if (zone) {
        this.turn?.denials.push(name);
        log('permission', `${threadId} deny ${name} (no-go zone: ${zone}) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: zoneDenyMessage(zone) } };
      }
      // auto mode: Claude retrying a call the classifier blocked and the owner has answered.
      const retry = this.turn?.retries.get(retryKey(name, toolInput));
      if (retry) {
        this.turn?.retries.delete(retryKey(name, toolInput));
        log('permission', `${threadId} retry ${'deny' in retry ? 'deny' : 'allow'} ${name} (owner answered: classifier block or approve-later) id=${toolUseId ?? '-'}`);
        return 'deny' in retry
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: retry.deny } }
          : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'approved by the owner after an auto mode block' } };
      }
      const d = decideTool(name, toolInput, { mode: this.mode, roots, alwaysAllowed: this.alwaysAllowed, ownPrefix: OWN_PREFIX });
      if (d.kind === 'cli') return {};
      if (d.kind === 'allow') {
        if (!name.startsWith(OWN_PREFIX)) log('permission', `${threadId} auto-allow ${name} (${d.why}) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: d.why } };
      }
      if (d.kind === 'deny') {
        this.turn?.denials.push(name);
        log('permission', `${threadId} deny ${name} (${d.why}) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: modeDenyMessage(this.mode, name) } };
      }
      const answer = await this.ask(name, toolInput, toolUseId ?? '', signal);
      return answer.behavior === 'deny'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.message } }
        : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'approved by the owner' } };
    };

    // auto mode (PLAN §8): the classifier blocked a call. canUseTool is not consulted for
    // that; this hook runs before Claude sees the refusal, so it can wait for the owner.
    // Its output can only say "retry", so the answer is applied when Claude retries the
    // same call: PreToolUse then allows it (skipping the classifier) or denies it with
    // the owner's reason (spike/auto-check.ts).
    const permissionDenied: HookCallback = async (hookInput, toolUseId, { signal }) => {
      if (hookInput.hook_event_name !== 'PermissionDenied') return {};
      const t = this.turn;
      if (!t || blockedByClassifier(this.mode) !== 'ask') return {};
      const name = hookInput.tool_name;
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      log('permission', `${threadId} classifier blocked ${name} (${brief(hookInput.reason, 200)}) id=${toolUseId ?? hookInput.tool_use_id}`);
      const answer = await this.ask(name, toolInput, toolUseId ?? hookInput.tool_use_id, signal, hookInput.reason ?? '');
      // Stopped turn: nothing to retry.
      if (t.stoppedBy || this.turn !== t) return {};
      t.retries.set(retryKey(name, toolInput), answer.behavior === 'deny' ? { deny: answer.message } : { allow: true });
      return { hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } };
    };

    // Reached by AskUserQuestion (the hook leaves it alone) and by anything Claude Code itself still wants to ask about.
    const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
      // Plan mode sends even our own reply tool here (a hook allow does not cover it; spike/v015-live.ts).
      if (toolName.startsWith(OWN_PREFIX)) return { behavior: 'allow', updatedInput: input };
      if (toolName !== 'AskUserQuestion') {
        const answer = await this.ask(toolName, input, toolUseID, signal);
        return answer.behavior === 'deny' ? { behavior: 'deny', message: answer.message } : { behavior: 'allow', updatedInput: input };
      }
      const t = this.turn;
      if (!t) return { behavior: 'deny', message: 'No active turn.' };
      const questions = (input.questions ?? []) as Question[];
      log('question', `${threadId} ask ${questions.length} question(s) id=${toolUseID} ${brief(questions.map((q) => q.question))}`);
      const answers = await this.waitFor(() => t.askQuestion(questions, this.linked(signal, t)));
      if (!answers) {
        log('question', `${threadId} unanswered id=${toolUseID}`);
        return { behavior: 'deny', message: t.stoppedBy ? '使用者停止了這一輪。' : '沒有人在時限內回答這個問題。' };
      }
      log('question', `${threadId} answered id=${toolUseID} ${brief(answers)}`);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    };

    const onStderr = (d: string) => {
      this.stderrTail.push(d);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    };
    const onSpawn = (child: Spawned) => {
      this.child = child;
      log(this.tag, `spawned pid=${child.pid}`);
    };

    const hookTimeout = Math.ceil(channel.permissionTimeoutMs / 1000) + 60;
    log(this.tag, `start kind=${kind} cwd=${channel.cwd} model=${channel.model ?? '-'} mode=${channel.permissionMode} launcher=${channel.launcher || 'builtin'} resume=${resume ?? '-'} turn_limit=${limitLabel(this.turnTimeoutMs)} max_turns=${channel.maxTurns || 'none'} always=${JSON.stringify([...this.alwaysAllowed])}`);
    this.q = query({
      prompt: this.input(),
      options: {
        cwd: channel.cwd,
        ...launcherOptions(channel.launcher, onStderr, onSpawn),
        env: childEnv(),
        ...(channel.model ? { model: channel.model } : {}),
        ...(channel.tools ? { tools: channel.tools } : {}),
        settingSources: ['user', 'project'],
        // Always explicit: omitted, the user's own default (e.g. auto) applies and canUseTool is skipped.
        permissionMode: channel.permissionMode,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: guidelines(selfId, (channel.basePermissionMode ?? channel.permissionMode) === 'auto', kind) },
        allowedTools: [REPLY_TOOL],
        mcpServers: { channelcollab: server },
        // The hooks await the owner's answer in-process, so their timeout (seconds) must outlast the prompt's.
        // PermissionDenied is always registered: !plan can switch an auto session out of auto and back.
        hooks: {
          PreToolUse: [{ hooks: [preToolUse], timeout: hookTimeout }],
          PermissionDenied: [{ hooks: [permissionDenied], timeout: hookTimeout }],
        },
        canUseTool,
        // max_turns (counted per user message in streaming mode, spike/live-check.ts): off by default, so not sent.
        ...(channel.maxTurns > 0 ? { maxTurns: channel.maxTurns } : {}),
        abortController: this.abort,
        stderr: onStderr,
        ...(resume ? { resume } : {}),
      },
    });
    this.done = this.read();
  }

  /** A turn is running. */
  get busy(): boolean {
    return !!this.turn;
  }

  /** Can take another turn: not closing and not exited. */
  get usable(): boolean {
    return !this.inputEnded && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Switch the model for the following responses (!model); the session keeps running. */
  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
    log(this.tag, `model set to ${model}`);
  }

  /** Switch the permission mode (!plan); the hooks follow it right away. */
  async setMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
    log(this.tag, `permission mode set to ${mode}`);
  }

  /**
   * How full the context window is after the last turn: Claude Code's own
   * figure (getContextUsage, the /context numbers), else the last API call's
   * tokens over the model's context window.
   */
  async contextUsage(): Promise<{ pct: number; tokens?: number; max?: number } | undefined> {
    if (this.usable) {
      try {
        const u = await Promise.race([this.q.getContextUsage({ detail: 'summary' }), sleep(5000).then(() => undefined)]);
        if (u && Number.isFinite(u.percentage)) return { pct: Math.round(u.percentage), tokens: u.totalTokens, max: u.maxTokens };
      } catch (e) {
        log(this.tag, `getContextUsage failed: ${(e as Error).message}`);
      }
    }
    return contextFromUsage(this.lastUsage, this.contextWindow);
  }

  /** Cumulative total_cost_usd as of the last result. */
  get costTotal(): number {
    return this.cost;
  }

  /** The CLI exited on its own after stdin closed, so it saved its cost total for the next resume. */
  get cleanExit(): boolean {
    return this.clean;
  }

  /** Run one turn. Never rejects: failures come back as `ok: false`. One turn at a time. */
  run(prompt: string, callbacks: TurnCallbacks, opts: { preapproved?: string[] } = {}): Promise<TurnResult> {
    if (this.turn) throw new Error(`${this.tag}: a turn is already running`);
    const n = ++this.turns;
    return new Promise<TurnResult>((resolve) => {
      const t: Turn = {
        ...callbacks,
        n,
        started: Date.now(),
        acted: false,
        tools: [],
        denials: [],
        replies: 0,
        lastText: '',
        clock: undefined as unknown as TurnClock,
        waits: 0,
        abort: new AbortController(),
        retries: new Map(),
        resolve,
      };
      t.clock = new TurnClock(
        this.turnTimeoutMs,
        () => this.onTimeout(t),
        () => {
          log(this.tag, `turn ${n} close to the time limit (${limitLabel(this.turnTimeoutMs)})`);
          t.notice?.(timeoutWarning(this.turnTimeoutMs, t.clock.left)).catch((e) => log(this.tag, `time limit warning failed: ${(e as Error).message}`));
        },
      );
      // Calls the owner approved later (retryKey): allowed in this turn when repeated with the same input.
      for (const k of opts.preapproved ?? []) t.retries.set(k, { allow: true });
      this.turn = t;
      t.clock.resume();
      if (!this.usable) {
        this.finishTurn(undefined, 'session is closed');
        return;
      }
      log(this.tag, `turn ${n} push pid=${this.pid ?? '(starting)'} session=${this.sessionId ?? '-'} chars=${prompt.length}`);
      this.inbox.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
      this.wake?.();
    });
  }

  /**
   * Stop the running turn (🛑) without ending the session: waiting prompts are
   * cancelled and the CLI is interrupted. The turn ends with subtype
   * `interrupted`, and the next message continues the same session
   * (spike/phase2-check.ts).
   */
  async interrupt(by: string): Promise<boolean> {
    const t = this.turn;
    if (!t || t.stoppedBy || !this.usable) return false;
    t.stoppedBy = by;
    log(this.tag, `turn ${t.n} interrupt by ${by} pid=${this.pid ?? '-'}`);
    t.abort.abort();
    try {
      const r = await this.q.interrupt();
      log(this.tag, `turn ${t.n} interrupt acknowledged ${brief(r)}`);
    } catch (e) {
      log(this.tag, `turn ${t.n} interrupt failed: ${(e as Error).message}`);
    }
    return true;
  }

  /**
   * End the session. Graceful by default: close stdin and let the CLI exit
   * (a running turn finishes first). `force` kills right away and fails the
   * running turn. Either way the process tree is gone when this resolves.
   */
  close(reason: string, force = false): Promise<void> {
    if (force && !this.exited) {
      log(this.tag, `close (${reason}) force pid=${this.pid ?? '-'} busy=${this.busy}`);
      this.failure ??= reason;
      this.forced = true;
      this.inputEnded = true;
      this.turn?.abort.abort();
      this.q.close();
    }
    this.closing ??= (async () => {
      if (!force) log(this.tag, `close (${reason}) pid=${this.pid ?? '-'} busy=${this.busy}`);
      this.inputEnded = true;
      this.wake?.();
      const limit = CLOSE_GRACE_MS + (this.busy ? BUSY_CLOSE_WAIT_MS : 0);
      const exited = await Promise.race([this.done.then(() => true), sleep(limit).then(() => false)]);
      if (!exited) {
        log(this.tag, `close (${reason}) still running after ${limit} ms, killing`);
        this.forced = true;
        this.turn?.abort.abort();
        this.q.close();
        await Promise.race([this.done, sleep(5000)]);
      }
      if (this.child) await killTree(this.child);
      log(this.tag, `closed (${reason}) pid=${this.pid ?? '-'} turns=${this.turns}`);
    })();
    return this.closing;
  }

  /** Ask the owner about a tool call; the turn clock stops while waiting. */
  private async ask(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal, blockedReason?: string): Promise<PermissionAnswer> {
    const t = this.turn;
    if (!t) return { behavior: 'deny', message: 'No active turn.' };
    log('permission', `${this.threadId} ask ${toolName} id=${toolUseId}${blockedReason !== undefined ? ' (auto mode block)' : ''} ${brief(input)}`);
    const answer = await this.waitFor(() => t.askPermission({ toolName, input, toolUseId, blockedReason, signal: this.linked(signal, t) }));
    log('permission', `${this.threadId} ${answer.behavior} ${toolName} id=${toolUseId}${answer.behavior === 'deny' ? ` ${brief(answer.message, 200)}` : ''}`);
    if (answer.behavior === 'deny') t.denials.push(toolName);
    if (answer.behavior === 'always') this.alwaysAllowed.add(toolName);
    return answer;
  }

  /** One signal for "the SDK gave up on this call" or "the turn was stopped". */
  private linked(signal: AbortSignal, t: Turn): AbortSignal {
    return AbortSignal.any([signal, t.abort.signal]);
  }

  /** Wait for a person with the turn clock paused (prompts may run in parallel). */
  private async waitFor<T>(wait: () => Promise<T>): Promise<T> {
    const t = this.turn;
    if (t && t.waits++ === 0) t.clock.pause();
    try {
      return await wait();
    } finally {
      if (t && --t.waits === 0 && this.turn === t) t.clock.resume();
    }
  }

  /**
   * The turn used up its working time (turn_timeout_minutes; off by default).
   * Interrupt it like 🛑 so the session stays and "繼續" picks it up; from now
   * on replies and tools are refused, and the bot posts the notice itself.
   * Only if the turn does not end soon is the session killed.
   */
  private onTimeout(t: Turn): void {
    if (this.turn !== t) return;
    t.timedOut = true;
    log(this.tag, `turn ${t.n} timeout: ${limitLabel(this.turnTimeoutMs)} of work used, interrupting the turn`);
    t.abort.abort();
    this.q.interrupt().catch((e) => log(this.tag, `turn ${t.n} timeout interrupt failed: ${(e as Error).message}`));
    t.killTimer = setTimeout(() => {
      if (this.turn !== t) return;
      log(this.tag, `turn ${t.n} timeout: still running ${INTERRUPT_GRACE_MS} ms after the interrupt, killing the session`);
      this.failure = 'timeout';
      this.forced = true;
      this.abort.abort();
    }, INTERRUPT_GRACE_MS);
    t.killTimer.unref?.();
  }

  /** Streaming input: yields queued user messages; returning closes stdin and ends the session. */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.inputEnded) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }

  private async read(): Promise<void> {
    const started = Date.now();
    let error: string | undefined;
    try {
      for await (const msg of this.q) this.onMessage(msg, started);
    } catch (e) {
      error = (e as Error).message;
      // Killed by us after the time limit: say so instead of the SDK's "aborted by user".
      if (this.failure === 'timeout') error = `timeout (killed after ${limitLabel(this.turnTimeoutMs)} of work; SDK: ${error})`;
      log(this.tag, `error ${error}`);
      if (this.stderrTail.length) log(this.tag, `stderr tail: ${this.stderrTail.join('').slice(-1500)}`);
    }
    this.exited = true;
    this.clean = !error && !this.forced;
    this.inputEnded = true;
    this.wake?.();
    log(this.tag, `ended pid=${this.pid ?? '-'} after ${Date.now() - started} ms turns=${this.turns} clean=${this.clean} cost_total=${this.cost.toFixed(4)}${error ? ` error=${brief(error, 200)}` : ''}`);
    if (this.turn) this.finishTurn(undefined, error ?? this.failure ?? 'session ended unexpectedly');
  }

  private onMessage(msg: SDKMessage, started: number): void {
    const t = this.turn;
    if (msg.type === 'system' && msg.subtype === 'init') {
      // Streaming input repeats init at the start of every turn; only the first one marks startup.
      if (!this.model) {
        const cc = msg.mcp_servers.find((s) => s.name === 'channelcollab');
        log(this.tag, `init after ${Date.now() - started} ms pid=${this.pid ?? '-'} session=${msg.session_id} model=${msg.model} mode=${msg.permissionMode} apiKeySource=${msg.apiKeySource} cc_version=${msg.claude_code_version} channelcollab=${cc?.status} replyListed=${msg.tools.includes(REPLY_TOOL)} skills=${msg.skills.length} plugins=${msg.plugins.length}`);
        this.offered = { skills: msg.skills, terminal: msg.terminal_slash_commands ?? [] };
        // The command list carries the built-in marker the init message lacks; without it, only the skills.
        this.q
          .supportedCommands()
          .then((list) => this.recordSkills(list))
          .catch((e) => {
            log(this.tag, `supportedCommands failed (${(e as Error).message}); /skill lists the init skills only`);
            this.recordSkills([]);
          });
      }
      this.sessionId = msg.session_id;
      this.model = msg.model;
    } else if (msg.type === 'system' && msg.subtype === 'commands_changed') {
      this.recordSkills(msg.commands);
    } else if (msg.type === 'rate_limit_event') {
      const info = msg.rate_limit_info as RateInfo;
      log(this.tag, `rate limit ${brief(info, 400)}`);
      for (const text of recordRateLimit(info)) {
        if (t?.notice) t.notice(text).catch((e) => log(this.tag, `rate limit notice failed: ${(e as Error).message}`));
        else log(this.tag, `rate limit notice (no turn to post it): ${text}`);
      }
    } else if (msg.type === 'assistant' && t) {
      if (msg.error) t.apiError = msg.error;
      if (msg.parent_tool_use_id === null && msg.message.usage) this.lastUsage = msg.message.usage;
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          if (!t.acted) {
            t.acted = true;
            log(this.tag, `turn ${t.n} first action after ${Date.now() - t.started} ms pid=${this.pid ?? '-'}`);
          }
          t.tools.push({ name: block.name, input: brief(block.input, 160) });
          log('tool_use', `${this.threadId} ${block.name} ${brief(block.input)}`);
        } else if (block.type === 'text' && block.text.trim()) {
          t.lastText = block.text;
        }
      }
    } else if (msg.type === 'result') {
      this.finishTurn(msg);
    }
  }

  /** What the init message said about skills; the /skill list is built from it and the command list. */
  private offered: { skills: string[]; terminal: string[] } = { skills: [], terminal: [] };

  /** Keep the /skill list for this folder (state.json), for autocomplete before the next session starts. */
  private recordSkills(list: OfferedCommand[]): void {
    const items = skillCatalog(list, this.offered.skills, this.offered.terminal);
    rememberSkills(this.cwd, items);
    log(this.tag, `skills for /skill: ${items.length} (${brief(items.map((s) => s.name).join(' '), 200)})`);
  }

  private finishTurn(result: Result | undefined, error?: string): void {
    const t = this.turn;
    if (!t) {
      if (result) log(this.tag, `result without a turn: ${result.subtype}`);
      return;
    }
    this.turn = undefined;
    t.clock.stop();
    clearTimeout(t.killTimer);
    t.abort.abort();
    this.lastActivity = Date.now();

    // total_cost_usd is cumulative for the query, and a resumed query starts from
    // the total saved on the last clean exit (the base); a smaller value means
    // the total was reset.
    const costTotal = result ? result.total_cost_usd : this.cost;
    const turnCost = costTotal >= this.cost ? costTotal - this.cost : costTotal;
    this.cost = costTotal;
    if (result?.session_id) this.sessionId = result.session_id;
    const windowOf = result?.modelUsage && this.model ? result.modelUsage[this.model]?.contextWindow : undefined;
    if (windowOf) this.contextWindow = windowOf;
    // A failed result says why in `result` (subtype success with is_error, e.g. not logged in) or in `errors`.
    if (result?.is_error && !error) {
      error = result.subtype === 'success' ? result.result : result.errors?.join('\n');
    }

    const out: TurnResult = {
      ok: !t.timedOut && !!result && result.subtype === 'success' && !result.is_error,
      // An interrupted turn ends as error_during_execution; report it as what it was.
      subtype: t.timedOut ? 'timeout' : t.stoppedBy && result ? 'interrupted' : (result?.subtype ?? this.failure ?? 'error'),
      sessionId: this.sessionId,
      model: this.model,
      costTotal,
      turnCost,
      numTurns: result?.num_turns ?? 0,
      durationMs: Date.now() - t.started,
      tools: t.tools,
      replies: t.replies,
      lastText: result?.subtype === 'success' && result.result.trim() ? result.result : t.lastText,
      denials: t.denials,
      stoppedBy: t.stoppedBy,
      timedOut: t.timedOut,
      error,
      apiError: t.apiError,
    };
    log('result', `${this.threadId} turn=${t.n} pid=${this.pid ?? '-'} ok=${out.ok} subtype=${out.subtype} session=${out.sessionId} turns=${out.numTurns} replies=${out.replies} tools=${out.tools.length} denials=${JSON.stringify(out.denials)}${out.stoppedBy ? ` stopped_by=${out.stoppedBy}` : ''}${out.timedOut ? ' timeout=true' : ''} turn_cost_usd=${turnCost.toFixed(4)} total_cost_usd=${costTotal.toFixed(4)} duration_ms=${out.durationMs}`);
    t.resolve(out);
  }
}
