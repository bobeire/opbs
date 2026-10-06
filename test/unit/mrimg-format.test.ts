import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectMacriumFormat, readMacriumImage, MacriumUnsupportedError, macriumUnsupportedReason, readImageFileRange } from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { openAnyBrowse, detectPartitionFilesystem } from '../../src/main/imaging/fs/file-browse';
import { buildMrimgxImage } from '../helpers/mrimg-image';

describe('mrimg-format', () => {
  let fixtureDir: string;
  let mrimgxPath: string;
  let fixture: ReturnType<typeof buildMrimgxImage>;
  let block0Raw: Buffer;
  let block1Raw: Buffer;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimg-'));
    // Build blocks as raw NTFS boot sector-like content (just zeros for simplicity)
    block0Raw = Buffer.alloc(8192);
    block1Raw = Buffer.alloc(8192);
    // Fill with identifiable pattern
    for (let i = 0; i < 8192; i++) { block0Raw[i] = i & 0xff; block1Raw[i] = (i + 128) & 0xff; }
    fixture = buildMrimgxImage([block0Raw, block1Raw]);
    mrimgxPath = path.join(fixtureDir, 'test.mrimgx');
    fs.writeFileSync(mrimgxPath, fixture.buffer);
    fs.writeFileSync(path.join(fixtureDir, 'dummy.txt'), 'not an image');
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('detects mrimgx format', () => {
    expect(detectMacriumFormat(mrimgxPath)).toBe('mrimgx');
  });

  it('detects non-Macrium as null', () => {
    expect(detectMacriumFormat(path.join(fixtureDir, 'dummy.txt'))).toBeNull();
  });

  it('parses image metadata', () => {
    const info = readMacriumImage(mrimgxPath);
    expect(info.format).toBe('mrimgx');
    expect(info.imageId).toBe('00000001');
    expect(info.backupType).toBe('full');
    expect(info.backupTime).toBe(1600000000);
    expect(info.encryption.enable).toBe(false);
    expect(info.compression.method).toBe('zstd');
    expect(info.disks).toHaveLength(1);
    expect(info.partitions).toHaveLength(1);
    expect(info.partitions[0].blockSize).toBe(fixture.blockSize);
    expect(info.partitions[0].blockCount).toBe(2);
    expect(info.partitions[0].volumeLabel).toBe('TEST');
    expect(info.partitions[0].dataStart).toBe(0);
    expect(info.partitions[0].blocks).toHaveLength(2);
  });

  it('reads data blocks and verifies md5', () => {
    const info = readMacriumImage(mrimgxPath);
    const reader = openMacriumPartitionReader(info, 0);
    const r0 = reader.read(0, 8192);
    expect(r0.equals(block0Raw)).toBe(true);
    const r1 = reader.read(8192, 8192);
    expect(r1.equals(block1Raw)).toBe(true);
  });

  it('rejects split images', () => {
    const info = readMacriumImage(mrimgxPath);
    (info as any).splitFile = true;
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('split');
  });

  it('rejects encrypted images', () => {
    const info = readMacriumImage(mrimgxPath);
    (info as any).encryption = { enable: true, keyIterations: 100000 };
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('password');
  });

  it('detects encryption from image contents', () => {
    const built = buildMrimgxImage([Buffer.alloc(8192, 1)], (json) => {
      json._encryption = { enable: true, keyIterations: 600000 };
    });
    const p = path.join(fixtureDir, 'content-enc.mrimgx');
    fs.writeFileSync(p, built.buffer);
    const info = readMacriumImage(p);
    expect(info.encryption.enable).toBe(true);
    expect(macriumUnsupportedReason(info)).toMatch(/password-protected/);
    let caught: unknown;
    try {
      openMacriumPartitionReader(info, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MacriumUnsupportedError);
    expect((caught as Error).message).toMatch(/password/);
  });

  it('detects split containers from image contents', () => {
    const built = buildMrimgxImage([Buffer.alloc(8192, 2)], (json) => {
      json._header.split_file = true;
    });
    const p = path.join(fixtureDir, 'content-split.mrimgx');
    fs.writeFileSync(p, built.buffer);
    const info = readMacriumImage(p);
    expect(info.splitFile).toBe(true);
    expect(macriumUnsupportedReason(info)).toMatch(/split/);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('split');
  });

  it('refuses a delta/incremental container instead of misparsing its index', () => {
    const built = buildMrimgxImage([Buffer.alloc(8192, 3)], (json) => {
      json._header.delta_index = true;
      json._header.backup_type = 'incremental';
    });
    const p = path.join(fixtureDir, 'content-delta.mrimgx');
    fs.writeFileSync(p, built.buffer);
    // The delta $INDEX payload has a different shape; parsing it as a plain
    // index used to throw "Truncated Macrium block index." — it must parse,
    // skip the walk, and refuse through the reader gate instead.
    const info = readMacriumImage(p);
    expect(info.partitions[0].blocks).toEqual([]);
    expect(macriumUnsupportedReason(info)).toMatch(/delta-incremental/);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('delta-incremental');
  });

  it('refuses a non-delta incremental (backup_type) container', () => {
    const built = buildMrimgxImage([Buffer.alloc(8192, 4)], (json) => {
      json._header.backup_type = 'incremental';
    });
    const p = path.join(fixtureDir, 'content-incr.mrimgx');
    fs.writeFileSync(p, built.buffer);
    const info = readMacriumImage(p);
    expect(macriumUnsupportedReason(info)).toMatch(/incremental/);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
  });

  it('surfaces the refusal reason through detectPartitionFilesystem', () => {
    const built = buildMrimgxImage([Buffer.alloc(8192, 5)], (json) => {
      json._encryption = { enable: true, keyIterations: 600000 };
    });
    const p = path.join(fixtureDir, 'probe-enc.mrimgx');
    fs.writeFileSync(p, built.buffer);
    const probe = detectPartitionFilesystem(p, 0);
    expect(probe.browsable).toBe(false);
    expect(probe.fsType).toBe('Unsupported');
    expect(probe.reason).toMatch(/password-protected/);
  });

  it('rejects unknown format', () => {
    const empty = path.join(fixtureDir, 'empty.bin');
    fs.writeFileSync(empty, Buffer.alloc(1024));
    expect(() => readMacriumImage(empty)).toThrow('Not a Macrium Reflect image');
  });

  it('rejects a footer-only mrimg-v7 file as structurally invalid', () => {
    const v7 = path.join(fixtureDir, 'test.mrimg');
    const buf = Buffer.alloc(64);
    // v7 trailer is the last 54 bytes; magic sits at tail offset 14,
    // so with a 64-byte file it lands at absolute offset 10 + 14 = 24.
    Buffer.from('__79241006_2651_11D4_', 'latin1').copy(buf, 24);
    buf[45] = 0;
    fs.writeFileSync(v7, buf);
    expect(detectMacriumFormat(v7)).toBe('mrimg-v7');
    // A trailer alone is not a parseable image: the metadata offset field is
    // empty, so opening it must fail (it is no longer treated as an
    // unsupported-but-detectable container).
    expect(() => readMacriumImage(v7)).toThrow();
  });

  // The user-provided real .mrimg lives next to the repo root. When present it
  // doubles as an end-to-end check of the trailer/footer/index/QuickLZ path.
  const v7Sample =
    process.env.OPBS_V7_SAMPLE ??
    path.join(__dirname, '..', '..', '14CC07500E727036-00-00.mrimg');
  const v7SamplePresent = fs.existsSync(v7Sample);
  describe.skipIf(!v7SamplePresent)('mrimg-v7 container (real sample)', () => {
    it('parses the trailer, footer, indexes and reports the source disk', () => {
      const info = readMacriumImage(v7Sample);
      expect(info.format).toBe('mrimg-v7');
      expect(info.compression.method).toBe('quicklz');
      expect(info.partitions.length).toBe(1);
      const part = info.partitions[0];
      expect(part.blockCount).toBe(256);
      expect(part.blockSize).toBe(65536);
      expect(part.blocks.length).toBe(256);
      expect(part.blocks[0].filePosition).toBe(0);
      expect(info.netbiosName).toBeTruthy();
      expect(info.disks[0].diskFormat).toBeTruthy();
    });

    it('decodes a stored block through the partition reader with a valid hash', () => {
      const info = readMacriumImage(v7Sample);
      const reader = openMacriumPartitionReader(info, 0);
      expect(reader.size).toBe(256 * 65536);
      const head = reader.read(0, 64);
      expect(head.length).toBe(64);
      // Every stored block must pass the per-block MD5 gate; a read spanning
      // several blocks therefore throws on any corruption.
      expect(() => reader.read(0, 128 * 1024)).not.toThrow();
    });

    it('a full sample is never flagged as unsupported', () => {
      const info = readMacriumImage(v7Sample);
      expect(info.encryption.enable).toBe(false);
      expect(info.splitFile).toBe(false);
      expect(info.deltaIndex).toBe(false);
      expect(macriumUnsupportedReason(info)).toBeNull();
    });

    it('detects encryption from the footer XML', () => {
      const src = fs.readFileSync(v7Sample);
      const at = src.toString('latin1').indexOf('<aes>0</aes>');
      expect(at).toBeGreaterThan(-1);
      const buf = Buffer.from(src);
      buf.write('<aes>3</aes>', at, 'latin1');
      const tmp = path.join(fixtureDir, 'ENCTEST-00-00.mrimg');
      fs.writeFileSync(tmp, buf);
      const info = readMacriumImage(tmp);
      expect(info.encryption.enable).toBe(true);
      expect(macriumUnsupportedReason(info)).toMatch(/password-protected/);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(/password/);
    });

    it('detects an incremental chain from <method> and from the filename', () => {
      const src = fs.readFileSync(v7Sample);
      const at = src.toString('latin1').indexOf('<method>3</method>');
      expect(at).toBeGreaterThan(-1);
      const buf = Buffer.from(src);
      buf.write('<method>1</method>', at, 'latin1');
      const tmp = path.join(fixtureDir, 'METHTEST-00-00.mrimg');
      fs.writeFileSync(tmp, buf);
      const info = readMacriumImage(tmp);
      expect(info.deltaIndex).toBe(true);
      expect(macriumUnsupportedReason(info)).toMatch(/delta-incremental/);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);

      // Filename alone: increment number 01 marks a chain member.
      const tmp2 = path.join(fixtureDir, 'INCRTEST-01-00.mrimg');
      fs.copyFileSync(v7Sample, tmp2);
      const info2 = readMacriumImage(tmp2);
      expect(info2.deltaIndex).toBe(true);
      expect(macriumUnsupportedReason(info2)).toMatch(/delta-incremental/);
    });

    it('detects split parts from a sibling file on disk', () => {
      const tmp = path.join(fixtureDir, 'SPLITTEST-00-00.mrimg');
      fs.copyFileSync(v7Sample, tmp);
      fs.writeFileSync(path.join(fixtureDir, 'SPLITTEST-00-01.mrimg'), Buffer.alloc(0));
      const info = readMacriumImage(tmp);
      expect(info.splitFile).toBe(true);
      expect(macriumUnsupportedReason(info)).toMatch(/split/);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow('split');
    });
  });
});