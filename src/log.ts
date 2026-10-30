/** One greppable line per event: `[HH:MM:SS.mmm] [tag] message`. */
export function log(tag: string, ...rest: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${tag}]`, ...rest);
}

export function brief(value: unknown, max = 200): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
