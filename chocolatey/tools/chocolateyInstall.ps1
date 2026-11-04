$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url            = 'https://github.com/bobeire/opbs/releases/download/0.6.113/OPBS-Setup-0.6.113.exe'
  checksum       = '3088bdb76769b7b0e5ab482624c83ace6634559ba51b34e9e7a54de8f16e5b1a'
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
