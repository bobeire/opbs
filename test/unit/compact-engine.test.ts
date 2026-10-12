import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactChain, composeChainBlocks } from '../../src/main/imaging/compact-engine';
import { runBackupJob } from '../../src/main/helper/job-runner';
import { writeImageFromBytes } from '../helpers/opbs-image';
import {
  readImageInfo,
  readBlockDataFromImage,
  verifyImage,
  newImageCipher,
  metadataFromCipher,
  deriveImageKey,
  COMPRESSION_DEFLATE,
  COMPRESSION_ZSTD,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  FLAGS_OFFSET,
  ImageInfo
} from '../../src/main/imaging/image-format';
import { partitionReaderForChain } from '../../src/main/imaging/image-browse';
import { ImagingJob, NativeImagingApi } from '../../src/main/imaging/imaging-job';

const BLOCK = 16 * 1024;
const PASS = 'correct horse battery staple';

function blockPattern(seed: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed * 31 + i * 7) & 0xff;
  }
  return buf;
}

describe('composeChainBlocks', () => {
  const rec = (blockIndex: number, rawCrc32: number) => ({
    partitionIndex: 0,
    blockIndex,
    fileOffset: 0,
    rawSize: BLOCK,
    compSize: 10,
    rawCrc32
  });
  const member = (pathName: string, blocks: Array<ReturnType<typeof rec>>) =>
    ({ path: pathName, info: { blocks } as unknown as ImageInfo });

  it('newest member wins a contested block; sparse gaps stay absent', () => {
    const composed = composeChainBlocks([
      member('full.opbs', [rec(0, 100), rec(1, 101), rec(2, 102)]),
      member('delta.opbs', [rec(1, 999)])
    ]);
    expect(composed.size).toBe(3);
    expect(composed.get('0:1')!.memberPath).toBe('delta.opbs');
    expect(composed.get('0:1')!.record.rawCrc32).toBe(999);
    expect(composed.get('0:0')!.memberPath).toBe('full.opbs');
    expect(composed.get('0:2')!.record.rawCrc32).toBe(102);
  });

  it('multi-hop chains resolve newest-wins across three members', () => {
    const composed = composeChainBlocks([
      member('full.opbs', [rec(0, 1), rec(1, 2)]),
      member('d1.opbs', [rec(1, 3)]),
      member('d2.opbs', [rec(0, 4)])
    ]);
    expect(composed.get('0:0')!.memberPath).toBe('d2.opbs');
    expect(composed.get('0:1')!.memberPath).toBe('d1.opbs');
    expect(composed.get('0:1')!.record.rawCrc32).toBe(3);
  });
});

