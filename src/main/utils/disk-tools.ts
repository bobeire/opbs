import { execFileSync } from 'child_process';
import { psQuote, runElevatedPowerShell } from './elevated';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkDiskHealth } from './disk-health';
import { DiskEnumerator } from './disk-enumerator';

const PARTITION_TYPE_MAP: Record<number, string> = {
  0x01: 'FAT12',
  0x04: 'FAT16 (<32MB)',
  0x05: 'Extended',
  0x06: 'FAT16 (>32MB)',
  0x07: 'NTFS / exFAT / HPFS',
  0x0B: 'FAT32 (CHS)',
  0x0C: 'FAT32 (LBA)',
  0x0E: 'FAT16 (LBA)',
  0x0F: 'Extended (LBA)',
  0x11: 'Hidden FAT12',
  0x12: 'Hidden NTFS',
  0x14: 'Hidden FAT16 (<32MB)',
  0x17: 'Hidden NTFS / HPFS',
  0x1B: 'Hidden FAT32',
  0x1C: 'Hidden FAT32 (LBA)',
  0x1E: 'Hidden FAT16 (LBA)',
  0x27: 'Microsoft Recovery',
  0x42: 'Microsoft MBR',
  0x82: 'Linux swap',
  0x83: 'Linux',
  0xEE: 'GPT Protective',
  0xEF: 'EFI System'
};

export function partitionTypeLabel(t: number): string {
  return PARTITION_TYPE_MAP[t] ?? `Unknown (0x${t.toString(16).toUpperCase().padStart(2, '0')})`;
}

function run(args: string[], timeoutMs = 30000): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true
  }).trim();
}

/**
 * Run a PowerShell snippet elevated (one UAC prompt). Because the elevated
 * process runs windowless with no captured stdio, the snippet's output is
 * written to a result file by the wrapper script and read back here.
 */
