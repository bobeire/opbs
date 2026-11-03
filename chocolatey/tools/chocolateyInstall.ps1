$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url            = 'https://github.com/bobeire/opbs/releases/download/0.6.107/OPBS-Setup-0.6.107.exe'
  checksum       = '45c78d2e0b9da22099289e59f74823f230cee08625e86974c91c1b125d3732e9'
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
