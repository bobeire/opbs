import { spawn } from 'child_process';

export type PowerAction = 'reboot' | 'shutdown';

export interface PowerCommand {
  file: string;
  args: string[];
}

export interface PowerResult {
  ok: boolean;
  via?: 'wpeutil' | 'shutdown';
  error?: string;
}

/**
 * The ways to power a machine off, in the order they are tried.
 *
 * Windows PE ships `wpeutil` and may not ship `shutdown.exe`; full Windows is
 * the other way round. Trying `wpeutil` first means the recovery media needs
 * no environment sniffing to find the tool that is actually there.
 */
export function powerCommands(action: PowerAction): PowerCommand[] {
  return [
    { file: 'wpeutil', args: [action] },
    { file: 'shutdown', args: action === 'reboot' ? ['/r', '/t', '0'] : ['/s', '/t', '0'] }
  ];
}

type Runner = (file: string, args: string[]) => Promise<number>;

const spawnAndWait: Runner = (file, args) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });

/**
 * Reboot or shut the machine down, using whichever tool exists. Never throws:
 * a rescue environment that cannot power off must say so and stay usable
 * rather than leave the console dead (field report 2026-11-01 — the only
 * documented way out was `wpeutil shutdown`, which is not obvious).
 */
export async function systemPower(action: PowerAction, run: Runner = spawnAndWait): Promise<PowerResult> {
  const failures: string[] = [];
  for (const cmd of powerCommands(action)) {
    try {
      const code = await run(cmd.file, cmd.args);
      if (code === 0) return { ok: true, via: cmd.file as 'wpeutil' | 'shutdown' };
      failures.push(`${cmd.file} exited ${code}`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { ok: false, error: failures.join('; ') };
}
