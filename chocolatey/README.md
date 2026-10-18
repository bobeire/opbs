# Chocolatey package

Community-package sources for `choco install opbs`
([community.chocolatey.org](https://community.chocolatey.org/packages/opbs)).

Per-user NSIS install (`/S /currentuser`) — no admin rights required by the
installer itself; `choco` still runs elevated as usual.

## Updating for a new release

1. Download the new `OPBS-Setup-<version>.exe` and compute its SHA256
   (e.g. `certutil -hashfile OPBS-Setup-<version>.exe SHA256` in cmd).
2. In `opbs.nuspec`: bump `<version>` and the `releaseNotes` URL.
3. In `tools/chocolateyInstall.ps1`: update `url`, `checksum`,
   `silentArgs` stay as-is.
4. Pack and sanity-check:

   ```bash
   choco pack opbs.nuspec
   ```

6. Push (needs a chocolatey.org API key):

   ```bash
   choco push opbs.<version>.nupkg --source https://push.chocolatey.org/
   ```

New packages must be pushed from an account with a registered API key;
the first publication additionally goes through moderation (typically a
few days).

## Local install test (elevated terminal)

```powershell
choco install opbs -y -s <this-directory>
# verify Start Menu entry / %LOCALAPPDATA%\Programs\OPBS\OPBS.exe
choco uninstall opbs -y
```
