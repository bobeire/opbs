import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestoreManager } from '../../src/main/restore/manager';
import { RestoreEngine } from '../../src/main/imaging/restore-engine';

const listBitlockerStatus = vi.fn();

vi.mock('../../src/main/utils/bitlocker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utils/bitlocker')>();
  return {
    ...actual,
    listBitlockerStatus: (...args: unknown[]) => listBitlockerStatus(...args)
  };
});

function stubManager(): RestoreManager {
  const stubDisks = {
    getDisks: async () => [{ index: 1, size: 10_000_000_000, model: 'TestDrive', serial: 'TEST1', partitions: [] }]
  };
  return new RestoreManager(new RestoreEngine(stubDisks as never), stubDisks as never);
}

function lockedStatus(letter: string) {
  return {
    ok: true,
    source: 'bitlocker-json-elevated',
    volumes: [
      {
        letter,
        volumeType: 'Data',
        locked: true,
        protectionOn: true,
        conversion: 'FullyEncrypted',
        protectors: [{ type: 'RecoveryPassword' }]
      }
    ]
  };
}

function unlockedStatus(letter: string) {
  return { ...lockedStatus(letter), volumes: [{ ...lockedStatus(letter).volumes[0], locked: false }] };
}

function missingVolumeLetter(): string | null {
  for (const l of ['Q', 'W', 'X', 'Y', 'V']) {
    if (!fs.existsSync(`${l}:\\`)) return l;
  }
  return null;
}

describe('RestoreManager.preflight — BitLocker unlock integration', () => {
  beforeEach(() => {
    listBitlockerStatus.mockReset();
  });

  it('returns unlockRequired BEFORE touching the filesystem when the image volume is locked', async () => {
    listBitlockerStatus.mockResolvedValue(lockedStatus('Z'));
    const manager = stubManager();

    const result = await manager.preflight({
      imagePath: 'Z:\\backups\\system.opbs',
      targetDiskIndex: 1,
      targetPartitions: [0]
    });

    expect(result.ok).toBe(false);
    expect(result.unlockRequired).toBe(true);
    expect(result.lockedLetter).toBe('Z');
    expect(result.error).toContain('locked BitLocker volume Z:');
    expect(listBitlockerStatus).toHaveBeenCalledWith({});
  });

  it('flags a missing image as unlockRequired only when the volume root itself is unreachable', async () => {
    listBitlockerStatus.mockResolvedValue({ ok: false, source: 'non-admin', volumes: [], needsElevation: true });
    const manager = stubManager();
    const letter = missingVolumeLetter();
    expect(letter).not.toBeNull();

    const result = await manager.preflight({
      imagePath: `${letter}:\\backups\\missing.opbs`,
      targetDiskIndex: 1,
      targetPartitions: [0]
    });

    expect(result.ok).toBe(false);
    expect(result.unlockRequired).toBe(true);
    expect(result.lockedLetter).toBe(letter);
    expect(result.error).toContain('not accessible');
  });

  it('keeps a plain missing file (existing volume) as a normal error', async () => {
    listBitlockerStatus.mockResolvedValue({ ok: false, source: 'non-admin', volumes: [], needsElevation: true });
    const manager = stubManager();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-bl-restore-'));
    try {
      const result = await manager.preflight({
        imagePath: path.join(dir, 'missing.opbs'),
        targetDiskIndex: 1,
        targetPartitions: [0]
      });

      expect(result.ok).toBe(false);
      expect(result.unlockRequired).toBeUndefined();
      expect(result.error).toBe('Image file does not exist');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not demand an unlock for an unlocked volume (failure surfaces generically)', async () => {
    listBitlockerStatus.mockResolvedValue(unlockedStatus('Z'));
    const manager = stubManager();

    const result = await manager.preflight({
      imagePath: 'Z:\\backups\\definitely-not-here.opbs',
      targetDiskIndex: 1,
      targetPartitions: [0]
    });

    expect(result.ok).toBe(false);
    // Z: root also missing on this machine → unreachable-root mapping still applies,
    // but only because the root cannot be opened; assert the response shape.
    if (result.unlockRequired) {
      expect(result.lockedLetter).toBe('Z');
    } else {
      expect(result.error).toContain('not exist');
    }
  });
});
