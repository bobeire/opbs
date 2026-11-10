$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url            = 'https://github.com/bobeire/opbs/releases/download/0.6.119/OPBS-Setup-0.6.119.exe'
  checksum       = '59af4d5ededa34517244d0351c3a53aee7acf57b636e2761aaf1b8cecb07a90e'
  checksumType   = 'sha256'
  softwareName   = 'OPBS*'
  # NSIS assisted installer: /S = silent, /currentuser = per-user scope
  # (matches the installer's default; no elevation required).
  silentArgs     = '/S /currentuser'
  validExitCodes = @(0)
}

# The installer may briefly spawn a child process; Install-ChocolateyPackage
# waits on the process tree, and the silent path completes the file copy and
# registry write before any residual wizard window appears.
Install-ChocolateyPackage @packageArgs
