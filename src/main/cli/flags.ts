/** Shared CLI flag helpers (kept out of index.ts so submodules can use them). */
/**
 * Reads a value flag in either `--flag value` or `--flag=value` form.
 *
 * The equals form matters for URI values (e.g. `--remote=s3://bucket/x`):
 * Electron's protocol-handler fix rejects any argv token that looks like a
 * `scheme://` URI unless it is the final argument (or follows a standalone
 * `--`), while a `--flag=s3://…` token is a single switch-looking token that
 * always passes.
 */
export function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

/** Flags that consume the following token as their value. */
export const VALUE_FLAGS = [
  '--lock-days',
  '--passphrase',
  '--keyfile',
  '--to',
  '--anchor',
  '--remote',
  '--remote-lock'
];

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
