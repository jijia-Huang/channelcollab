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
import { z } from 'zod';
import { INBOX_DIR, loadConfig, type ResolvedChannel } from '../config.js';
import { brief, log } from '../log.js';
import { botOwner, rosterPrompt } from '../roster.js';
import { killTree, launcherOptions, type Spawned } from './launcher.js';
import { decideTool, inside } from './policy.js';

const OWN_PREFIX = 'mcp__channelcollab__';
export const REPLY_TOOL = `${OWN_PREFIX}reply`;
/** Working time per turn; time spent waiting for someone to answer a prompt is not counted. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** Counted per user message in streaming mode, not per session (spike/live-check.ts). */
const MAX_TURNS = 40;
/** After stdin EOF, how long the CLI gets to exit on its own before it is killed. */
const CLOSE_GRACE_MS = 15 * 1000;
/** Files Claude can attach to one reply (Discord's limit per message). */
const MAX_REPLY_FILES = 10;

function guidelines(selfId: string): string {
  let configured: string | undefined;
  try {
    configured = loadConfig().discord.owner_id;
  } catch {}
  return [
    '你正在一個 Discord 討論串裡和人協作，討論串裡可能還有其他人的 Bot。每則使用者訊息會標示發話者、位置和最近的對話。',
    `- 你的一般文字輸出沒有人看得到；要讓人看到的內容，一律呼叫 ${REPLY_TOOL} 工具。`,
    '- 回覆要簡短，只講結論；做了修改就說明改了什麼。',
    '- 需要權限的工具會在 Discord 上請 Bot 的主人核准，等待期間不必另外說明。被拒絕時照拒絕理由調整做法，不要原樣重試。',
    '- 需要使用者做選擇時，可以用 AskUserQuestion 工具，選項會以按鈕或選單呈現在 Discord 上。',
    '- 改程式最多做到開 PR，絕不自行 merge。',
    '- 需要主人好好思考的決策（例如方向、取捨、影響範圍大的改動），在 reply 裡 @ 主人，請主人決定，不要自己決定。',
    '- 使用者附的檔案會下載到本機，路徑寫在訊息的【附件】裡，用 Read 讀取。',
    `- 要把檔案傳到討論串，呼叫 ${REPLY_TOOL} 時在 files 帶本機路徑（只能是工作目錄或附件資料夾底下的檔案）。`,
    rosterPrompt(selfId, botOwner(configured, selfId)),
  ].join('\n');
}

export type ToolUse = { name: string; input: string };

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Aborted when the turn is stopped or the session closes; the prompt should then go away. */
  signal: AbortSignal;
};

/** `always`: allow, and stop asking for this tool for the rest of the session. */
export type PermissionAnswer = { behavior: 'allow' | 'always' } | { behavior: 'deny'; message: string };

export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

export type TurnCallbacks = {
  sendReply: (text: string, files: string[]) => Promise<void>;
  askPermission: (req: PermissionRequest) => Promise<PermissionAnswer>;
  /** Answers keyed by question text (multi-select joined with ", "), or undefined when nobody answered. */
  askQuestion: (questions: Question[], signal: AbortSignal) => Promise<Record<string, string> | undefined>;
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
  error?: string;
};

