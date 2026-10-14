<#
.SYNOPSIS
Uninstalls OPBS silently.

The NSIS uninstaller is discovered via the ARP entry
(softwareName 'OPBS*') by Install-ChocolateyUninstallPackage; this script
only supplies the per-user silent switches to match how it was installed.
#>
$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  softwareName   = 'OPBS*'
  silentArgs     = '/S /currentuser'
  validExitCodes = @(0)
}

Uninstall-ChocolateyPackage @packageArgs
