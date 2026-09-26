import * as fs from 'fs';
import * as path from 'path';

export type PeArch = 'amd64' | 'arm64';

/**
 * Locate the Windows ADK "Assessment and Deployment Kit" used by the WinPE
 * media builder (copype, MakeWinPEMedia, DISM, oscdimg).
 */
const KIT_CANDIDATES = [
  'C:/Program Files (x86)/Windows Kits/10/Assessment and Deployment Kit',
  'C:/Program Files/Windows Kits/10/Assessment and Deployment Kit'
];

export interface AdkTools {
  /** Kit root (Assessment and Deployment Kit). */
  root: string;
  /** copype.cmd that creates a WinPE working directory. */
  copype: string;
  /** MakeWinPEMedia.cmd that produces an ISO or USB key. */
  makeWinPEMedia: string;
  /** DandISetEnv.bat (Deployment Tools environment: WinPERoot, oscdimg path). */
  dandiSetEnv: string;
  /** DISM used to mount the WinPE boot.wim for servicing. */
  dism: string;
  /** oscdimg used by MakeWinPEMedia for ISO output (may be null). */
  oscdimg?: string;
  /** WinPE-SecureStartup.cab (BitLocker support for the rescue media), if installed. */
  winpeSecureStartupCab?: string;
  /** WinPE-WMI.cab — the declared parent package of WinPE-SecureStartup
   *  (`<parent>WinPE-WMI-Package</parent>` in its update.mum). DISM rejects
   *  SecureStartup with 0x800f081e ("not applicable") unless WinPE-WMI is
   *  installed in the mounted image first. */
  winpeWmiCab?: string;
  arch: PeArch;
}

export function peArchForProcess(): PeArch {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

/** Candidate DISM binaries: ADK copy first, then the in-box system DISM. */
function dismCandidates(root: string, arch: PeArch): string[] {
  const adkDism = path.join(root, 'Deployment Tools', arch, 'DISM', 'dism.exe');
  const systemDism = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'Dism.exe')
    : '';
  return [...(fs.existsSync(adkDism) ? [adkDism] : []), ...(systemDism ? [systemDism] : [])];
}

export function kitExists(root: string, arch: PeArch): boolean {
  return (
    fs.existsSync(path.join(root, 'Windows Preinstallation Environment', 'copype.cmd')) &&
    fs.existsSync(path.join(root, 'Windows Preinstallation Environment', 'MakeWinPEMedia.cmd'))
  );
}

/**
 * Resolve the ADK installation. Returns null (rather than throwing) when the
 * kit is not installed so the CLI can print actionable guidance.
 */
export function locateAdk(arch: PeArch = peArchForProcess(), rootOverride?: string): AdkTools | null {
  const roots = [...(rootOverride ? [rootOverride] : []), ...KIT_CANDIDATES];
  for (const root of roots) {
    const resolved = rootOverride ? root : path.resolve(root);
    if (!kitExists(resolved, arch)) {
      continue;
    }
    const peDir = path.join(resolved, 'Windows Preinstallation Environment');
    const dism = dismCandidates(resolved, arch).find((d) => fs.existsSync(d));
    const oscdimg = path.join(resolved, 'Deployment Tools', arch, 'Oscdimg', 'oscdimg.exe');
    const secureStartupCab = path.join(peDir, arch, 'WinPE_OCs', 'WinPE-SecureStartup.cab');
    const wmiCab = path.join(peDir, arch, 'WinPE_OCs', 'WinPE-WMI.cab');
    return {
      root: resolved,
      copype: path.join(peDir, 'copype.cmd'),
      makeWinPEMedia: path.join(peDir, 'MakeWinPEMedia.cmd'),
      dandiSetEnv: path.join(resolved, 'Deployment Tools', 'DandISetEnv.bat'),
      dism: dism ?? '',
      oscdimg: fs.existsSync(oscdimg) ? oscdimg : undefined,
      winpeSecureStartupCab: fs.existsSync(secureStartupCab) ? secureStartupCab : undefined,
      winpeWmiCab: fs.existsSync(wmiCab) ? wmiCab : undefined,
      arch
    };
  }
  return null;
}