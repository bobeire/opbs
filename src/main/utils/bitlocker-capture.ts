import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { resolvePowershell } from './elevated';
import { isRecoveryProtectorType } from './bitlocker';
import { deriveImageKey, readImageInfo } from '../imaging/image-format';
import { logger } from './logger';

/**
 * BitLocker recovery-key custody for backups (Phase 1).
 *
 * Runs inside the elevated backup helper, which already holds the image's
 * derived encryption key in memory — so the capture chain never needs its own
 * elevation and, critically, the raw recovery passwords never touch a disk:
 *
 *   1. PowerShell (child of the already-elevated helper) prints protector
 *      types + recovery passwords to stdout, captured in memory only.
 *   2. The image's PBKDF2 key is stretched with HKDF-SHA256 under the fixed
 *      info string below, producing a key that C7 (the key viewer) re-derives
 *      from the user's backup passphrase via the same function.
 *   3. Each recovery password is sealed with AES-256-GCM (fresh 12-byte
 *      nonce per protector; the 16-byte auth tag is appended to the
 *      ciphertext) and written to `<image>.bitlocker.json`.
 *
 * The sidecar header is plain (version/timestamp/geometry only); only the
 * `protectors[].data` blobs are ciphertext. Invariant enforced by tests:
 * JSON.stringify(sidecar) must never contain a plaintext recovery password.
 */

export const BITLOCKER_HKDF_INFO = 'opbs-bitlocker-recovery-v1';

export interface CapturedProtector {
  type: string;
  /** Present only for recovery-password protectors. NEVER logged. */
  secret?: string;
}

export interface CapturedVolume {
  letter: string;
  /** FullyDecrypted / FullyEncrypted / ... ('' when the volume is locked). */
  conversion: string;
  protectionOn: boolean;
  locked: boolean;
  protos: CapturedProtector[];
}

export interface SidecarProtector {
  type: string;
  nonce: string;
  data: string;
}

export interface SidecarVolume {
  letter: string;
  label: string;
  offset: number;
  size: number;
  conversion: string;
  protectors: SidecarProtector[];
}

export interface BitlockerKeySidecar {
  version: 1;
  createdAt: string;
  volumes: SidecarVolume[];
}

export interface CapturePartition {
  label: string;
  offset: number;
  size: number;
  driveLetter?: string;
}

export interface SidecarBuildResult {
  sidecar: BitlockerKeySidecar | null;
  /** Encrypted volumes in the backup selection whose keys could not be stored. */
  skipped: Array<{ letter: string; reason: string }>;
}

/**
 * Capture query. Emits protector TYPE names plus — only for recovery-password
 * protectors — the password itself on `secret`. Child of the elevated helper,
 * so stdout stays in memory; this string is never written to a file.
 */
export const BITLOCKER_CAPTURE_PS = [
  `$ErrorActionPreference = 'Stop'`,
  `$result = @()`,
  `foreach ($v in @(Get-BitLockerVolume)) {`,
  `  $mp = [string]$v.MountPoint`,
  `  if (-not $mp) { continue }`,
  `  $protos = @()`,
  `  foreach ($kp in @($v.KeyProtector)) {`,
  `    if ($null -eq $kp) { continue }`,
  `    $typeName = [string]$kp.KeyProtectorType`,
  `    $entry = [pscustomobject][ordered]@{ type = $typeName }`,
  `    if ($typeName -eq 'RecoveryPassword' -and $kp.RecoveryPassword) {`,
  `      $entry = [pscustomobject][ordered]@{ type = $typeName; secret = [string]$kp.RecoveryPassword }`,
  `    }`,
  `    $protos += $entry`,
  `  }`,
  `  $result += [pscustomobject][ordered]@{`,
  `    letter = $mp.TrimEnd(':')`,
  `    conversion = if ($v.VolumeStatus) { [string]$v.VolumeStatus } else { '' }`,
  `    protectionOn = ([int]$v.ProtectionStatus -eq 1)`,
  `    locked = ([int]$v.LockStatus -eq 1)`,
  `    protos = $protos`,
  `  }`,
  `}`,
  `ConvertTo-Json -InputObject $result -Compress -Depth 6`
].join('\r\n');

/** HKDF-SHA256 stretch of the image key; identical on capture and read-back. */
export function deriveBitlockerSubkey(keyHex: string): Buffer {
  const key = Buffer.from(String(keyHex ?? ''), 'hex');
  if (key.length === 0) {
    throw new Error('BitLocker subkey derivation requires a hex image key.');
  }
  // Empty salt: HMAC zero-pads short keys to the block size, so this equals
  // the RFC 5869 default of HashLen zero bytes. Both sides call this function,
  // so capture and viewer can never disagree.
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), BITLOCKER_HKDF_INFO, 32));
}

