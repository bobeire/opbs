# Vendored third-party sources

These directories hold upstream code used to build the native addon. They are
not part of OPBS and keep their own licences.

- `zstd/` — zstandard 1.5.6 (`facebook/zstd`), C sources. Dual-licensed
  BSD-3-Clause / GPL-2.0; OPBS uses it under the BSD-3-Clause option. Both
  upstream licence files are included: `zstd/LICENSE` and `zstd/COPYING`.
- `winfsp/winfsp/` — WinFsp SDK headers (`winfsp/winfsp`), GPLv3 with the
  WinFsp FLOSS exception. The full upstream text is in `winfsp/License.txt`.

The WinFsp **runtime** is not bundled with OPBS. It is installed separately,
either by the user from https://winfsp.dev or through OPBS's installer prompt,
which downloads the MSI published by the WinFsp project.