describe('compactChain', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let fullPath: string;
  let deltaPath: string;

  const PART_OFFSET = 122683392;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-job-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    fullPath = path.join(dir, 'full.opbs');
    deltaPath = path.join(dir, 'delta.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJob = (job: object): void => {
    fs.writeFileSync(jobPath, JSON.stringify(job));
  };

  const singlePartitionJob = (imagePath: string): ImagingJob => ({
    type: 'backup',
    imagePath,
    blockSize: BLOCK,
    compressionLevel: 3,
    verificationEnabled: true,
    partitions: [
      {
        diskIndex: 0,
        partitionIndex: 2,
        size: BLOCK * 3,
        offset: PART_OFFSET,
        label: 'Partition 2',
        readSource: 'physical'
      }
    ]
  });

  const createIncrementalMock = (): NativeImagingApi & { changeBlock1(): void } => {
    let block1Changed = false;
    const readBlocks = vi.fn((devicePath: string, offset: bigint, length: bigint): Buffer => {
      const offsetInPart = Number(offset) - PART_OFFSET;
      if (block1Changed && offsetInPart >= BLOCK && offsetInPart < 2 * BLOCK) {
        return blockPattern(9, Number(length));
      }
      if (offsetInPart === 2 * BLOCK) {
        return blockPattern(5, Number(length));
      }
      return blockPattern(3, Number(length));
    });
    return {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks,
      changeBlock1: () => {
        block1Changed = true;
      }
    };
  };

  const buildPlainTextChain = async (): Promise<NativeImagingApi> => {
    const native = createIncrementalMock();
    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    return native;
  };

  const readResult = <T>(): T => JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as T;

  it('copy-mode round-trip: compacted blocks equal the chain reader over the original', async () => {
    await buildPlainTextChain();
    const outPath = path.join(dir, 'compacted.opbs');

    const result = await compactChain({ imagePath: deltaPath, outputPath: outPath });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // Union of full (3) + delta rewrite of block 1 = 3 unique blocks.
    expect(result.blocksWritten).toBe(3);
    expect(result.outputPath).toBe(outPath);

    const outInfo = readImageInfo(outPath);
    expect(outInfo.header.baseImagePath).toBe('');
    expect(outInfo.header.flags & FLAG_INCREMENTAL).toBe(0);
    expect(outInfo.header.flags & FLAG_VERIFIED).toBeTruthy();
    expect(outInfo.blocks.length).toBe(3);

    const verified = await verifyImage(outPath);
    expect(verified.ok).toBe(true);

    const { reader } = partitionReaderForChain([fullPath, deltaPath], 2);
    for (const record of outInfo.blocks) {
      const fromOutput = readBlockDataFromImage(
        outPath,
        record.fileOffset,
        outInfo.header.compressionId,
        outInfo.header.cipherId
      );
      const fromChain = reader.read(record.blockIndex * BLOCK, BLOCK);
      expect(fromOutput).toEqual(fromChain);
    }

    // No temp dirs left behind.
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('opbs-compact-'));
    expect(leftovers).toEqual([]);
  });

  it('encrypted re-encode: per-member salts become one fresh key; data round-trips', async () => {
    // PBKDF2 at 600k iterations runs several times here (two member ciphers,
    // the re-encode's fresh cipher, per-member derivations, verify) — give it room.
    const cipherA = newImageCipher(PASS);
    const cipherB = newImageCipher(PASS); // different salt by construction
    expect(cipherA.salt.equals(cipherB.salt)).toBe(false);

    const native = createIncrementalMock();
    writeJob({
      ...singlePartitionJob(fullPath),
      verificationEnabled: false,
      encryption: metadataFromCipher(cipherA)
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult<{ ok: boolean }>().ok).toBe(true);

    native.changeBlock1();
    writeJob({
      ...singlePartitionJob(deltaPath),
      baseImagePath: fullPath,
      verificationEnabled: false,
      encryption: metadataFromCipher(cipherB)
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult<{ ok: boolean }>().ok).toBe(true);

    // Clear the unconditional VERIFIED flags so the chain is honest.
    for (const p of [fullPath, deltaPath]) {
      const info = readImageInfo(p);
      const fd = fs.openSync(p, 'r+');
      fs.writeSync(fd, Buffer.from([info.header.flags & ~FLAG_VERIFIED]), 0, 1, FLAGS_OFFSET);
      fs.closeSync(fd);
    }

    const outPath = path.join(dir, 'encrypted-out.opbs');

    // Gated without the passphrase.
    const gated = await compactChain({ imagePath: deltaPath, outputPath: outPath });
    expect(gated.ok).toBe(false);
    expect(gated.error).toMatch(/passphrase/);
    expect(fs.existsSync(outPath)).toBe(false);

    const result = await compactChain({ imagePath: deltaPath, outputPath: outPath, passphrase: PASS });
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(3);

    const outInfo = readImageInfo(outPath);
    expect(outInfo.header.cipherId).toBe(cipherA.cipherId);
    // A fresh salt: differs from both members.
    expect(outInfo.header.salt.equals(cipherA.salt)).toBe(false);
    expect(outInfo.header.salt.equals(cipherB.salt)).toBe(false);
    const newKey = deriveImageKey(PASS, outInfo.header.salt, outInfo.header.kdfIterations);
    const verified = await verifyImage(outPath, newKey);
    expect(verified.ok).toBe(true);

    const { reader } = partitionReaderForChain([fullPath, deltaPath], 2, PASS);
    for (const record of outInfo.blocks) {
      const fromOutput = readBlockDataFromImage(
        outPath,
        record.fileOffset,
        outInfo.header.compressionId,
        outInfo.header.cipherId,
        newKey
      );
      expect(fromOutput).toEqual(reader.read(record.blockIndex * BLOCK, BLOCK));
    }
  }, 60_000);

  it('refuses: single member, mixed codecs, mixed ciphers, repository members, existing output, free space', async () => {
    // Single member.
    const native = createIncrementalMock();
    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const single = await compactChain({ imagePath: fullPath, dryRun: true });
    expect(single.ok).toBe(false);
    expect(single.error).toMatch(/single member/);

    // Real two-member chain for the remaining rows.
    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    // Mixed compression codecs (root backups use deflate, so zstd differs).
    const badCodec = path.join(dir, 'bad-codec.opbs');
    writeImageFromBytes(badCodec, blockPattern(7, BLOCK * 3), BLOCK, COMPRESSION_ZSTD, {
      baseImagePath: fullPath
    });
    const mixedCodec = await compactChain({ imagePath: badCodec, dryRun: true });
    expect(mixedCodec.ok).toBe(false);
    expect(mixedCodec.error).toMatch(/compression/);

    // Mixed encryption states (same codec as the root so only the cipher differs).
    const encryptedDelta = path.join(dir, 'encrypted-delta.opbs');
    writeImageFromBytes(encryptedDelta, blockPattern(7, BLOCK * 3), BLOCK, COMPRESSION_DEFLATE, {
      cipher: newImageCipher(PASS),
      baseImagePath: fullPath
    });
    const mixedCipher = await compactChain({ imagePath: encryptedDelta, dryRun: true });
    expect(mixedCipher.ok).toBe(false);
    expect(mixedCipher.error).toMatch(/encryption/);

    // Repository member (self-contained chain inside the repo's images dir).
    const repoDir = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'opbs-repo.json'), '{}');
    const repoRoot = path.join(repoDir, 'images', 'r.opbs');
    const repoDelta = path.join(repoDir, 'images', 'd.opbs');
    writeImageFromBytes(repoRoot, blockPattern(3, BLOCK * 3), BLOCK);
    writeImageFromBytes(repoDelta, blockPattern(7, BLOCK), BLOCK, COMPRESSION_ZSTD, {
      baseImagePath: repoRoot
    });
    const repo = await compactChain({ imagePath: repoDelta, dryRun: true });
    expect(repo.ok).toBe(false);
    expect(repo.error).toMatch(/repository/);

    // Existing output.
    const existing = path.join(dir, 'exists.opbs');
    fs.writeFileSync(existing, 'not-an-image');
    const exists = await compactChain({ imagePath: deltaPath, outputPath: existing });
    expect(exists.ok).toBe(false);
    expect(exists.error).toMatch(/already exists/);

    // Free-space gate (injected).
    const outPath = path.join(dir, 'no-space.opbs');
    const noSpace = await compactChain({
      imagePath: deltaPath,
      outputPath: outPath,
      ensureFreeSpace: async () => {
        throw new Error('Not enough free space to compact: need 99999 MB');
      }
    });
    expect(noSpace.ok).toBe(false);
    expect(noSpace.error).toMatch(/free space/);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('dry-run reports the plan and writes nothing', async () => {
    await buildPlainTextChain();
    const outPath = path.join(dir, 'dry.opbs');
    const result = await compactChain({ imagePath: deltaPath, outputPath: outPath, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.plan.members.map((m) => m.path)).toEqual([fullPath, deltaPath]);
    expect(result.plan.uniqueBlocks).toBe(3);
    expect(result.plan.encrypted).toBe(false);
    expect(result.plan.estimatedOutputBytes).toBeGreaterThan(0);
    expect(result.outputPath).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('opbs-compact-'))).toBe(false);
  });

  it('--remove-source deletes newest-first, carries the USN sidecar, and the next delta still skips', async () => {
    await buildPlainTextChain();
    // Newest member's USN cursors (as a scheduled backup would leave behind).
    const usnContent = JSON.stringify({ version: 2, partitions: [{ partitionIndex: 2, volume: '\\\\.\\C:', usn: '0x1' }] });
    fs.writeFileSync(`${deltaPath}.usn`, usnContent);

    const outPath = path.join(dir, 'compacted.opbs');
    const result = await compactChain({ imagePath: deltaPath, outputPath: outPath, removeSource: true });
    expect(result.ok).toBe(true);
    expect(result.sourcesRemoved).toEqual([deltaPath, fullPath]);
    expect(fs.existsSync(deltaPath)).toBe(false);
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(fs.existsSync(`${outPath}.usn`)).toBe(true);
    expect(fs.readFileSync(`${outPath}.usn`, 'utf-8')).toBe(usnContent);
    expect(fs.existsSync(`${deltaPath}.usn`)).toBe(false);

    // USN/CRC continuity: the next incremental against the compacted image
    // still skips every unchanged block — the compacted root now holds the
    // whole union, so only the reverted block 1 is captured again.
    const native2 = createIncrementalMock();
    const delta2Path = path.join(dir, 'delta2.opbs');
    writeJob({ ...singlePartitionJob(delta2Path), baseImagePath: outPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native2);
    const next = readResult<{ ok: boolean; blocksWritten: number; skippedBlocks?: number }>();
    expect(next.ok).toBe(true);
    expect(next.blocksWritten).toBe(1);
    expect(next.skippedBlocks).toBe(2);
  });

  it('cancellation mid-write leaves no final artifact and cleans the temp dir', async () => {
    await buildPlainTextChain();
    const outPath = path.join(dir, 'cancelled.opbs');
    let reads = 0;
    const result = await compactChain({
      imagePath: deltaPath,
      outputPath: outPath,
      shouldCancel: () => ++reads > 1
    });
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('opbs-compact-'))).toBe(false);
  });
});
