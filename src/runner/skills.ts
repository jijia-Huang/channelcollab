/**
 * Skills and custom commands a conversation can hand to Claude Code with
 * /skill (or !skill). Pure: the session reports what Claude Code offers, this
 * keeps only what makes sense to run from Discord (src/features.test.ts).
 */

/** One entry of the /skill list. */
export type SkillItem = { name: string; description: string; hint: string };

/** What Claude Code reports (the SDK's SlashCommand). */
export type OfferedCommand = { name: string; description?: string; argumentHint?: string; builtin?: boolean };

/** Plugin skills are `plugin:skill`; nothing else (no spaces, slashes or quotes) is a name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export function validSkillName(name: string): boolean {
  return NAME.test(name);
}

/**
 * Keep skills (bundled or not) and custom commands; drop Claude Code's own
 * built-in commands (they act on the terminal or the session in ways the
 * Discord commands already cover, e.g. /compact) and anything tied to the
 * terminal. `skills` is the init message's list: a bundled skill counts even
 * when it is marked built-in.
 */
export function skillCatalog(offered: OfferedCommand[], skills: string[] = [], terminal: string[] = []): SkillItem[] {
  const isSkill = new Set(skills);
  const noTerminal = new Set(terminal);
  const seen = new Map<string, SkillItem>();
  for (const c of offered) {
    if (!validSkillName(c.name) || noTerminal.has(c.name)) continue;
    if (c.builtin && !isSkill.has(c.name)) continue;
    if (!seen.has(c.name)) seen.set(c.name, { name: c.name, description: (c.description ?? '').trim(), hint: (c.argumentHint ?? '').trim() });
  }
  // Skills the init message lists but the command list left out.
  for (const s of skills) if (validSkillName(s) && !noTerminal.has(s) && !seen.has(s)) seen.set(s, { name: s, description: '', hint: '' });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Discord allows 25 autocomplete choices, each name up to 100 characters. */
export const MAX_CHOICES = 25;
/** Value of the one choice shown when there is no list yet; never accepted as a skill. */
export const NO_LIST = '__none__';
export const NO_LIST_TEXT = '先傳一則訊息開始對話，之後就能選 skill';

/** Autocomplete choices for what has been typed so far (name first, then description). */
export function skillChoices(list: SkillItem[] | undefined, typed: string): { name: string; value: string }[] {
  if (!list?.length) return [{ name: NO_LIST_TEXT, value: NO_LIST }];
  const q = typed.trim().toLowerCase().replace(/^\//, '');
  const score = (s: SkillItem) => (!q ? 1 : s.name.toLowerCase().startsWith(q) ? 0 : s.name.toLowerCase().includes(q) ? 1 : s.description.toLowerCase().includes(q) ? 2 : 3);
  return list
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n < 3)
    .sort((a, b) => a.n - b.n || a.s.name.localeCompare(b.s.name))
    .slice(0, MAX_CHOICES)
    .map(({ s }) => {
      const label = s.description ? `${s.name} — ${s.description.replace(/\s+/g, ' ')}` : s.name;
      return { name: label.length > 100 ? `${label.slice(0, 99)}…` : label, value: s.name };
    });
}

/** Arguments go on the same line as the command; long ones are cut. */
export const MAX_SKILL_ARGS = 1500;

/**
 * The message handed to the session for `/skill name args`. Only a name in
 * the conversation's list is accepted, so arbitrary text never becomes the
 * command itself.
 */
export function skillPrompt(list: SkillItem[] | undefined, name: string, args = ''): { ok: true; prompt: string } | { ok: false; reason: 'no-list' | 'unknown' } {
  if (!list?.length) return { ok: false, reason: 'no-list' };
  const n = name.trim().replace(/^\//, '');
  if (n === NO_LIST || !validSkillName(n) || !list.some((s) => s.name === n)) return { ok: false, reason: 'unknown' };
  const a = args.replace(/\s+/g, ' ').trim().slice(0, MAX_SKILL_ARGS);
  return { ok: true, prompt: a ? `/${n} ${a}` : `/${n}` };
}