type Turn = TurnCallbacks & {
  n: number;
  started: number;
  acted: boolean;
  tools: ToolUse[];
  denials: string[];
  replies: number;
  lastText: string;
  timer?: NodeJS.Timeout;
  /** Working time left before the turn times out; the clock stops while a prompt waits for someone. */
  remainingMs: number;
  timerStarted: number;
  waits: number;
  /** Cancels prompts still waiting when the turn is stopped or the session ends. */
  abort: AbortController;
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
function checkFiles(files: string[], roots: string[]): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const realRoots = roots.filter((r) => existsSync(r)).map((r) => realpathSync(r));
  for (const f of files) {
    try {
      const real = realpathSync(path.resolve(roots[0], f));
      if (!inside(real, realRoots)) rejected.push(`${f}: not under the working directory or the attachment folder`);
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
  ) {
    this.tag = `live ${threadId}`;
    this.sessionId = resume;
    this.cost = costBase;
    this.alwaysAllowed = new Set(alwaysAllowed);
    // The session reads freely, and in acceptEdits edits, inside its cwd and its thread's attachment folder.
    const roots = [channel.cwd, path.join(INBOX_DIR, threadId)];

    // Created once per session, so the tool and the permission callbacks act on whichever turn is current.
    const server = createSdkMcpServer({
      name: 'channelcollab',
      version: '0.1.0',
      alwaysLoad: true,
      tools: [
        tool(
          'reply',
          'Send a message to the people in the current Discord thread. This is the only way anyone sees what you say. Optionally attach local files (under the working directory or the attachment folder).',
          {
            text: z.string().describe('Message text (Markdown)'),
            files: z.array(z.string()).optional().describe('Local file paths to upload with the message'),
          },
          async ({ text, files }) => {
            const t = this.turn;
            const checked = checkFiles(files ?? [], roots);
            log('reply', `${threadId} ${brief(text, 300)}${files?.length ? ` files=${JSON.stringify(checked.ok)} rejected=${JSON.stringify(checked.rejected)}` : ''}`);
            if (!t) return { content: [{ type: 'text', text: 'Not delivered: no active turn.' }], isError: true };
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
      const d = decideTool(name, toolInput, { mode: channel.permissionMode, roots, alwaysAllowed: this.alwaysAllowed, ownPrefix: OWN_PREFIX });
      if (d.kind === 'cli') return {};
      if (d.kind === 'allow') {
        if (!name.startsWith(OWN_PREFIX)) log('permission', `${threadId} auto-allow ${name} (${d.why}) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: d.why } };
      }
      if (d.kind === 'deny') {
        this.turn?.denials.push(name);
        log('permission', `${threadId} deny ${name} (${d.why}) id=${toolUseId ?? '-'}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `這個頻道的權限模式（${channel.permissionMode}）不允許執行 ${name}。` } };
      }
      const answer = await this.ask(name, toolInput, toolUseId ?? '', signal);
      return answer.behavior === 'deny'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.message } }
        : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'approved by the owner' } };
    };

    // Reached by AskUserQuestion (the hook leaves it alone) and by anything Claude Code itself still wants to ask about.
    const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
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

    log(this.tag, `start cwd=${channel.cwd} model=${channel.model ?? '-'} mode=${channel.permissionMode} launcher=${channel.launcher || 'builtin'} resume=${resume ?? '-'} always=${JSON.stringify([...this.alwaysAllowed])}`);
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
        systemPrompt: { type: 'preset', preset: 'claude_code', append: guidelines(selfId) },
        allowedTools: [REPLY_TOOL],
        mcpServers: { channelcollab: server },
        // The hook awaits the owner's answer in-process, so its timeout (seconds) must outlast the prompt's.
        hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: Math.ceil(channel.permissionTimeoutMs / 1000) + 60 }] },
        canUseTool,
        maxTurns: MAX_TURNS,
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

  /** Cumulative total_cost_usd as of the last result. */
  get costTotal(): number {
    return this.cost;
  }

  /** The CLI exited on its own after stdin closed, so it saved its cost total for the next resume. */
  get cleanExit(): boolean {
    return this.clean;
  }

  /** Run one turn. Never rejects: failures come back as `ok: false`. One turn at a time. */
  run(prompt: string, callbacks: TurnCallbacks): Promise<TurnResult> {
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
        remainingMs: TURN_TIMEOUT_MS,
        timerStarted: 0,
        waits: 0,
        abort: new AbortController(),
        resolve,
      };
      this.turn = t;
      this.startClock(t);
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
      const limit = CLOSE_GRACE_MS + (this.busy ? TURN_TIMEOUT_MS : 0);
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
  private async ask(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionAnswer> {
    const t = this.turn;
    if (!t) return { behavior: 'deny', message: 'No active turn.' };
    log('permission', `${this.threadId} ask ${toolName} id=${toolUseId} ${brief(input)}`);
    const answer = await this.waitFor(() => t.askPermission({ toolName, input, toolUseId, signal: this.linked(signal, t) }));
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
    if (t && t.waits++ === 0) this.stopClock(t);
    try {
      return await wait();
    } finally {
      if (t && --t.waits === 0 && this.turn === t) this.startClock(t);
    }
  }

  private startClock(t: Turn): void {
    t.timerStarted = Date.now();
    t.timer = setTimeout(() => {
      log(this.tag, `turn ${t.n} timeout after ${TURN_TIMEOUT_MS} ms of work, killing the session`);
      this.failure = 'timeout';
      this.forced = true;
      t.abort.abort();
      this.abort.abort();
    }, t.remainingMs);
  }

  private stopClock(t: Turn): void {
    clearTimeout(t.timer);
    t.remainingMs = Math.max(0, t.remainingMs - (Date.now() - t.timerStarted));
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
      }
      this.sessionId = msg.session_id;
      this.model = msg.model;
    } else if (msg.type === 'assistant' && t) {
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

  private finishTurn(result: Result | undefined, error?: string): void {
    const t = this.turn;
    if (!t) {
      if (result) log(this.tag, `result without a turn: ${result.subtype}`);
      return;
    }
    this.turn = undefined;
    clearTimeout(t.timer);
    t.abort.abort();
    this.lastActivity = Date.now();

    // total_cost_usd is cumulative for the query, and a resumed query starts from
    // the total saved on the last clean exit (the base); a smaller value means
    // the total was reset.
    const costTotal = result ? result.total_cost_usd : this.cost;
    const turnCost = costTotal >= this.cost ? costTotal - this.cost : costTotal;
    this.cost = costTotal;
    if (result?.session_id) this.sessionId = result.session_id;

    const out: TurnResult = {
      ok: !!result && result.subtype === 'success' && !result.is_error,
      // An interrupted turn ends as error_during_execution; report it as what it was.
      subtype: t.stoppedBy && result ? 'interrupted' : (result?.subtype ?? this.failure ?? 'error'),
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
      error,
    };
    log('result', `${this.threadId} turn=${t.n} pid=${this.pid ?? '-'} ok=${out.ok} subtype=${out.subtype} session=${out.sessionId} turns=${out.numTurns} replies=${out.replies} tools=${out.tools.length} denials=${JSON.stringify(out.denials)}${out.stoppedBy ? ` stopped_by=${out.stoppedBy}` : ''} turn_cost_usd=${turnCost.toFixed(4)} total_cost_usd=${costTotal.toFixed(4)} duration_ms=${out.durationMs}`);
    t.resolve(out);
  }
}
