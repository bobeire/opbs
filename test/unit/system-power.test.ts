import { describe, it, expect } from 'vitest';
import { powerCommands, systemPower } from '../../src/main/utils/system-power';

describe('powerCommands', () => {
  it('tries the WinPE tool first, then the full-Windows one', () => {
    // Windows PE ships wpeutil; full Windows ships shutdown.exe. Trying in
    // this order needs no environment sniffing to find the tool that is there.
    expect(powerCommands('reboot')).toEqual([
      { file: 'wpeutil', args: ['reboot'] },
      { file: 'shutdown', args: ['/r', '/t', '0'] }
    ]);
    expect(powerCommands('shutdown')).toEqual([
      { file: 'wpeutil', args: ['shutdown'] },
      { file: 'shutdown', args: ['/s', '/t', '0'] }
    ]);
  });
});

describe('systemPower', () => {
  it('reports which tool did the work', async () => {
    const calls: string[] = [];
    const result = await systemPower('reboot', async (file) => {
      calls.push(file);
      return 0;
    });
    expect(result).toEqual({ ok: true, via: 'wpeutil' });
    expect(calls).toEqual(['wpeutil']);
  });

  it('falls back to shutdown.exe when wpeutil is absent', async () => {
    // The field case this guards: a rescue medium whose only documented way
    // out was `wpeutil shutdown`, which is not obvious and not present in
    // full Windows.
    const calls: string[] = [];
    const result = await systemPower('shutdown', async (file) => {
      calls.push(file);
      if (file === 'wpeutil') throw new Error('spawnSync wpeutil ENOENT');
      return 0;
    });
    expect(result).toEqual({ ok: true, via: 'shutdown' });
    expect(calls).toEqual(['wpeutil', 'shutdown']);
  });

  it('falls through when a tool exists but refuses', async () => {
    const calls: string[] = [];
    const result = await systemPower('reboot', async (file) => {
      calls.push(file);
      return file === 'wpeutil' ? 1 : 0;
    });
    expect(result).toEqual({ ok: true, via: 'shutdown' });
    expect(calls).toEqual(['wpeutil', 'shutdown']);
  });

  it('never throws when nothing works, so the console stays usable', async () => {
    const result = await systemPower('reboot', async (file) => {
      throw new Error(`${file} ENOENT`);
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('wpeutil ENOENT');
    expect(result.error).toContain('shutdown ENOENT');
  });
});
