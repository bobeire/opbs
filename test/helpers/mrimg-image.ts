import { createHash } from 'crypto';

/**
 * Shared builders for synthetic `.mrimgx` (Reflect X) containers. The layout
 * mirrors the real format: [data blocks] [root $JSON] [disk $TRACK0]
 * [partition $INDEX] [footer with metadata offset + magic].
 */

export const MAGIC_X = 'MACRIUM_FILE';
export const BLOCK_JSON = '$JSON   ';
export const BLOCK_INDEX = '$INDEX  ';

export function md5(buf: Buffer): Buffer {
  return createHash('md5').update(buf).digest();
}

export function buildBlock(name: string, body: Buffer, last = true): { header: Buffer; headerHash: Buffer } {
  const hdr = Buffer.alloc(32);
  Buffer.from(name, 'latin1').copy(hdr, 0);
  hdr.writeUInt32LE(body.length, 8);
  const digest = md5(body);
  digest.copy(hdr, 12);
  hdr[28] = last ? 1 : 0;
  return { header: hdr, headerHash: digest };
}

export function buildMrimgIndex(
  blocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }>
): Buffer {
  const buf = Buffer.alloc(4 + 4 + blocks.length * 30);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(blocks.length, 4);
  let off = 8;
  for (const b of blocks) {
    buf.writeBigInt64LE(BigInt(b.filePosition), off);
    b.md5.copy(buf, off + 8);
    buf.writeUInt32LE(b.storedLength, off + 24);
    buf.writeUInt16LE(0, off + 28);
    off += 30;
  }
  return buf;
}

export function buildMrimgxImage(
  partitionBlocks: Buffer[],
  tweak?: (json: any) => void
): {
  buffer: Buffer;
  partitionSize: number;
  blockSize: number;
} {
  const blockSize = 8192;
  const json = {
    _header: {
      imageid: '00000001',
      backup_type: 'full',
      backup_format: 'file_level',
      backup_time: 1600000000,
      index_file_position: 0, // placeholder, will patch
      split_file: false,
      delta_index: false,
      file_number: 0
    },
    _compression: { compression_method: 'zstd', compression_level: 'none' },
    _encryption: { enable: false },
    disks: [
      {
        _header: { disk_number: 0, disk_format: 'gpt' },
        _geometry: { disk_size: 500107862016 },
        partitions: [
          {
            _header: { block_size: blockSize, block_count: partitionBlocks.length, partition_number: 1 },
            _file_system: { type: 'NTFS', start: 0, lcn0_offset: 0, sectors_per_cluster: 8, volume_label: 'TEST' },
            _geometry: { start: 2048, end: 976768063, length: 976766016, boot_sector_offset: 0 },
            _partition_table_entry: { type: 7 }
          }
        ]
      }
    ]
  };

  tweak?.(json);

  // Data blocks are stored uncompressed.
  const rawBlocks = partitionBlocks;
  const totalDataLen = rawBlocks.reduce((s, b) => s + b.length, 0);
  let jsonBody = Buffer.from(JSON.stringify(json), 'utf8');

  // Layout: [data blocks] [root $JSON meta] [index metadata]:
  //   [disk meta group] [partition $INDEX meta group] [footer]
  const diskMetaBody = Buffer.alloc(16); // fake $TRACK0; unused by reader
  diskMetaBody.writeUInt32LE(0x55aa, 0);
  const diskMetaHeader = buildBlock('$TRACK0 ', diskMetaBody, true).header;

  // index_file_position points at the first index metadata group.
  let indexMetaStart = totalDataLen + 32 + jsonBody.length;
  json._header.index_file_position = indexMetaStart;
  jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  const shifted = totalDataLen + 32 + jsonBody.length;
  if (shifted !== indexMetaStart) {
    indexMetaStart = shifted;
    json._header.index_file_position = indexMetaStart;
    jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  }

  const rootMetaHeader = buildBlock(BLOCK_JSON, jsonBody, true).header;
  const rootMetaOff = totalDataLen;

  // Index with real data positions and hashes.
  const indexBlocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }> = [];
  let dataPos = 0;
  for (const raw of rawBlocks) {
    indexBlocks.push({ filePosition: dataPos, md5: md5(raw), storedLength: raw.length });
    dataPos += raw.length;
  }
  const partIndexBody = buildMrimgIndex(indexBlocks);
  const partMetaHeader = buildBlock(BLOCK_INDEX, partIndexBody, true).header;

  const fileSize =
    rawBlocks.reduce((s, b) => s + b.length, 0) +
    32 + jsonBody.length +
    32 + diskMetaBody.length +
    32 + partIndexBody.length +
    20;
  const fileBuf = Buffer.alloc(fileSize);
  let off = 0;
  for (const raw of rawBlocks) {
    raw.copy(fileBuf, off);
    off += raw.length;
  }
  rootMetaHeader.copy(fileBuf, off); off += rootMetaHeader.length;
  jsonBody.copy(fileBuf, off); off += jsonBody.length;
  diskMetaHeader.copy(fileBuf, off); off += diskMetaHeader.length;
  diskMetaBody.copy(fileBuf, off); off += diskMetaBody.length;
  partMetaHeader.copy(fileBuf, off); off += partMetaHeader.length;
  partIndexBody.copy(fileBuf, off); off += partIndexBody.length;

  // Footer
  const footerOff = fileBuf.length - 20;
  fileBuf.writeBigUInt64LE(BigInt(rootMetaOff), footerOff);
  Buffer.from(MAGIC_X, 'latin1').copy(fileBuf, footerOff + 8);

  return { buffer: fileBuf, partitionSize: rawBlocks.length * blockSize, blockSize };
}
