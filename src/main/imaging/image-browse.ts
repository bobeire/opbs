import { readImageInfo, readFrameFromImage, decompressBlock, ImageInfo, PartitionEntryMeta, BlockRecord, DEFAULT_BLOCK_SIZE, resolveVolumePath } from './image-format';

/** A sequential byte reader over a partition's raw bytes. */
export interface PartitionReader {
  readonly size: number;
  read(offset: number, length: number): Buffer;
}

/**
 * Reads partition bytes directly from a `.opbs` image chain by decompressing
 * only the blocks that cover a requested range. Blocks are addressed by their
 * source `blockIndex` within the partition (block N covers partition bytes
 * [N*blockSize, (N+1)*blockSize)); for a chain the newest source containing a
 * block wins, so full + delta chains resolve correctly.
 */
export class ChainPartitionReader implements PartitionReader {
  private readonly blockSize: number;
  private readonly key?: Buffer;
  private readonly sources: Array<{ imagePath: string; info: ImageInfo; byIndex: Map<number, BlockRecord> }>;
  private readonly cache = new Map<number, Buffer>();
  readonly size: number;

  constructor(sources: Array<{ imagePath: string; info: ImageInfo }>, partition: PartitionEntryMeta, key?: Buffer) {
    this.blockSize = sources[0]?.info.header.blockSize || DEFAULT_BLOCK_SIZE;
    this.key = key;
    this.size = partition.size;
    this.sources = sources.map(({ imagePath, info }) => {
      const byIndex = new Map<number, BlockRecord>();
      for (const block of info.blocks) {
        if (block.partitionIndex === partition.partitionIndex) {
          byIndex.set(block.blockIndex, block);
        }
      }
      return { imagePath, info, byIndex };
    });
  }

  read(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error(`Partition read out of bounds: ${offset}+${length} > ${this.size}`);
    }
    const out = Buffer.alloc(length);
    let written = 0;
    let pos = offset;
    while (written < length) {
      const blockIndex = Math.floor(pos / this.blockSize);
      const within = pos % this.blockSize;
      const block = this.getBlock(blockIndex);
      const avail = Math.min(block.length - within, length - written);
      block.copy(out, written, within, within + avail);
      written += avail;
      pos += avail;
    }
    return out;
  }

  private getBlock(blockIndex: number): Buffer {
    const cached = this.cache.get(blockIndex);
    if (cached) return cached;
    // Newest source (last in the chain) that stores this block wins.
    let selected: { imagePath: string; info: ImageInfo; block: BlockRecord } | null = null;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const block = this.sources[i].byIndex.get(blockIndex);
      if (block) {
        selected = { imagePath: this.sources[i].imagePath, info: this.sources[i].info, block };
        break;
      }
    }
    if (!selected) {
      throw new Error(
        `No block ${blockIndex} for partition in the image chain ` +
          `(the backup may have skipped free space, or the image is incomplete)`
      );
    }
    const blockImagePath = selected.block.volumeIndex != null
      ? resolveVolumePath(selected.imagePath, selected.block.volumeIndex)
      : selected.imagePath;
    const frame = readFrameFromImage(blockImagePath, selected.block.fileOffset, selected.info.header.cipherId, this.key);
    const raw = decompressBlock(frame.comp, selected.info.header.compressionId);
    this.cache.set(blockIndex, raw);
    return raw;
  }
}

/** Read the info for every image in a chain (root first, deltas after). */
export function readChainInfos(chain: string[]): Array<{ imagePath: string; info: ImageInfo }> {
  return chain.map((imagePath) => ({ imagePath, info: readImageInfo(imagePath) }));
}

/**
 * Build a PartitionReader over a partition of the given chain of images.
 * `chain` must be root-first (full image then deltas in application order).
 */
export function partitionReaderForChain(
  chain: string[],
  partitionIndex: number,
  key?: Buffer
): { reader: PartitionReader; partition: PartitionEntryMeta } {
  const sources = readChainInfos(chain);
  const info = sources[0].info;
  const partition = info.partitions.find((p) => p.partitionIndex === partitionIndex);
  if (!partition) {
    throw new Error(`Image chain has no partition ${partitionIndex}`);
  }
  return { reader: new ChainPartitionReader(sources, partition, key), partition };
}

export interface BrowseNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  record: number;
  parentRecord: number;
  modified?: number;
}

export interface BrowseTree {
  partitionIndex: number;
  root: BrowseNode;
  children: Map<number, BrowseNode[]>;
  byRecord: Map<number, BrowseNode>;
}
