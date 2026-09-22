import { describe, it, expect } from 'vitest';
import {
  parseEfsAttribute,
  parseBootSector,
  readFileRecords,
  buildTree,
  readFileData,
  EfsEncryptedError
} from '../../src/main/imaging/fs/ntfs';
import { listDirectory, readPath, extractPath } from '../../src/main/imaging/fs/file-browse';
import { buildNtfsVolume, CLUSTER, efsAttrValue } from '../helpers/ntfs-fixture';

const GUID0 = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc];

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
  it('decodes a canonical EFS blob with per-principal entries and key info', () => {
    const blob = efsAttrValue([
      { name: 'alice@example', guid: GUID0, algId: 0x6610, fekBits: 256 },
      { name: 'recovery@example', algId: 0x6610, fekBits: 256 }
    ]);
    const info = parseEfsAttribute(blob);
    expect(info.version).toBe(0);
    expect(info.entries).toHaveLength(2);
    expect(info.entries[0].name).toBe('alice@example');
    expect(info.entries[0].keyType).toBe(0);
    expect(info.entries[0].algId).toBe(0x6610);
    expect(info.entries[0].fekBits).toBe(256);
    expect(info.entries[0].containerGuid).toBe('aabbccdd-1122-3344-5566-778899aabbcc');
    expect(info.entries[1].name).toBe('recovery@example');
  });

  it('survives truncated or malformed blobs without throwing', () => {
    expect(parseEfsAttribute(Buffer.alloc(4))).toEqual({ version: 0, entries: [] });
    // Header claims a smaller blob than provided.
    const short = Buffer.alloc(0x18);
    short.writeUInt32LE(0, 0);
    short.writeUInt32LE(0x1c, 4);
    expect(parseEfsAttribute(short).entries).toEqual([]);
    // Entry length overshoots the blob end -> iteration stops gracefully.
    const bad = Buffer.alloc(0x30);
    bad.writeUInt32LE(0, 0);
    bad.writeUInt32LE(0x30, 4);
    bad.writeUInt32LE(0xffff, 0x18);
    expect(parseEfsAttribute(bad)).toEqual({ version: 0, entries: [] });
  });

  it('falls back to a key-info offset relative to the entry', () => {
    const blob = efsAttrValue([{ name: 'bob@example' }]);
    blob.writeUInt32LE(3, 0x1c); // absolute offset 3 is invalid; relative 0x18+3 is inside the blob
    const info = parseEfsAttribute(blob);
    expect(info.entries).toHaveLength(1);
    expect(info.entries[0].name).toBe('bob@example');
    // Relative fallback read the entry bytes as key info without crashing.
    expect(info.entries[0].keyInfoOffset).toBe(0x1b);
  });
});

describe('EFS-encrypted files across the browse path', () => {
  it('flags an encrypted file from the parsed MFT and the directory tree', () => {
    const session = efsSession();
    const rec = session.records.get(9)!;
    expect(rec.isEncrypted).toBe(true);
    expect(rec.efs?.entries[0].name).toBe('alice@example');

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
    }
  });

  it('readPath rejects an encrypted file', () => {
    expect(() => readPath(efsSession(), 'secret.txt')).toThrow(/EFS-encrypted/);
  });

  it('extractPath rejects an encrypted file before writing anything', () => {
    expect(() => extractPath(efsSession(), 'secret.txt', '__nope__')).toThrow(EfsEncryptedError);
  });
});