async function runElevated(ps: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-disk-'));
  const scriptPath = path.join(tmpDir, 'tool.ps1');
  const resultPath = path.join(tmpDir, 'result.json');
  const wrapper = [
    `$ErrorActionPreference = 'Continue'`,
    `$stdout = ''`,
    `$stderr = ''`,
    `try {`,
    `  $stdout = & { ${ps} } 2>&1 | Out-String -Width 4096`,
    `} catch {`,
    `  $stderr = $_.Exception.Message`,
    `}`,
    `[System.IO.File]::WriteAllText(${psQuote(resultPath)}, (ConvertTo-Json -Compress @{ stdout = $stdout; stderr = $stderr; exitCode = $LASTEXITCODE }))`
  ].join('\r\n');
  fs.writeFileSync(scriptPath, wrapper, 'utf-8');
  try {
    const exitCode = await runElevatedPowerShell(scriptPath);
    if (!fs.existsSync(resultPath)) {
      return {
        exitCode: exitCode ?? 5,
        stdout: '',
        stderr: 'Administrator approval was declined or the elevated process failed to start.'
      };
    }
    try {
      const r = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      return {
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : (exitCode ?? 0),
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? ''
      };
    } catch {
      return { exitCode: exitCode ?? 1, stdout: '', stderr: 'Could not read the elevated command output.' };
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── MBR Read (PowerShell, no elevation) ───

export interface MbrPartitionEntry {
  index: number;
  active: boolean;
  type: number;
  typeLabel: string;
  startLba: number;
  sectorCount: number;
  sizeBytes: number;
  startChs: string;
  endChs: string;
  driveLetter?: string;
}

export interface MbrInfo {
  ok: boolean;
  error?: string;
  diskIndex: number;
  partitionStyle: 'mbr' | 'gpt' | 'raw';
  diskSignature?: number;
  partitionCount: number;
  partitions: MbrPartitionEntry[];
  bootable?: number;
}

export function chsToString(b0: number, b1: number, b2: number): string {
  const c = b2 | ((b1 & 0xc0) << 2);
  const h = b0;
  const s = b1 & 0x3f;
  return `C${c}/H${h}/S${s}`;
}

export function parseMbrRaw(buf: Buffer): Omit<MbrInfo, 'ok' | 'diskIndex'> {
  const bootSig = buf.readUInt16LE(510);
  const diskSig = buf.readUInt32LE(440);

  const partitions: MbrPartitionEntry[] = [];
  let bootable: number | undefined;

  for (let i = 0; i < 4; i++) {
    const off = 446 + i * 16;
    const status = buf[off];
    const type = buf[off + 4];
    if (type === 0) continue;

    const startLba = buf.readUInt32LE(off + 8);
    const sectorCount = buf.readUInt32LE(off + 12);
    const active = status === 0x80;

    partitions.push({
      index: i,
      active,
      type,
      typeLabel: partitionTypeLabel(type),
      startLba,
      sectorCount,
      sizeBytes: sectorCount * 512,
      startChs: chsToString(buf[off + 1], buf[off + 2], buf[off + 3]),
      endChs: chsToString(buf[off + 5], buf[off + 6], buf[off + 7])
    });

    if (active && bootable === undefined) bootable = i;
  }

  const isGptProtective = partitions.length === 1 && partitions[0].type === 0xEE;

  return {
    diskSignature: diskSig,
    partitionStyle: isGptProtective ? 'gpt' : partitions.length > 0 ? 'mbr' : 'raw',
    partitionCount: partitions.length,
    partitions,
    bootable,
    bootSignature: `0x${bootSig.toString(16).toUpperCase()}`
  } as unknown as Omit<MbrInfo, 'ok' | 'diskIndex'>;
}

export function getMbrInfo(diskIndex: number): MbrInfo {
  try {
    const ps = [
      `$d = Get-Disk -Number ${diskIndex} -ErrorAction Stop`,
      `$partStyle = $d.PartitionStyle`,
      `Write-Output "STYLE:$partStyle"`,
      `$parts = Get-Partition -DiskNumber ${diskIndex} -ErrorAction SilentlyContinue`,
      `foreach ($p in $parts) {`,
      `  $type = $p.Type`,
      `  $active = if ($p.IsActive) { "YES" } else { "NO" }`,
      `  $offset = $p.Offset`,
      `  $size = $p.Size`,
      `  $num = $p.PartitionNumber`,
      `  $driveLetter = if ($p.DriveLetter) { "$($p.DriveLetter):" } else { "" }`,
      `  Write-Output "PART:$num|$type|$active|$offset|$size|$driveLetter"`,
      `}`
    ].join('\r\n');

    const output = run(['-Command', ps]);
    let style: 'mbr' | 'gpt' | 'raw' = 'raw';
    const partitions: MbrPartitionEntry[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('STYLE:')) {
        const s = trimmed.slice(6).trim().toLowerCase();
        style = s === 'mbr' ? 'mbr' : s === 'gpt' ? 'gpt' : 'raw';
      } else if (trimmed.startsWith('PART:')) {
        const [, num, type, active, offset, size, driveLetter] = trimmed.slice(5).split('|');
        partitions.push({
          index: parseInt(num, 10) - 1,
          active: active === 'YES',
          type: 0,
          typeLabel: type,
          startLba: Math.floor(parseInt(offset, 10) / 512),
          sectorCount: Math.floor(parseInt(size, 10) / 512),
          sizeBytes: parseInt(size, 10),
          startChs: '',
          endChs: '',
          driveLetter: driveLetter || undefined
        });
      }
    }

    return {
      ok: true,
      diskIndex,
      partitionStyle: style,
      partitionCount: partitions.length,
      partitions,
      bootable: partitions.find((p) => p.active)?.index
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      diskIndex,
      partitionStyle: 'raw',
      partitionCount: 0,
      partitions: []
    };
  }
}

export async function getMbrRaw(diskIndex: number): Promise<{ ok: boolean; error?: string; diskIndex: number; bootSignature: string; diskSignatureHex: string; partitions: MbrPartitionEntry[] }> {
  try {
    const ps = [
      `$stream = [System.IO.FileStream]::new("\\\\.\\PhysicalDrive${diskIndex}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)`,
      `$buffer = New-Object byte[] 512`,
      `$stream.Read($buffer, 0, 512) | Out-Null`,
      `$stream.Close()`,
      `[Convert]::ToBase64String($buffer)`
    ].join('\r\n');

    const result = await runElevated(ps);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || 'Failed to read MBR (run as administrator)', diskIndex, bootSignature: '', diskSignatureHex: '', partitions: [] };
    }

    const b64 = result.stdout.trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 512) {
      return { ok: false, error: 'Read fewer than 512 bytes', diskIndex, bootSignature: '', diskSignatureHex: '', partitions: [] };
    }

    const bootSig = buf.readUInt16LE(510);
    const diskSig = buf.readUInt32LE(440);
    const parsed = parseMbrRaw(buf);

    return {
      ok: true,
      diskIndex,
      bootSignature: `0x${bootSig.toString(16).toUpperCase().padStart(4, '0')}`,
      diskSignatureHex: `0x${diskSig.toString(16).toUpperCase().padStart(8, '0')}`,
      partitions: parsed.partitions
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), diskIndex, bootSignature: '', diskSignatureHex: '', partitions: [] };
  }
}

