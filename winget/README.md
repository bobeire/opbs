# Winget manifest

Community-repository manifest for `winget install RHITCS.OPBS`
([microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)).

Validated locally with `winget validate --manifest winget`.

## Updating for a new release

1. Download the new `OPBS-Setup-<version>.exe` from the GitHub release and
   hash it:

   ```bash
   curl -sL -o setup.exe "https://github.com/bobeire/opbs/releases/download/<version>/OPBS-Setup-<version>.exe"
   sha256sum setup.exe   # certutil -hashfile setup.exe SHA256 on cmd
   ```

2. In all three files replace the old version with the new one. In
   `RHITCS.OPBS.installer.yaml` also update `InstallerUrl`,
   `InstallerSha256` (uppercase hex) and `ReleaseDate`.

3. `winget validate --manifest winget`

4. Copy the three files into a winget-pkgs fork under
   `manifests/r/RHITCS/OPBS/<version>/` and open a PR (see below).

The `ProductCode` GUID is derived from the appId (`com.rhitcs.opbs`) and is
stable across releases — do not change it.

## Opening the PR

```bash
gh repo fork microsoft/winget-pkgs --clone
cd winget-pkgs
gh repo set-default <your-fork>
git checkout -b rhitcs-opbs-<version>
mkdir -p manifests/r/RHITCS/OPBS/<version>
cp ../winget/RHITCS.OPBS*.yaml manifests/r/RHITCS/OPBS/<version>/
git add manifests/r/RHITCS/OPBS/<version>
git commit -m "New package: RHITCS.OPBS <version>"
git push -u origin rhitcs-opbs-<version>
gh pr create --repo microsoft/winget-pkgs --title "New package: RHITCS.OPBS <version>" --body "..." \
  --head <your-fork>:rhitcs-opbs-<version>
```

Expect the winget-pkgs validation bots to comment within a few minutes; a
human maintainer merges after that (typically days to weeks).
