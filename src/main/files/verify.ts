import * as fs from 'fs';
import * as path from 'path';
import { loadHeader, resolveRepoKey, type RepoKeyOptions } from '../imaging/repository';
import {
  activeSnapshotRecords,
  fileCatalogExists,
  loadFileCatalog,
  verifyFileCatalogChain,
  verifyFileCatalogSignatures
} from './catalog';
import {
  chunkAad,
  decryptBuffer,
  deriveFileKeys,
  fileRoots,
  objectPath,
  sha256
} from './crypto';
import { readEncryptedManifest } from './manifest';
import type {
  FileCatalogRecord,
  FileSnapshotEntry,
  FileSnapshotManifest,
  FileSnapshotSummary,
  FileVerifyProblem,
  FileVerifyResult
} from './types';

/** Verify the signed catalog and the encrypted snapshot objects it references. */
export async function verifyFileSnapshots(
  repoDir: string,
  opts: RepoKeyOptions & { id?: string; fast?: boolean } = {}
): Promise<FileVerifyResult> {
  const problems: FileVerifyProblem[] = [];
  const snapshots: FileSnapshotSummary[] = [];
  let signaturesVerified = false;

  if (!fileCatalogExists(repoDir)) {
    return { ok: true, problems, snapshots, signaturesVerified };
  }

  let records: FileCatalogRecord[];
  try {
    records = loadFileCatalog(repoDir);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: 'catalog', detail: (error as Error).message }],
      snapshots,
      signaturesVerified
    };
  }
  const chainError = verifyFileCatalogChain(records);
  if (chainError) {
    return { ok: false, problems: [{ kind: 'catalog', detail: chainError }], snapshots, signaturesVerified };
  }

  let key: Buffer;
  try {
    key = resolveRepoKey(loadHeader(repoDir), opts);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: 'signature', detail: (error as Error).message }],
      snapshots,
      signaturesVerified
    };
  }
  const keys = deriveFileKeys(key);
  const signatureError = verifyFileCatalogSignatures(records, keys.catalog);
  if (signatureError) {
    problems.push({ kind: 'signature', detail: signatureError });
  } else {
    signaturesVerified = true;
  }

  const active = activeSnapshotRecords(records);
  if (opts.id && !active.some((record) => record.id === opts.id)) {
    problems.push({ kind: 'missing', detail: `No active file snapshot with id ${opts.id}` });
  }
  const selected = opts.id ? active.filter((record) => record.id === opts.id) : active;
  const referencedChunks = new Set<string>();

  for (const record of active) {
    const decoded = safeReadManifest(repoDir, record.id, keys.enc, problems);
    if (decoded) {
      for (const chunk of decoded.manifest.entries.flatMap((entry) => entry.chunks)) {
        referencedChunks.add(chunk.sha256);
      }
    }
  }

  for (const record of selected) {
    snapshots.push({
      id: record.id,
      createdAt: record.at,
      files: record.files ?? 0,
      bytes: record.bytes ?? 0,
      ...(record.lockUntil ? { lockUntil: record.lockUntil } : {})
    });
    if (!record.snapshotFile) {
      problems.push({ kind: 'manifest', detail: `Snapshot ${record.id} has no manifest file record` });
      continue;
    }
    let manifest: FileSnapshotManifest;
    try {
      manifest = readEncryptedManifest(repoDir, record.id, keys.enc).manifest;
    } catch (error) {
      problems.push({ kind: 'manifest', detail: (error as Error).message });
      continue;
    }

    if (record.manifestSha256 && record.encryptedSha256) {
      try {
        const decoded = readEncryptedManifest(repoDir, record.id, keys.enc);
        if (decoded.plaintextSha256 !== record.manifestSha256) {
          problems.push({
            kind: 'manifest',
            detail: `Snapshot ${record.id}: plaintext manifest hash differs from the catalog`
          });
        }
        if (decoded.encryptedSha256 !== record.encryptedSha256) {
          problems.push({
            kind: 'manifest',
            detail: `Snapshot ${record.id}: encrypted manifest was modified`
          });
        }
      } catch (error) {
        problems.push({ kind: 'manifest', detail: (error as Error).message });
      }
    }

    const uniqueChunks = uniqueFileChunks(manifest.entries);
    for (const chunk of uniqueChunks) {
      const file = objectPath(repoDir, chunk.sha256);
      if (!fs.existsSync(file)) {
        problems.push({ kind: 'missing', detail: `Snapshot ${record.id}: missing chunk ${chunk.sha256}` });
        continue;
      }
      if (opts.fast) {
        const expectedSize = 1 + 12 + 16 + chunk.size;
        let size: number;
        try {
          size = fs.statSync(file).size;
        } catch {
          size = -1;
        }
        if (size !== expectedSize) {
          problems.push({
            kind: 'chunk',
            detail: `Snapshot ${record.id}: chunk ${chunk.sha256} has size ${size}, expected ${expectedSize}`
          });
        }
        continue;
      }
      try {
        const blob = fs.readFileSync(file);
        const plaintext = decryptBuffer(blob, keys.enc, chunkAad(chunk.sha256));
        if (plaintext.length !== chunk.size || sha256(plaintext) !== chunk.sha256) {
          problems.push({
            kind: 'chunk',
            detail: `Snapshot ${record.id}: chunk ${chunk.sha256} content hash mismatch`
          });
        }
      } catch (error) {
        problems.push({
          kind: 'chunk',
          detail: `Snapshot ${record.id}: chunk ${chunk.sha256}: ${(error as Error).message}`
        });
      }
    }
  }

  // Orphan detection is independent of the selected snapshot: a stray object
  // or manifest is still worth reporting when the whole repository is checked.
  if (!opts.id) {
    try {
      const activeIds = new Set(active.map((record) => record.id));
      for (const name of fs.readdirSync(fileRoots(repoDir).snapshots)) {
        const id = name.replace(/\.opbsfiles$/i, '');
        if (name.endsWith('.opbsfiles') && !activeIds.has(id)) {
          problems.push({ kind: 'orphan', detail: `File snapshot not in catalog: ${name}` });
        }
      }
      const objects = fileRoots(repoDir).objects;
      for (const bucket of fs.readdirSync(objects)) {
        for (const name of fs.readdirSync(path.join(objects, bucket))) {
          const sha = name.replace(/\.chunk$/i, '').toLowerCase();
          if (name.endsWith('.chunk') && !referencedChunks.has(sha)) {
            problems.push({ kind: 'orphan', detail: `Unreferenced file chunk: ${sha}` });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        problems.push({ kind: 'catalog', detail: `Could not scan file artifacts: ${(error as Error).message}` });
      }
    }
  }

  return { ok: problems.length === 0, problems, snapshots, signaturesVerified };
}

function safeReadManifest(
  repoDir: string,
  id: string,
  encKey: Buffer,
  problems: FileVerifyProblem[]
): { manifest: { entries: FileSnapshotEntry[] } } | undefined {
  try {
    return readEncryptedManifest(repoDir, id, encKey);
  } catch (error) {
    problems.push({ kind: 'manifest', detail: (error as Error).message });
    return undefined;
  }
}

function uniqueFileChunks(entries: readonly FileSnapshotEntry[]): Array<{ sha256: string; size: number }> {
  const seen = new Set<string>();
  const chunks: Array<{ sha256: string; size: number }> = [];
  for (const entry of entries) {
    for (const chunk of entry.chunks) {
      if (seen.has(chunk.sha256)) continue;
      seen.add(chunk.sha256);
      chunks.push(chunk);
    }
  }
  return chunks;
}

/** Used by CLI listing and pruning to open one manifest with a resolved key. */
export function loadSnapshotManifest(
  repoDir: string,
  id: string,
  encKey: Buffer
): ReturnType<typeof readEncryptedManifest> {
  return readEncryptedManifest(repoDir, id, encKey);
}
