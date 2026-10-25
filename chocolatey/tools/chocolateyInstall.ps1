$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url            = 'https://github.com/bobeire/opbs/releases/download/0.6.90/OPBS-Setup-0.6.90.exe'
  checksum       = '2a072bef9e4996c86a8986f3ed6e2f95797da6c671ae4c53873a67536d484a14'
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
