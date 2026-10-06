import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseEfsAttribute,
  parseBootSector,
  readFileRecords,
  buildTree,
  readFileData,
  readFileRange,
  EfsEncryptedError
} from '../../src/main/imaging/fs/ntfs';
import { listDirectory, readPath, extractPath } from '../../src/main/imaging/fs/file-browse';
import { buildNtfsVolume, CLUSTER, efsAttrValue, EFS_TEST_THUMBPRINT } from '../helpers/ntfs-fixture';

function efsSession() {
  const reader = buildNtfsVolume({ includeEfsFile: true });
  const layout = parseBootSector(reader);
  const records = readFileRecords(reader, layout);
  return {
    filesystem: 'ntfs',
    imagePath: 'mem',
    chain: ['mem'],
    partitionIndex: 0,
    reader,
    layout,
    records: new Map(records.map((r) => [r.recordNumber, r])),
    children: buildTree(records),
    rootId: 5
  };
}

describe('$EFS attribute parsing', () => {
  it('decodes the on-disk header and each principal\'s decryption field', () => {
    const blob = efsAttrValue([
      { name: 'alice@example' },
      { name: 'recovery@example', thumbprint: '00112233445566778899aabbccddeeff00112233' }
    ]);
    const info = parseEfsAttribute(blob);
    expect(info.version).toBe(2);
    expect(info.entries).toHaveLength(2);
    expect(info.entries[0].name).toBe('alice@example');
    expect(info.entries[0].thumbprint).toBe(EFS_TEST_THUMBPRINT);
    expect(info.entries[0].credentialType).toBe(3);
    expect(info.entries[0].efek).toHaveLength(128);
    expect(info.entries[1].name).toBe('recovery@example');
    expect(info.entries[1].thumbprint).toBe('00112233445566778899aabbccddeeff00112233');
    expect(info.recovery).toEqual([]);
    expect(blob.readUInt32LE(0)).toBe(blob.length);
    expect(blob.readUInt32LE(8)).toBe(2);
  });

  it('splits data decryption fields from recovery fields', () => {
    const blob = efsAttrValue([{ name: 'owner@example' }], [{ name: 'agent@example' }]);
    const info = parseEfsAttribute(blob);
    expect(info.entries.map((e) => e.name)).toEqual(['owner@example']);
    expect(info.recovery.map((e) => e.name)).toEqual(['agent@example']);
    expect(info.recovery[0].thumbprint).toBe(EFS_TEST_THUMBPRINT);
  });

  it('keeps a supplied wrapped key and thumbprint verbatim', () => {
    const efek = Buffer.alloc(256, 0xa5);
    const blob = efsAttrValue([{ name: 'bob', efek, thumbprint: 'deadbeef'.repeat(5) }]);
    const info = parseEfsAttribute(blob);
    expect(info.entries[0].efek.equals(efek)).toBe(true);
    expect(info.entries[0].thumbprint).toBe('deadbeef'.repeat(5));
  });

  it('survives truncated or malformed blobs without throwing', () => {
    expect(parseEfsAttribute(Buffer.alloc(4))).toEqual({ version: 0, entries: [], recovery: [] });
    expect(parseEfsAttribute(Buffer.alloc(0x4c))).toEqual({ version: 0, entries: [], recovery: [] });
    // Header claims a smaller blob than provided.
    const short = Buffer.alloc(0x60);
    short.writeUInt32LE(2, 8);
    short.writeUInt32LE(0x4c, 0);
    expect(parseEfsAttribute(short).entries).toEqual([]);
    // Field length overshoots the blob end -> iteration stops gracefully.
    const bad = Buffer.alloc(0x60);
    bad.writeUInt32LE(0x60, 0);
    bad.writeUInt32LE(2, 8);
    bad.writeUInt32LE(0x4c, 0x40);
    bad.writeUInt32LE(1, 0x4c);
    bad.writeUInt32LE(0xffff, 0x50);
    expect(parseEfsAttribute(bad).entries).toEqual([]);
    // A truncated field yields an entry with no key material rather than a throw.
    const partial = Buffer.concat([efsAttrValue([{ name: 'x' }]).subarray(0, 0x50)]);
    const info = parseEfsAttribute(partial);
    expect(info.entries.length).toBeLessThanOrEqual(1);
    for (const entry of [...info.entries, ...info.recovery]) {
      expect(entry.efek.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('ignores a zeroed or absent field array', () => {
    const blob = efsAttrValue([]);
    expect(parseEfsAttribute(blob).entries).toEqual([]);
    const zeroed = Buffer.alloc(0x4c);
    zeroed.writeUInt32LE(0x4c, 0);
    expect(parseEfsAttribute(zeroed).entries).toEqual([]);
  });
});

describe('EFS-encrypted files across the browse path', () => {
  it('flags an encrypted file from the parsed MFT and the directory tree', () => {
    const session = efsSession();
    const rec = session.records.get(9)!;
    expect(rec.isEncrypted).toBe(true);
    expect(rec.efs?.entries[0].name).toBe('alice@example');
    expect(rec.efs?.version).toBe(2);

    const node = buildTree([...session.records.values()]).get(5)!.find((n) => n.name === 'secret.txt')!;
    expect(node.isEncrypted).toBe(true);
  });

  it('leaves plaintext reads of normal files untouched', () => {
    const session = efsSession();
    const hello = session.records.get(6)!;
    expect(hello.isEncrypted).toBeUndefined();
    expect(readFileData(session.reader, session.layout, hello).toString()).toBe('Hello, OPBS world!');
    const big = session.records.get(8)!;
    expect(big.isEncrypted).toBeUndefined();
    expect(readFileData(session.reader, session.layout, big).length).toBe(2 * CLUSTER);
  });

  it('surfaces isEncrypted through listDirectory', () => {
    const session = efsSession();
    const secret = listDirectory(session, '').find((n) => n.name === 'secret.txt')!;
    expect(secret.isEncrypted).toBe(true);
    expect(listDirectory(session, '').find((n) => n.name === 'hello.txt')!.isEncrypted).toBeUndefined();
  });

  it('refuses to hand out ciphertext as if it were plain', () => {
    const session = efsSession();
    const rec = session.records.get(9)!;
    expect(() => readFileData(session.reader, session.layout, rec)).toThrow(EfsEncryptedError);
    try {
      readFileData(session.reader, session.layout, rec);
      expect.unreachable();
    } catch (e) {
      expect((e as EfsEncryptedError).code).toBe('EFS_ENCRYPTED');
      expect((e as Error).message).toMatch(/EFS-encrypted/);
      expect((e as Error).message).toMatch(/alice@example|record 9/);
    }
  });

  it('refuses ranged reads of an encrypted file too', () => {
    const session = efsSession();
    const rec = session.records.get(9)!;
    expect(() => readFileRange(session.reader, session.layout, rec, 0, 16)).toThrow(EfsEncryptedError);
  });

  it('readPath rejects an encrypted file', () => {
    expect(() => readPath(efsSession(), 'secret.txt')).toThrow(/EFS-encrypted/);
  });

  it('extractPath rejects an encrypted file before writing anything', () => {
    expect(() => extractPath(efsSession(), 'secret.txt', '__nope__')).toThrow(EfsEncryptedError);
    expect(fs.existsSync('__nope__')).toBe(false);
  });

  it('folder extraction skips the encrypted file instead of aborting', () => {
    const session = efsSession();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-efs-'));
    try {
      // hello.txt + docs/big.bin extract; secret.txt is skipped (no local key
      // can unwrap its FEK), and the walk must not throw part-way.
      expect(extractPath(session, '', out)).toBe(4);
      expect(fs.readFileSync(path.join(out, 'hello.txt'), 'utf8')).toBe('Hello, OPBS world!');
      expect(fs.existsSync(path.join(out, 'docs', 'big.bin'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'secret.txt'))).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