// ─── Boot Repair (elevated) ───

export interface BootRepairResult {
  ok: boolean;
  error?: string;
  action: string;
  output: string;
}

export async function bootRecFixMbr(): Promise<BootRepairResult> {
  try {
    const result = await runElevated('bootrec.exe /fixmbr 2>&1');
    return { ok: result.exitCode === 0, action: 'fixmbr', output: (result.stdout + '\n' + result.stderr).trim() };
  } catch (error) {
    return { ok: false, action: 'fixmbr', error: error instanceof Error ? error.message : String(error), output: '' };
  }
}

export async function bootRecRebuildBcd(): Promise<BootRepairResult> {
  try {
    const result = await runElevated('bootrec.exe /rebuildbcd 2>&1');
    return { ok: result.exitCode === 0, action: 'rebuildbcd', output: (result.stdout + '\n' + result.stderr).trim() };
  } catch (error) {
    return { ok: false, action: 'rebuildbcd', error: error instanceof Error ? error.message : String(error), output: '' };
  }
}

// ─── Disk Check (chkdsk) ───

export interface ChkdskResult {
  ok: boolean;
  error?: string;
  volume: string;
  mode: string;
  output: string;
}

export function chkdskScan(volume: string): ChkdskResult {
  try {
    const output = run([`chkdsk ${volume} /scan 2>&1`], 60000);
    return { ok: true, volume, mode: 'scan', output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), volume, mode: 'scan', output: '' };
  }
}

export async function chkdskFix(volume: string): Promise<ChkdskResult> {
  try {
    const result = await runElevated(`& chkdsk ${volume} /f 2>&1`);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const locked = output.includes('cannot lock') || output.includes('scheduled');
    return { ok: result.exitCode === 0 || locked, volume, mode: 'fix', output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), volume, mode: 'fix', output: '' };
  }
}

export async function chkdskBadSectors(volume: string): Promise<ChkdskResult> {
  try {
    const result = await runElevated(`& chkdsk ${volume} /r 2>&1`);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const locked = output.includes('cannot lock') || output.includes('scheduled');
    return { ok: result.exitCode === 0 || locked, volume, mode: 'bad-sectors', output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), volume, mode: 'bad-sectors', output: '' };
  }
}

// ─── SSD TRIM ───

export interface TrimStatus {
  ok: boolean;
  error?: string;
  enabled: boolean;
  output: string;
}

export function getTrimStatus(): TrimStatus {
  try {
    const output = run(['fsutil behavior query DisableDeleteNotify 2>&1']);
    const match = output.match(/DisableDeleteNotify\s*=\s*(\d)/);
    const val = match ? parseInt(match[1], 10) : -1;
    return { ok: true, enabled: val === 0, output };
  } catch (error) {
    return { ok: false, enabled: false, error: error instanceof Error ? error.message : String(error), output: '' };
  }
}

export async function retrimVolume(volume: string): Promise<{ ok: boolean; error?: string; output: string }> {
  try {
    const result = await runElevated(`& defrag ${volume} /L 2>&1`);
    return { ok: result.exitCode === 0, output: (result.stdout + '\n' + result.stderr).trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), output: '' };
  }
}

// ─── SMART (per-disk) ───

export interface SmartDiskInfo {
  diskIndex: number;
  model: string;
  size: number;
  reliable: boolean;
  healthStatus?: string;
  temperatureCelsius?: number;
  wear?: number;
  unreliableSectors?: number;
  readErrors?: number;
  writeErrors?: number;
  warnings: string[];
}

export async function getSmartAllDisks(): Promise<SmartDiskInfo[]> {
  try {
    const enumerator = new DiskEnumerator();
    const disks = await enumerator.getDisks();

    const results: SmartDiskInfo[] = [];
    for (const disk of disks) {
      try {
        const health = await checkDiskHealth(disk.index);
        results.push({
          diskIndex: disk.index,
          model: disk.model || 'Unknown',
          size: disk.size,
          reliable: health.ok,
          healthStatus: health.data.healthStatus,
          temperatureCelsius: health.data.temperatureCelsius,
          wear: health.data.wear,
          unreliableSectors: health.data.unreliableSectors,
          readErrors: health.data.readErrors,
          writeErrors: health.data.writeErrors,
          warnings: health.warnings
        });
      } catch {
        results.push({
          diskIndex: disk.index,
          model: disk.model || 'Unknown',
          size: disk.size,
          reliable: true,
          warnings: []
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}