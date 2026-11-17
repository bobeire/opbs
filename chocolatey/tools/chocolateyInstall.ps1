$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url            = 'https://github.com/bobeire/opbs/releases/download/0.6.123/OPBS-Setup-0.6.123.exe'
  checksum       = '110ddf2687cfc7e4672d7c3b3a4aafb580824587360394dea39239bf85eec968'
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
