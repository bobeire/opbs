import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStyle, detectColorSupport } from '../../src/main/cli/console-style';
import {
  runRecoveryMenu,
  runMachineCheck,
  type WizardIO,
  type RecoveryMenuDeps,
  type RecoveryMenuStatus
} from '../../src/main/cli/restore-wizard';

/** Scripted WizardIO: answers from a fixed queue, records everything printed. */
function fakeIO(answers: string[] = []) {
  const lines: string[] = [];
  const queue = [...answers];
  const io: WizardIO = {
    print: (line = '') => void lines.push(line),
    write: (text) => void lines.push(text),
    ask: async () => queue.shift() ?? '',
    close: () => undefined
  };
  return { io, text: () => lines.join('\n') };
}

const status: RecoveryMenuStatus = {
  opbsVersion: '0.6.104',
  disks: [{ index: 0, model: 'TEST-SSD', size: 1_000_000_000, partitions: 4 }],
  imagesFound: 2
};

const deps: RecoveryMenuDeps = {
  collectStatus: async () => status,
  listPartitions: async () => [
    { partitionIndex: 1, size: 100_000_000, driveLetter: undefined },
    { partitionIndex: 2, size: 900_000_000, driveLetter: 'C:' }
  ],
  scanImages: () => [
    {
      path: 'D:\\backups\\pc.opbs',
      name: 'pc.opbs',
      size: 500_000_000,
      timestamp: Date.now(),
      incremental: false,
      encrypted: true
    }
  ]
};

describe('console colour', () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, OPBS_NO_COLOR: process.env.OPBS_NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.OPBS_NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  it('honours the standard opt-outs', () => {
    process.env.NO_COLOR = '1';
    expect(detectColorSupport()).toBe(false);
    delete process.env.NO_COLOR;
    process.env.OPBS_NO_COLOR = '1';
    expect(detectColorSupport()).toBe(false);
    delete process.env.OPBS_NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(detectColorSupport()).toBe(true);
  });

  it('emits nothing but text when colour is off', () => {
    const s = createStyle(false);
    expect(s.enabled).toBe(false);
    expect(s.red('WARNING')).toBe('WARNING');
    expect(s.bold('x') + s.dim('y')).toBe('xy');
  });

  it('emits ANSI sequences when colour is on', () => {
    const s = createStyle(true);
    expect(s.red('WARNING')).toBe('\u001b[31mWARNING\u001b[39m');
    // Colour is additive: the word survives, so a plain console still reads.
    expect(s.red('WARNING')).toContain('WARNING');
  });
});

describe('recovery menu', () => {
  it('opens with what this machine is, before asking for a decision', async () => {
    const { io, text } = fakeIO(['q']);
    await runRecoveryMenu(io, { deps });
    const out = text();
    // A user at this screen has a machine that will not start: being told what
    // the tool can see is the difference between calm and guessing.
    expect(out).toContain('OPBS Recovery');
    expect(out).toContain('0.6.104');
    expect(out).toContain('1 disk');
    expect(out).toContain('TEST-SSD');
    expect(out).toContain('2 backup images found');
  });

  it('offers a read-only check before anything destructive', async () => {
    const { io, text } = fakeIO(['0']);
    expect(await runRecoveryMenu(io, { deps })).toBe('check');
    expect(text()).toContain('[0] Check this machine');
    // It is labelled read-only, so nobody avoids it out of caution.
    expect(text()).toContain('read-only');
  });

  it('still works with no status available', async () => {
    const { io, text } = fakeIO(['1']);
    expect(await runRecoveryMenu(io)).toBe('restore');
    expect(text()).toContain('Restore this machine');
    expect(text()).not.toContain('OPBS Recovery');
  });

  it('warns when no images are found rather than showing a blank line', async () => {
    const { io, text } = fakeIO(['q']);
    await runRecoveryMenu(io, {
      deps: { ...deps, collectStatus: async () => ({ ...status, imagesFound: 0 }) }
    });
    expect(text()).toContain('none yet');
  });
});

describe('runMachineCheck', () => {
  it('lists disks, partitions and images, and says it changed nothing', async () => {
    const { io, text } = fakeIO();
    await runMachineCheck(io, deps);
    const out = text();
    expect(out).toContain('nothing is changed');
    expect(out).toContain('Disk 0');
    expect(out).toContain('TEST-SSD');
    expect(out).toContain('partition 1');
    expect(out).toContain('-> C:');
    expect(out).toContain('D:\\backups\\pc.opbs');
    expect(out).toContain('encrypted');
    expect(out).toContain('Nothing was changed');
  });

  it('tells the user what to do when there are no images', async () => {
    const { io, text } = fakeIO();
    await runMachineCheck(io, { ...deps, scanImages: () => [] });
    expect(text()).toContain('No backup images found');
    expect(text()).toContain('plug it in');
  });

  it('reports a partition failure instead of throwing', async () => {
    const { io, text } = fakeIO();
    await runMachineCheck(io, {
      ...deps,
      listPartitions: async () => {
        throw new Error('ioctl failed');
      }
    });
    expect(text()).toContain('could not read partitions');
    expect(text()).toContain('ioctl failed');
  });
});
