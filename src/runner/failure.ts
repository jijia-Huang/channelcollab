/**
 * Turning a failed turn into something a non-engineer can act on (pure).
 * Error text from Claude Code can quote credentials, so it is masked first.
 */

/** Token-shaped strings: Discord bot tokens, Anthropic keys, bearer tokens, JWT-like and long opaque strings. */
const SECRET_PATTERNS: RegExp[] = [
  /[MN][A-Za-z\d_-]{23,}\.[\w-]{6}\.[\w-]{27,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Bot)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g,
  /(?<![\\/:.\w-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w-])/g,
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (/^(Bearer|Bot)\s/i.test(m) ? `${m.split(/\s+/)[0]} ***` : '***'));
  return out;
}

export type FailureFacts = {
  subtype: string;
  /** result text (is_error with subtype success), result errors, or the exception message. */
  error?: string;
  /** SDKAssistantMessageError of the last assistant message, when there was one. */
  apiError?: string;
};

const HINTS: { test: (f: FailureFacts, text: string) => boolean; hint: string }[] = [
  {
    test: (f, t) => f.apiError === 'authentication_failed' || f.apiError === 'oauth_org_not_allowed' || /not logged in|please run \/login|\/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|oauth token|credentials/i.test(t),
    hint: 'Claude 沒登入（或登入過期）：請在這台電腦開終端機執行 claude，照畫面登入後再試。',
  },
  { test: (f, t) => f.apiError === 'billing_error' || /credit balance|billing|payment/i.test(t), hint: '帳號的付費或額度設定有問題，請找管理員確認。' },
  { test: (f, t) => f.apiError === 'rate_limit' || /rate.?limit|usage limit|limit reached|\b429\b|hit your limit/i.test(t), hint: '額度暫時用完了，等重置後再試（打 !status 可以看額度）。' },
  { test: (f, t) => f.apiError === 'model_not_found' || /model\b.*\b(not found|does not exist|not available|invalid)|invalid model/i.test(t), hint: '模型名稱不對或沒有使用權限，打 !model 換一個。' },
  { test: (_f, t) => /prompt is too long|context (length|window)|too many tokens|exceeds? the (maximum|context)/i.test(t), hint: '上下文太長了：打 !compact 壓縮，或在私訊打 !clear 開新對話。' },
  {
    test: (f, t) => f.apiError === 'overloaded' || f.apiError === 'server_error' || /overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket hang up/i.test(t),
    hint: 'Anthropic 服務暫時忙碌或網路不穩，稍後再試一次（可以打 !retry）。',
  },
  { test: (f) => f.subtype === 'error_max_turns', hint: '這一輪的步驟太多被中止了，可以拆成小一點的請求再試。' },
  { test: (f) => f.subtype === 'timeout', hint: '這一輪做太久（超過 10 分鐘的工作時間）被中止了，可以拆成小一點的請求再試。' },
];

/** The hint for a failure; a generic one when nothing matches. */
export function failureHint(f: FailureFacts): string {
  const text = `${f.error ?? ''}`;
  return HINTS.find((h) => h.test(f, text))?.hint ?? '可以再試一次（打 !retry）；一直失敗的話，請在電腦上用 /channelcollab:status 看最近的錯誤。';
}

/** First lines of the error, masked, each clipped. */
export function errorExcerpt(error: string | undefined, maxLines = 3, maxChars = 200): string[] {
  if (!error?.trim()) return [];
  return maskSecrets(error)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
}

/** The notice posted when a turn fails. */
export function explainFailure(f: FailureFacts, followUp = '下一則訊息會接著這段對話。'): string {
  const head = `❌ 執行失敗${f.subtype && f.subtype !== 'success' && f.subtype !== 'error' ? `（${f.subtype}）` : ''}`;
  const lines = errorExcerpt(f.error).map((l) => `> ${l.replace(/`/g, "'")}`);
  if (!lines.length && f.apiError) lines.push(`> ${f.apiError}`);
  return [head, ...lines, `💡 ${failureHint(f)}`, followUp].filter(Boolean).join('\n');
}