/** Seal one recovery password. `data` = ciphertext + 16-byte GCM auth tag. */
export function encryptRecoverySecret(
  subkey: Buffer,
  plaintext: string
): { nonce: string; data: string } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64'), data: ciphertext.toString('base64') };
}

/** Reverse of encryptRecoverySecret; throws on tampering or wrong passphrase. */
export function decryptRecoverySecret(subkey: Buffer, nonceB64: string, dataB64: string): string {
  const nonce = Buffer.from(nonceB64, 'base64');
  const raw = Buffer.from(dataB64, 'base64');
  if (raw.length <= 16) {
    throw new Error('BitLocker protector blob is truncated.');
  }
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Parse the capture query's stdout. null = unparseable (never a valid-empty). */
export function parseCaptureJson(raw: string): CapturedVolume[] | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : null;
  if (!list) return null;
  const volumes: CapturedVolume[] = [];
  for (const entry of list as Array<Record<string, unknown> | null | undefined>) {
    if (!entry || typeof entry !== 'object') continue;
    const letter = String(entry.letter ?? '')
      .trim()
      .replace(/:$/, '')
      .toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    const protos: CapturedProtector[] = [];
    const rawProtos = Array.isArray(entry.protos) ? entry.protos : [];
    for (const p of rawProtos as Array<Record<string, unknown> | null | undefined>) {
      if (!p || typeof p !== 'object') continue;
      const type = String(p.type ?? '').trim();
      if (!type) continue;
      const secret = typeof p.secret === 'string' && p.secret ? p.secret : undefined;
      protos.push(secret !== undefined ? { type, secret } : { type });
    }
    volumes.push({
      letter,
      conversion: String(entry.conversion ?? '').trim(),
      protectionOn: entry.protectionOn === true,
      locked: entry.locked === true,
      protos
    });
  }
  return volumes;
}

/**
 * Match captured BitLocker volumes to the job's partitions by drive letter,
 * seal every recovery password, and assemble the sidecar. Pure and fully
 * testable — no filesystem or PowerShell involved.
 */
export function buildSidecar(options: {
  keyHex: string;
  captured: CapturedVolume[];
  partitions: CapturePartition[];
  now?: Date;
}): SidecarBuildResult {
  const subkey = deriveBitlockerSubkey(options.keyHex);
  const skipped: Array<{ letter: string; reason: string }> = [];
  const volumes: SidecarVolume[] = [];

  for (const vol of options.captured) {
    const partition = options.partitions.find(
      (p) => (p.driveLetter ?? '').replace(/:$/, '').toUpperCase() === vol.letter
    );
    if (!partition) continue; // not part of this backup

    if (vol.locked) {
      // A locked volume reports no conversion status — flag it before the
      // encryption test or it would vanish silently.
      skipped.push({ letter: vol.letter, reason: 'the volume is locked' });
      continue;
    }

    const encrypted = vol.conversion !== '' && vol.conversion !== 'FullyDecrypted';
    if (!encrypted) continue;

    const secrets = vol.protos.filter(
      (p) => isRecoveryProtectorType(p.type) && typeof p.secret === 'string' && p.secret.length > 0
    );
    if (secrets.length === 0) {
      skipped.push({
        letter: vol.letter,
        reason: 'it has no recovery-password protector (add one: manage-bde -protectors -add ' +
          `${vol.letter}: -recoverypassword)`
      });
      continue;
    }

    volumes.push({
      letter: vol.letter,
      label: partition.label,
      offset: partition.offset,
      size: partition.size,
      conversion: vol.conversion,
      protectors: secrets.map((p) => {
        const sealed = encryptRecoverySecret(subkey, p.secret!);
        return { type: p.type, nonce: sealed.nonce, data: sealed.data };
      })
    });
  }

  if (volumes.length === 0) {
    return { sidecar: null, skipped };
  }
  return {
    sidecar: {
      version: 1,
      createdAt: (options.now ?? new Date()).toISOString(),
      volumes
    },
    skipped
  };
}

export function sidecarPathFor(imagePath: string): string {
  return `${imagePath}.bitlocker.json`;
}

/** Write the sidecar next to the image (plain geometry, ciphertext secrets). */
export function writeBitlockerSidecar(imagePath: string, sidecar: BitlockerKeySidecar): string {
  const target = sidecarPathFor(imagePath);
  fs.writeFileSync(target, JSON.stringify(sidecar, null, 2), 'utf-8');
  return target;
}

