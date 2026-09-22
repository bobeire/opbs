import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { handleBridgeRequest, BridgeRequest } from '../../src/main/imaging/fs/mount-fs';
import { buildTree, NtfsFile } from '../../src/main/imaging/fs/ntfs';
import { BrowseSession } from '../../src/main/imaging/fs/file-browse';

const NATIVE_PATH = path.join(__dirname, '../../src/native/build/Release/opbs_native.node');

interface NativeWinFsp {
  winfspAvailable: () => boolean;
  winfspMount: (config: Record<string, unknown>, handler: () => unknown) => { id: number; mountPoint: string };
  winfspUnmount: (id: number) => boolean;
}

let native: NativeWinFsp | null = null;

/** Build a minimal browse session over three NTFS records (root, a directory,
 *  and a resident file) so the bridge handler can be exercised without reading
 *  real disk blocks. */
function fakeSession(): BrowseSession {
  const rootRec: NtfsFile = {
    recordNumber: 5,
    inUse: true,
    isDirectory: true,
    hardLinkCount: 1,
    name: { name: '', parentRecord: 5, namespace: 1 },
    size: 0,
    allocatedSize: 0,
    dataRuns: [],
    residentData: Buffer.alloc(0),
    dataVcn: 0,
    streams: new Map(),
    created: 133500000000000000,
    modified: 133500000000000000
  };
  const winDir: NtfsFile = {
    recordNumber: 10,
    inUse: true,
    isDirectory: true,
    hardLinkCount: 1,
    name: { name: 'Windows', parentRecord: 5, namespace: 1 },
    size: 0,
    allocatedSize: 0,
    dataRuns: [],
    residentData: Buffer.alloc(0),
    dataVcn: 0,
    streams: new Map(),
    created: 133500000000000000,
    modified: 133500000100000000
  };
  const fileRec: NtfsFile = {
    recordNumber: 20,
    inUse: true,
    isDirectory: false,
    hardLinkCount: 1,
    name: { name: 'notes.txt', parentRecord: 10, namespace: 1 },
    size: 13,
    allocatedSize: 13,
    dataRuns: [],
    residentData: Buffer.from('hello world\n'),
    dataVcn: 0,
    streams: new Map(),
    created: 133500000000000000,
    modified: 133500000200000000
  };
  const records = new Map<number, NtfsFile>();
  for (const rec of [rootRec, winDir, fileRec]) records.set(rec.recordNumber, rec);
  const children = buildTree([rootRec, winDir, fileRec]);

  return {
    filesystem: 'ntfs',
    imagePath: 'fake.opbs',
    chain: ['fake.opbs'],
    partitionIndex: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reader: {} as any,
    layout: {
      bytesPerSector: 512,
      sectorsPerCluster: 1,
      clusterSize: 512,
      mftStartCluster: 0,
      mftMirrStartCluster: 0,
      fileRecordSize: 1024
    },
    records,
    children,
    rootId: 5
  };
}

describe('mount-fs bridge handler', () => {
  it('stats the volume root', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'stat', path: '\\' });
    expect(reply.status).toBe(0);
    expect(reply.attributes).toBe(0x10);
    expect(reply.indexNumber).toBe('5');
  });

  it('stats a file and returns 64-bit times as strings', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'stat', path: '\\Windows\\notes.txt' });
    expect(reply.status).toBe(0);
    expect(reply.size).toBe(13);
    expect(reply.creationTime).toBeTypeOf('string');
    expect(reply.lastWriteTime).toBeTypeOf('string');
  });

  it('returns STATUS_OBJECT_NAME_NOT_FOUND for a missing path', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'stat', path: '\\nope' });
    expect(reply.status).toBe(0xc0000034);
  });

  it('reads a bounded byte range from a file', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'read', path: '\\Windows\\notes.txt', offset: 0, length: 5 });
    expect(reply.status).toBe(0);
    expect(Buffer.from(reply.data as string, 'base64').toString()).toBe('hello');
  });

  it('clamps a read that runs past the end of the file', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'read', path: '\\Windows\\notes.txt', offset: 6, length: 100 });
    expect(reply.status).toBe(0);
    expect(Buffer.from(reply.data as string, 'base64').toString()).toBe('world\n');
  });

  it('refuses to read a directory', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'read', path: '\\Windows', offset: 0, length: 10 });
    expect(reply.status).toBe(0xc0000103);
  });

  it('lists a directory one level deep', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'readDir', path: '\\Windows' });
    expect(reply.status).toBe(0);
    expect(Array.isArray(reply.entries)).toBe(true);
    const names = (reply.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('notes.txt');
  });

  it('lists the volume root', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'readDir', path: '\\' });
    expect(reply.status).toBe(0);
    const names = (reply.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('Windows');
  });

  it('rejects reading a directory listing of a file', () => {
    const session = fakeSession();
    const reply = handleBridgeRequest(session, { op: 'readDir', path: '\\Windows\\notes.txt' });
    expect(reply.status).toBe(0xc00000ba);
  });
});

describe('native WinFsp exports', () => {
  beforeAll(() => {
    try {
      if (fs.existsSync(NATIVE_PATH)) {
        native = require(NATIVE_PATH) as NativeWinFsp;
      }
    } catch {
      native = null;
    }
  });

  it('exposes winfspAvailable/winfspMount/winfspUnmount', () => {
    if (!native) {
      // Addon missing (fresh clone without a native build): skip the assertion.
      return;
    }
    expect(typeof native.winfspAvailable).toBe('function');
    expect(typeof native.winfspMount).toBe('function');
    expect(typeof native.winfspUnmount).toBe('function');
  });

  it('reports WinFsp availability as a boolean', () => {
    if (!native) return;
    const available = native.winfspAvailable();
    expect(typeof available).toBe('boolean');
    // WinFsp may or may not be installed; the important part is that the
    // check works and never throws.
  });
});