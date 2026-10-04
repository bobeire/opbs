/** Shared CLI flag helpers (kept out of index.ts so submodules can use them). */
export function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

/** Flags that consume the following token as their value. */
export const VALUE_FLAGS = ['--lock-days', '--passphrase', '--keyfile', '--to', '--anchor'];

/**
 * Positional (non-flag) tokens, skipping flags and the values of
 * `valueFlags` — so `repo prune --dry-run <dir>` and `repo prune <dir>
 * --dry-run` both resolve the directory correctly.
 */
export function positionals(argv: string[], valueFlags: readonly string[] = VALUE_FLAGS): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (valueFlags.includes(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
