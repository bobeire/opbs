/**
 * Console colour for the recovery environment.
 *
 * Colour is decoration, never the only signal: every message that uses it
 * keeps a plain-text word ("WARNING", "OK", "REFUSED") so a console with no
 * VT support — or a log file — reads exactly as well. `NO_COLOR` and
 * `OPBS_NO_COLOR` turn it off, `FORCE_COLOR` turns it on, and anything that
 * cannot be answered safely falls back to plain text rather than printing
 * escape sequences at someone whose machine is already broken.
 */

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  amber(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

const ESC = '\u001b[';
const wrap = (open: string, close: string) => (text: string) => `${ESC}${open}m${text}${ESC}${close}m`;

/**
 * Whether this console can show ANSI colour. Asks the stream first — Node's
 * tty stream reports the real console colour depth on Windows, which is the
 * only trustworthy answer in an unknown WinPE image.
 */
export function detectColorSupport(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.OPBS_NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  const withDepth = stream as { getColorDepth?: () => number };
  if (typeof withDepth.getColorDepth === 'function') {
    try {
      return withDepth.getColorDepth() > 1;
    } catch {
      /* unknown console — plain text, never escape garbage */
    }
  }
  return false;
}

export function createStyle(enabled: boolean = detectColorSupport()): Style {
  if (!enabled) {
    const identity = (text: string) => text;
    return {
      enabled: false,
      bold: identity,
      dim: identity,
      green: identity,
      amber: identity,
      red: identity,
      cyan: identity
    };
  }
  return {
    enabled: true,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    green: wrap('32', '39'),
    amber: wrap('33', '39'),
    red: wrap('31', '39'),
    cyan: wrap('36', '39')
  };
}
