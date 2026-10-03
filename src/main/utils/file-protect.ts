import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Best-effort protection for repository files (win32).
 *
 * A deny ACE for Everyone with DELETE | FILE_WRITE_DATA | FILE_APPEND_DATA |
 * FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES (0x10116) is applied. That exact mask
 * matters: it keeps reads fully working for OPBS itself (no SYNCHRONIZE bit —
 * Node/icacls shorthand denies always carry SYNCHRONIZE and would brick every
 * read of a protected image) while blocking every write path, so ransomware
 * running as the same user cannot encrypt or modify protected files.
 *
 * Windows happily falls back to the parent directory's FILE_DELETE_CHILD when
 * a file-level DELETE deny is present, and Node ignores both the readonly
 * attribute and pure file-level DELETE denies when unlinking — so deletion
 * cannot be reliably blocked for a readable file. Deletion of repository
 * images is instead caught by `repo verify` (missing files, orphans). This is
 * a raised bar against tampering/encryption, not a WORM guarantee against a
 * local administrator — documented in the README.
 *
 * On FAT32/ExFAT (no ACLs) we fall back to the read-only attribute.
 */

/** DELETE | WDATA | APPEND | WEA | WATTR — no SYNCHRONIZE, no READ. */
const PROTECT_MASK = 0x10116;
const EVERYONE = 'S-1-1-0';

function powershellExe(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string): Promise<boolean> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error) => resolve(!error)
    );
  });
}

function setDenyScript(paths: string[]): string {
  const list = paths.map(q).join(',');
  return `
$ErrorActionPreference = 'Stop'
$paths = @(${list})
$sid = New-Object System.Security.Principal.SecurityIdentifier('${EVERYONE}')
$failed = 0
foreach ($p in $paths) {
  try {
    $acl = Get-Acl -LiteralPath $p
    foreach ($r in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
      if ($r.AccessControlType -eq 'Deny' -and $r.IdentityReference.Equals($sid)) {
        $acl.RemoveAccessRuleSpecific($r)
      }
    }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]${PROTECT_MASK}, 'Deny')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $p -AclObject $acl
  } catch {
    $failed++
  }
}
if ($failed -gt 0) { exit 1 }
exit 0
`;
}

function clearDenyScript(paths: string[]): string {
  const list = paths.map(q).join(',');
  return `
$ErrorActionPreference = 'Stop'
$paths = @(${list})
$sid = New-Object System.Security.Principal.SecurityIdentifier('${EVERYONE}')
foreach ($p in $paths) {
  try {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $acl = Get-Acl -LiteralPath $p
    foreach ($r in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
      if ($r.AccessControlType -eq 'Deny' -and $r.IdentityReference.Equals($sid)) {
        $acl.RemoveAccessRuleSpecific($r)
      }
    }
    Set-Acl -LiteralPath $p -AclObject $acl
  } catch { }
}
exit 0
`;
}

async function attribFallback(files: string[], readOnly: boolean): Promise<void> {
  if (process.platform !== 'win32') return;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    await new Promise<void>((resolve) => {
      execFile(
        'attrib',
        [readOnly ? '+R' : '-R', file],
        { windowsHide: true, timeout: 10_000 },
        () => resolve()
      );
    });
  }
}

/**
 * Apply the deny ACE to fully-written repository files (images, header).
 * Reads keep working; writes and encryption are refused. Best-effort: never
 * throws, falls back to the read-only attribute where ACLs are unsupported.
 */
export async function protectFiles(files: string[]): Promise<void> {
  const existing = files.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return;

  if (process.platform !== 'win32') return;

  const ok = await runPowerShell(setDenyScript(existing));
  if (!ok) {
    await attribFallback(existing, true);
  }
}

/**
 * Remove protection again (prune/unlock path). Never throws.
 */
export async function unprotectFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  if (process.platform !== 'win32') return;
  await runPowerShell(clearDenyScript(files));
  await attribFallback(files, false);
}

/**
 * The journal must stay appendable, and its content is protected
 * cryptographically instead: every record is HMAC-chained, so edits or
 * truncations fail `repo verify` (or show up as orphaned image files).
 * No OS-level write deny is applied here.
 */
export async function protectJournal(_journalPath: string): Promise<void> {
  // Intentionally a no-op — see doc comment.
}