/** Read + validate a sidecar; null when absent or malformed (C7 viewer path). */
export function readBitlockerSidecar(imagePath: string): BitlockerKeySidecar | null {
  try {
    const target = sidecarPathFor(imagePath);
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as BitlockerKeySidecar;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.volumes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type BitlockerKeysReadResult =
  | { ok: true; keys: Array<{ letter: string; label: string; recoveryPassword: string }> }
  | { ok: false; error: string };

/**
 * Decrypt a sidecar's recovery passwords for the key viewer (C7). The backup
 * passphrase re-derives the image key (PBKDF2 with the header's salt and
 * iterations), which the shared HKDF function stretches into the sealing key.
 *
 * Failure policy: wrong passphrase, tampered ciphertext, damaged sidecar and
 * unreadable header each return one of a few GENERIC errors — the GCM auth
 * tag rejects wrong keys and tampering identically, so nothing here can be
 * used as a decryption oracle. Secrets are never logged or persisted; the
 * plaintext keys live only in the returned object.
 */
export function readRecoveryKeys(imagePath: string, passphrase: string): BitlockerKeysReadResult {
  const sidecar = readBitlockerSidecar(imagePath);
  if (!sidecar) {
    return { ok: false, error: 'No BitLocker key sidecar (.bitlocker.json) is stored next to this image.' };
  }
  if (!passphrase) {
    return { ok: false, error: 'Enter the backup passphrase to decrypt the stored keys.' };
  }

  let headerSalt: Buffer;
  let headerIterations: number;
  try {
    const info = readImageInfo(imagePath);
    if (!info.header.cipherId) {
      return { ok: false, error: 'This image is not encrypted, so no passphrase exists to derive keys with.' };
    }
    headerSalt = info.header.salt;
    headerIterations = info.header.kdfIterations;
  } catch {
    return { ok: false, error: 'Could not read the image header.' };
  }

  try {
    const keyHex = deriveImageKey(passphrase, headerSalt, headerIterations).toString('hex');
    const subkey = deriveBitlockerSubkey(keyHex);
    const keys: Array<{ letter: string; label: string; recoveryPassword: string }> = [];
    for (const volume of sidecar.volumes) {
      for (const protector of volume.protectors) {
        if (!isRecoveryProtectorType(protector.type)) continue;
        keys.push({
          letter: volume.letter,
          label: volume.label,
          recoveryPassword: decryptRecoverySecret(subkey, protector.nonce, protector.data)
        });
      }
    }
    if (keys.length === 0) {
      return { ok: false, error: 'The sidecar contains no recovery passwords.' };
    }
    return { ok: true, keys };
  } catch {
    // GCM tag check failed: wrong passphrase or tampered/damaged sidecar.
    return { ok: false, error: 'Could not decrypt the BitLocker keys. Check the backup passphrase.' };
  }
}

/** Run the capture query; stdout is consumed in memory and never logged. */
export function runCaptureQuery(): { ok: true; volumes: CapturedVolume[] } | { ok: false; error: string } {
  try {
    const stdout = execFileSync(
      resolvePowershell(),
      ['-NoProfile', '-NonInteractive', '-Command', BITLOCKER_CAPTURE_PS],
      { encoding: 'utf-8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const volumes = parseCaptureJson(String(stdout));
    if (!volumes) {
      return { ok: false, error: 'BitLocker status query returned unparseable output.' };
    }
    return { ok: true, volumes };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = String(e.stderr ?? '').trim() || String(e.message ?? 'unknown error').split('\n')[0];
    return { ok: false, error: detail || 'BitLocker status query failed.' };
  }
}

/**
 * End-to-end capture for one backup job: query → filter → seal → write
 * `<image>.bitlocker.json`. Never throws; problems surface as result warnings.
 * Silent when the backup has no passphrase (Decision A: plaintext backups are
 * advised in the wizard instead of here).
 */
export function collectAndWriteSidecar(
  source: {
    imagePath: string;
    encryptionKeyHex?: string;
    partitions: CapturePartition[];
  },
  warnings: string[]
): boolean {
  if (!source.encryptionKeyHex) return false;

  const query = runCaptureQuery();
  if (!query.ok) {
    warnings.push(
      `BitLocker recovery keys were not stored: ${query.error}`
    );
    logger.warn(`BitLocker capture failed: ${query.error}`);
    return false;
  }

  const { sidecar, skipped } = buildSidecar({
    keyHex: source.encryptionKeyHex,
    captured: query.volumes,
    partitions: source.partitions
  });

  for (const s of skipped) {
    warnings.push(
      `BitLocker ${s.letter}: recovery key was not stored because ${s.reason}.`
    );
  }

  if (!sidecar) return false;
  try {
    writeBitlockerSidecar(source.imagePath, sidecar);
    logger.info(
      `Stored ${sidecar.volumes.reduce((n, v) => n + v.protectors.length, 0)} BitLocker recovery key(s) for ` +
        `${sidecar.volumes.length} volume(s) in ${sidecarPathFor(source.imagePath)}`
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`BitLocker recovery keys were not stored: ${message}`);
    logger.warn(`BitLocker sidecar write failed: ${message}`);
    return false;
  }
}
