import { describe, it, expect } from 'vitest';
import {
  parseBcdCreateGuid,
  parseReagentcWinreDir,
  buildRecoveryStartnetCmd,
  buildRecoveryRestoreCmd,
  recoveryPayloadTextFiles,
  buildStageScript,
  buildCleanupScript,
  buildWinpeshlIni,
  stageRecoveryRestore,
  type RecoveryStageConfig,
  type StageScriptParams
} from '../../src/main/recovery/winre-recovery';

function stageParams(over: Partial<StageScriptParams> = {}): StageScriptParams {
  return {
    work: 'C:\\Users\\me\\AppData\\Local\\Temp\\opbs-recovery-x',
    progressFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\opbs-recovery-x\\progress.txt',
    resultFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\opbs-recovery-x\\result.json',
    payload: [{ from: 'C:\\pkg\\node.exe', to: 'node.exe' }],
    textFiles: [{ name: 'restore.cmd', b64: 'cmVzdG9yZS5jbWQ=' }],
    startnetB64: 'c3RhcnRuZXQuY21k',
    winpeshlB64: 'd2luZXBlc2hsLmluaQ==',
    ...over
  };
}

function restoreConfig(over: Partial<RecoveryStageConfig> = {}): RecoveryStageConfig {
  return {
    imagePath: 'D:\\images\\pc-2026-10-27.opbs',
    targetDiskIndex: 1,
    targetPartitions: [2, 3],
    ...over
  };
}

function restoreJson(config: RecoveryStageConfig): Record<string, unknown> {
  const file = recoveryPayloadTextFiles(config).find((f) => f.name === 'OPBS-restore.json');
  if (!file) throw new Error('OPBS-restore.json missing from the payload text files');
  return JSON.parse(file.content) as Record<string, unknown>;
}

describe('parseBcdCreateGuid', () => {
  it('extracts the entry GUID from bcdedit output', () => {
    expect(parseBcdCreateGuid('The entry {7a2b4c8e-1f3d-4a5b-9c0d-1234567890ab} was successfully created.')).toBe(
      '{7a2b4c8e-1f3d-4a5b-9c0d-1234567890ab}'
    );
    expect(parseBcdCreateGuid('The entry {7A2B4C8E-1F3D-4A5B-9C0D-1234567890AB} was successfully copied.')).toBe(
      '{7A2B4C8E-1F3D-4A5B-9C0D-1234567890AB}'
    );
    expect(parseBcdCreateGuid('noise before\nThe entry {11111111-2222-3333-4444-555555555555} was created.')).toBe(
      '{11111111-2222-3333-4444-555555555555}'
    );
  });

  it('returns null on garbage', () => {
    expect(parseBcdCreateGuid('bcdedit exploded')).toBeNull();
    expect(parseBcdCreateGuid('{not-a-guid}')).toBeNull();
    expect(parseBcdCreateGuid('')).toBeNull();
    expect(parseBcdCreateGuid(undefined as unknown as string)).toBeNull();
  });
});

describe('parseReagentcWinreDir', () => {
  it('extracts the Windows RE location line', () => {
    const out = [
      'Windows Recovery Environment (Windows RE) and system reset configuration',
      'Information:',
      '',
      '    Windows RE status:         Enabled',
      '    Windows RE location:       \\\\?\\GLOBALROOT\\device\\harddisk0\\partition4\\Recovery\\WindowsRE',
      '    Boot Configuration Data (BCD) identifier: 12345678-1234-1234-1234-123456789012',
      '    Recovery image location:'
    ].join('\r\n');
    expect(parseReagentcWinreDir(out)).toBe('\\\\?\\GLOBALROOT\\device\\harddisk0\\partition4\\Recovery\\WindowsRE');
  });

  it('returns null when the line is missing', () => {
    expect(parseReagentcWinreDir('Windows RE status: Disabled')).toBeNull();
    expect(parseReagentcWinreDir('some other output')).toBeNull();
    expect(parseReagentcWinreDir('')).toBeNull();
    expect(parseReagentcWinreDir(undefined as unknown as string)).toBeNull();
  });
});

describe('buildRecoveryStartnetCmd', () => {
  const script = buildRecoveryStartnetCmd();

  it('copies the staged payload to the X: ramdisk before anything is written', () => {
    expect(script).toContain('xcopy "%STAGED%\\media\\OPBS" "X:\\OPBS\\"');
    expect(script).toContain('if not exist "X:\\OPBS\\node.exe" goto :notfound');
    expect(script.indexOf('xcopy "%STAGED%')).toBeLessThan(script.indexOf('call "X:\\OPBS\\restore.cmd"'));
  });

  it('has a 10-second cancel window before the automatic restore', () => {
    expect(script).toContain('The restore will start automatically in 10 seconds.');
    expect(script).toContain('choice /c YN /T 10 /D Y /N');
    expect(script).toContain('if errorlevel 2 goto :cancelled');
    expect(script).toContain('Cancelled - no restore has been run.');
  });

  it('reboots back to Windows only after a successful restore', () => {
    expect(script).toContain('wpeutil reboot');
    expect(script.match(/wpeutil reboot/g)).toHaveLength(1);
    expect(script.indexOf('wpeutil reboot')).toBeGreaterThan(script.indexOf('call "X:\\OPBS\\restore.cmd"'));
  });

  it('does NOT reboot on the failure path', () => {
    expect(script).toContain('if errorlevel 1 goto :failed');
    expect(script).toContain('THE RESTORE FAILED');
    expect(script).toContain('The machine has NOT been rebooted.');
    const failedSection = script.slice(script.lastIndexOf(':failed'));
    expect(failedSection).toContain('cmd /k');
    expect(failedSection).not.toContain('wpeutil reboot');
  });
});

