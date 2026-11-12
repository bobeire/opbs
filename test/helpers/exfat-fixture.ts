import { PartitionReader } from '../../src/main/imaging/image-browse';
import { openBrowseFromReader } from '../../src/main/imaging/fs/file-browse';

/** A reader over an in-memory volume. */
export const readerOf = (buf: Buffer): PartitionReader =>
  ({ size: buf.length, read: (offset: number, length: number) => buf.subarray(offset, offset + length) }) as PartitionReader;

const SECTOR = 512;
export const CLUSTER = 4096;
const FAT = 8 * SECTOR;
const HEAP = 16 * SECTOR;
const EOF = 0xfffffff8;

export interface ExEntry {
  name: string;
  dir?: boolean;
  start: number;
  length: number;
  noFatChain?: boolean;
  validDataLength?: number;
  date?: number;
  time?: number;
}

export class ExfatVolume {
  readonly buf: Buffer;

  constructor(readonly clusterCount: number) {
    this.buf = Buffer.alloc(HEAP + (clusterCount + 2) * CLUSTER);
    const b = this.buf;
    b.write('EXFAT   ', 3, 'ascii');
    b[0x40] = 0x01;
    b.writeUInt32LE(8, 0x50);
    b.writeUInt32LE(16, 0x58);
    b.writeUInt32LE(clusterCount, 0x5c);
    b.writeUInt32LE(2, 0x60);
    b.writeUInt8(9, 0x6c);
    b.writeUInt8(3, 0x6d);
    b[0x1fe] = 0x55;
    b[0x1ff] = 0xaa;
    this.setFat(2, EOF); // root directory: one cluster
  }

  setFat(cluster: number, value: number): void {
    this.buf.writeUInt32LE(value >>> 0, FAT + cluster * 4);
  }

  chain(...clusters: number[]): void {
    clusters.forEach((c, i) => this.setFat(c, i + 1 < clusters.length ? clusters[i + 1] : EOF));
  }

  offset(cluster: number): number {
    return HEAP + (cluster - 2) * CLUSTER;
  }

  putData(cluster: number, data: Buffer): void {
    data.copy(this.buf, this.offset(cluster));
  }

  /** Write one directory entry set at `at`; returns the offset just past it. */
  putEntry(at: number, e: ExEntry): number {
    const nameEntries = Math.ceil(e.name.length / 15);
    const b = this.buf;
    b[at] = 0x85;
    b[at + 1] = 1 + nameEntries;
    b.writeUInt16LE(e.dir ? 0x10 : 0x20, at + 4);
    b.writeUInt16LE(e.time ?? 0, at + 0x0c);
    b.writeUInt16LE(e.date ?? 0, at + 0x0e);
    b[at + 32] = 0xc0;
    b[at + 32 + 1] = 0x01 | (e.noFatChain ? 0x02 : 0);
    b[at + 32 + 3] = e.name.length;
    b.writeBigUInt64LE(BigInt(e.validDataLength ?? e.length), at + 32 + 0x08);
    b.writeUInt32LE(e.start, at + 32 + 0x14);
    b.writeBigUInt64LE(BigInt(e.length), at + 32 + 0x18);
    for (let n = 0; n < nameEntries; n++) {
      const off = at + 64 + n * 32;
      b[off] = 0xc1;
      for (let c = 0; c < 15; c++) {
        const ch = e.name.charCodeAt(n * 15 + c);
        if (!Number.isNaN(ch)) b.writeUInt16LE(ch, off + 2 + c * 2);
      }
    }
    return at + 32 * (2 + nameEntries);
  }

  putEntries(cluster: number, entries: ExEntry[]): void {
    let at = this.offset(cluster);
    for (const e of entries) at = this.putEntry(at, e);
  }

  session() {
    return openBrowseFromReader('exfat.opbs', 0, readerOf(this.buf));
  }
}
