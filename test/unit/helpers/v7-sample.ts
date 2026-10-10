import * as fs from 'fs';
import * as path from 'path';

/**
 * Discovery for user-provided real Macrium Reflect `.mrimg` samples. The
 * samples are gitignored, so suites gate on whatever is present:
 *  - `$OPBS_V7_SAMPLE` points at one full image (highest priority),
 *  - else the first `*-00-00.mrimg` at the repo root (historic layout),
 *  - else the first `*-00-00.mrimg` in `imagefilesamples/`.
 * Chain tests look in `$OPBS_V7_CHAIN_DIR` or `imagefilesamples/` for a full
 * plus its `-01-01`/`-02-02` siblings.
 */
const HELPERS_DIR = __dirname;
const REPO_ROOT = path.join(HELPERS_DIR, '..', '..', '..');

function firstFullSample(dir: string): string | undefined {
  try {
    const name = fs
      .readdirSync(dir)
      .filter((n) => /-\d{2}-\d{2}\.mrimg$/i.test(n))
      .sort()
      .find((n) => /-00-00\.mrimg$/i.test(n));
    return name ? path.join(dir, name) : undefined;
  } catch {
    return undefined;
  }
}

/** A real full-image sample for end-to-end container tests, if present. */
export function findV7FullSample(): string | undefined {
  const env = process.env.OPBS_V7_SAMPLE;
  if (env && fs.existsSync(env)) return env;
  return firstFullSample(REPO_ROOT) ?? firstFullSample(path.join(REPO_ROOT, 'imagefilesamples'));
}

export interface V7ChainSample {
  dir: string;
  full: string;
  diff: string;
  inc: string;
  present: boolean;
}

/**
 * A real full + two chain members (`-01-01`, `-02-02`) sharing one image id.
 * The members' roles (differential vs incremental) come from each file's own
 * footer, not from the numbering — tests must not assume which is which.
 */
export function findV7ChainSample(): V7ChainSample {
  const dir = process.env.OPBS_V7_CHAIN_DIR ?? path.join(REPO_ROOT, 'imagefilesamples');
  const full = firstFullSample(dir);
  const stem = full ? path.basename(full).replace(/-00-00\.mrimg$/i, '') : '';
  const diff = stem ? path.join(dir, `${stem}-01-01.mrimg`) : '';
  const inc = stem ? path.join(dir, `${stem}-02-02.mrimg`) : '';
  return {
    dir,
    full: full ?? '',
    diff,
    inc,
    present: !!full && fs.existsSync(diff) && fs.existsSync(inc)
  };
}

/**
 * Real `.mrimgx` (Reflect X) samples, gitignored like the v7 ones:
 *  - `$OPBS_MRIMGX_SAMPLE` points at one image (highest priority),
 *  - else every `*.mrimgx` in `imagefilesamples/`.
 */
export function findMrimgxSamples(): string[] {
  const env = process.env.OPBS_MRIMGX_SAMPLE;
  if (env && fs.existsSync(env)) return [env];
  const dir = path.join(REPO_ROOT, 'imagefilesamples');
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.mrimgx$/i.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