describe('buildRecoveryRestoreCmd', () => {
  const script = buildRecoveryRestoreCmd();

  it('runs the staged restore config through the CLI', () => {
    expect(script).toContain('node.exe winpe-entry.js restore "OPBS-restore.json" --elevated --acknowledge-same-disk');
    expect(script).toContain('if not exist "%~dp0OPBS-restore.json" goto :wizard');
  });

  it('writes the result marker on both the success and the failure path', () => {
    expect(script).toContain('OPBS-restore-result.json');
    expect(script.match(/OPBS-restore-result\.json/g)).toHaveLength(2);
    expect(script).toContain('{"ok":true');
    expect(script).toContain('{"ok":false,"exitCode":%RC%');
  });

  it('exits 0 on success and 1 on failure', () => {
    expect(script).toContain('exit /b 0');
    expect(script).toContain('exit /b 1');
  });
});

describe('recoveryPayloadTextFiles', () => {
  it('round-trips imagePath, targetDiskIndex and targetPartitions in OPBS-restore.json', () => {
    const parsed = restoreJson(restoreConfig());
    expect(parsed.imagePath).toBe('D:\\images\\pc-2026-10-27.opbs');
    expect(parsed.targetDiskIndex).toBe(1);
    expect(parsed.targetPartitions).toEqual([2, 3]);
  });

  it('omits the passphrase when there is none and keeps it otherwise', () => {
    expect(restoreJson(restoreConfig()).passphrase).toBeUndefined();
    expect(restoreJson(restoreConfig({ passphrase: 'hunter2' })).passphrase).toBe('hunter2');
  });

  it('writes targetVirtualDisk instead of targetDiskIndex for virtual-disk targets', () => {
    const parsed = restoreJson(
      restoreConfig({
        targetDiskIndex: undefined,
        targetVirtualDisk: { path: 'C:\\test\\restored.vhdx', virtualSize: 268435456, type: 'dynamic' }
      })
    );
    expect(parsed.targetDiskIndex).toBeUndefined();
    expect(parsed.targetVirtualDisk).toEqual({
      path: 'C:\\test\\restored.vhdx',
      virtualSize: 268435456,
      type: 'dynamic'
    });
    expect(parsed.targetPartitions).toEqual([2, 3]);
  });

  it('defaults verifyBeforeWrite to true and honors an explicit false', () => {
    expect(restoreJson(restoreConfig()).verifyBeforeWrite).toBe(true);
    expect(restoreJson(restoreConfig({ verifyBeforeWrite: false })).verifyBeforeWrite).toBe(false);
  });

  it('ships the launcher scripts alongside the config', () => {
    const names = recoveryPayloadTextFiles(restoreConfig()).map((f) => f.name);
    expect(names).toContain('winpe-entry.js');
    expect(names).toContain('restore.cmd');
    expect(names).toContain('OPBS-restore.json');
  });
});

