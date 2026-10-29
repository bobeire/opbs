import { describe, it, expect, afterEach } from 'vitest';
import {
  readMacriumImage,
  clearMacriumInfoCache,
  macriumUnsupportedReason,
  macriumRestoreRefusal
} from '../../src/main/imaging/mrimg/mrimg-format';
import { MacriumPasswordError } from '../../src/main/imaging/mrimg/mrimg-crypto';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { detectPartitionFilesystem, openAnyBrowse, listDirectory } from '../../src/main/imaging/fs/file-browse';
import { summarizeImage } from '../../src/main/imaging/restore-engine';
import { findMrimgxEncryptedSample } from './helpers/v7-sample';

/**
 * Ground truth for encrypted Reflect X images: a REAL password-protected
 * `.mrimgx` written by Macrium Reflect X. The sample is gitignored and the
 * passphrase comes from the environment, so this suite skips unless both are
 * present:
 *
 *   OPBS_MRIMGX_ENC_PASSPHRASE=<passphrase>        (required)
 *   OPBS_MRIMGX_ENC_SAMPLE=<path to .mrimgx>       (optional)
 *
 * Without it, the synthetic round trip in `mrimgx-encrypted.test.ts` is the
 * only coverage — which is exactly why this suite exists.
 */

const SAMPLE = findMrimgxEncryptedSample();

describe.skipIf(!SAMPLE)('real encrypted Reflect X sample (ground truth)', () => {
  // `describe.skipIf` still runs the suite body (it only skips the tests), so
  // the values must be safe to read when the sample is absent.
  const sample = SAMPLE ?? { imagePath: '', passphrase: '' };
  const imagePath = sample.imagePath;
  const passphrase = sample.passphrase;

  afterEach(() => {
    clearMacriumInfoCache();
  });

  it('is refused when locked, with the passphrase prompt as the reason', () => {
    const info = readMacriumImage(imagePath);
    expect(info.format).toBe('mrimgx');
    expect(info.encryption.enable).toBe(true);
    expect(info.unlocked).toBeFalsy();
    expect(macriumUnsupportedReason(info)).toMatch(/passphrase/);
    expect(macriumRestoreRefusal(info)).toMatch(/passphrase/);
  });

  it('rejects a wrong passphrase', () => {
    expect(() => readMacriumImage(imagePath, `${passphrase}-wrong`)).toThrow(MacriumPasswordError);
  });

  it('unlocks and MD5-verifies every block of every partition', () => {
    const info = readMacriumImage(imagePath, passphrase);
    expect(info.unlocked).toBe(true);
    expect(macriumUnsupportedReason(info)).toBeNull();
    expect(info.partitions.length).toBeGreaterThan(0);
    let blocksRead = 0;
    for (let i = 0; i < info.partitions.length; i++) {
      const part = info.partitions[i];
      if (part.blockSize <= 0 || part.blockCount <= 0) continue; // no captured data
      const reader = openMacriumPartitionReader(info, i);
      expect(reader.size).toBeGreaterThan(0);
      // Reading every byte exercises decrypt + zstd trim + the reader's
      // per-block MD5 verification for data and reserved blocks alike.
      const CHUNK = 4 * 1024 * 1024;
      for (let off = 0; off < reader.size; off += CHUNK) {
        expect(reader.read(off, Math.min(CHUNK, reader.size - off)).length).toBeGreaterThan(0);
      }
      blocksRead += part.blockCount;
    }
    expect(blocksRead).toBeGreaterThan(0);
  });

  it('detects the real filesystem and lists the root directory', () => {
    // Find any partition the browser can read (the first one is not always
    // the OS volume in a multi-partition image).
    let session: ReturnType<typeof openAnyBrowse> | undefined;
    let fsType = '';
    for (let i = 0; i < readMacriumImage(imagePath, passphrase).partitions.length; i++) {
      const probe = detectPartitionFilesystem(imagePath, i, passphrase);
      if (!probe.browsable) continue;
      fsType = probe.fsType;
      session = openAnyBrowse(imagePath, i, passphrase);
      break;
    }
    expect(fsType).toMatch(/NTFS|FAT32|exFAT/i);
    expect(session).toBeDefined();
    expect(() => listDirectory(session!, '')).not.toThrow();
  });

  it('summarizes for the restore wizard (locked and unlocked)', () => {
    const locked = summarizeImage(imagePath);
    expect(locked.encrypted).toBe(true);
    expect(locked.passphraseRequired).toBe(true);
    expect(locked.partitions.length).toBeGreaterThan(0);

    const unlocked = summarizeImage(imagePath, passphrase);
    expect(unlocked.passphraseRequired).toBe(false);
    expect(unlocked.partitions[0].fsType).not.toBe('Unknown');
  });
});