describe('buildStageScript', () => {
  const script = buildStageScript(stageParams());

  it('boots the staged recovery image exactly once via bootsequence', () => {
    expect(script).toContain('bcdedit /bootsequence');
  });

  it('creates a dedicated ramdisk device object for the copied winre.wim', () => {
    expect(script).toContain("bcdedit /create /d 'OPBS ramdisk options' /device");
    expect(script).toContain('ramdisksdidevice');
    expect(script).toContain('ramdisksdipath');
    expect(script).toContain('ramdisk=');
    expect(script).toContain('bcdedit /create /d \'OPBS Recovery\' /application osloader');
  });

  it('finds winre.wim through reagentc GLOBALROOT device paths (field regression)', () => {
    // reagentc /info prints \\?\GLOBALROOT\... which PowerShell's Test-Path
    // and Copy-Item cannot open - the lookup must try the \\.\ Win32 form and
    // use the .NET file APIs, or staging fails on every modern machine.
    expect(script).toContain("StartsWith('\\\\?\\')");
    expect(script).toContain("StartsWith('\\\\.\\')");
    expect(script).toContain('[System.IO.File]::Exists');
    expect(script).toContain('[System.IO.File]::Copy');
  });

  it('points the ramdisk at boot.sdi and boots winload like WinRE does (field regression)', () => {
    // The boot manager builds the RAM disk from boot.sdi BEFORE mounting the
    // WIM: ramdisksdipath at the WIM boots to 0xc000007b ("a required device
    // isn't connected"). The loader path must mirror WinRE's own entry.
    expect(script).toContain("ramdisksdipath '\\Recovery\\OPBS\\boot.sdi'");
    expect(script).not.toContain("ramdisksdipath '\\Recovery\\OPBS\\winre.wim'");
    expect(script).toContain("'boot.sdi'");
    expect(script).toContain("'\\windows\\system32\\winload.efi'");
    expect(script).not.toContain('system32\\boot\\winload');
  });

  it('wires winpeshl.ini to the OPBS launcher instead of recenv (field regression)', () => {
    // winre.wim boots via winpeshl.exe running winpeshl.ini INSTEAD of
    // startnet.cmd. The stock ini launches recenv.exe (recovery UI) - a
    // black screen for our purposes. Both files must be injected, and the
    // entry mirrors WinRE's proven loader settings.
    expect(script).toContain('winpeshl.ini');
    expect(script).toContain('startnet.cmd');
    const ini = buildWinpeshlIni();
    // The stock parser takes "[LaunchApp]" + "AppPath=<command line>" - the
    // [LaunchApps] form black-screens on this winpeshl.exe (field regression).
    expect(ini).toContain('[LaunchApp]');
    expect(ini).not.toContain('[LaunchApps]');
    expect(ini).toContain('AppPath=X:\\Windows\\System32\\cmd.exe /c X:\\Windows\\System32\\startnet.cmd');
    expect(ini).not.toContain('recenv');
    expect(script).toContain("inherit '{bootloadersettings}'");
    expect(script).toContain('nx OptIn');
    expect(script).toContain('bootmenupolicy Standard');
  });

  it('mounts the copied wim, injects startnet.cmd and commits', () => {
    expect(script).toContain('/Mount-Wim');
    expect(script).toContain('/Unmount-Wim');
    expect(script).toContain('/Commit');
    expect(script).toContain('startnet.cmd');
    // a failed injection must discard the mount, never commit it
    expect(script).toContain('/Discard');
  });

  it('suspends BitLocker protectors for one boot', () => {
    expect(script).toContain('manage-bde -protectors -disable');
    expect(script).toContain('-RebootCount 1');
  });

  it('never touches the shared {ramdiskoptions} object', () => {
    // WinRE keeps booting only because its own ramdisk device object is left
    // alone - the staging script must never write to {ramdiskoptions}.
    expect(script).not.toContain('set {ramdiskoptions}');
    expect(script).not.toContain("/set '{ramdiskoptions}'");
  });
});

describe('buildCleanupScript', () => {
  const script = buildCleanupScript({
    progressFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\opbs-recovery-clean-x\\progress.txt',
    resultFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\opbs-recovery-clean-x\\result.json',
    entryGuid: '{11111111-2222-3333-4444-555555555555}',
    ramdiskGuid: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'
  });

  it('deletes the one-shot boot entry and its dedicated ramdisk object', () => {
    expect(script).toContain("bcdedit /delete '{11111111-2222-3333-4444-555555555555}'");
    expect(script).toContain("bcdedit /delete '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'");
  });

  it('clears the one-shot bootsequence', () => {
    expect(script).toContain('bcdedit /deletevalue {bootmgr} bootsequence');
  });

  it('removes the staged recovery folder and reports the result', () => {
    expect(script).toContain('Remove-Item -Recurse -Force $stageRoot');
    expect(script).toContain('ok = $true');
    expect(script).toContain('ConvertTo-Json');
  });

  it('never deletes the canonical {ramdiskoptions} shared with Windows RE', () => {
    expect(script).toContain('{ae5534e0-a924-466c-b836-758539a3ee3a}');
    expect(script).toContain('-ne');
  });
});

describe('stageRecoveryRestore validation (early exits — nothing machine-level runs)', () => {
  it('rejects a missing image', async () => {
    const r = await stageRecoveryRestore({ imagePath: '', targetDiskIndex: 0, targetPartitions: [0] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No image');
  });

  it('rejects setting both a disk and a virtual-disk target', async () => {
    const r = await stageRecoveryRestore({
      imagePath: 'D:\\x.opbs',
      targetDiskIndex: 0,
      targetVirtualDisk: { path: 'C:\\t.vhdx', virtualSize: 1, type: 'dynamic' },
      targetPartitions: [0]
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('exactly one');
  });

  it('rejects setting neither target', async () => {
    const r = await stageRecoveryRestore({ imagePath: 'D:\\x.opbs', targetPartitions: [0] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('exactly one');
  });

  it('rejects an empty partition selection', async () => {
    const r = await stageRecoveryRestore({ imagePath: 'D:\\x.opbs', targetDiskIndex: 0, targetPartitions: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No partitions');
  });
});
