import * as path from 'path';
import * as fs from 'fs';

export function resolveNativePath(): string {
  if (process.env.OPBS_NATIVE_PATH) {
    return process.env.OPBS_NATIVE_PATH;
  }

  // Dev candidates (first existing wins):
  //   ./dist/utils/native-loader.js -> ../../src/native/build/Release/...
  //   ./dist/helper/*.js or src/main/utils (vitest/tsx) -> ../../../src/native/...
  const devCandidates = [
    path.join(__dirname, '../../src/native/build/Release/opbs_native.node'),
    path.join(__dirname, '../../../src/native/build/Release/opbs_native.node')
  ];
  for (const candidate of devCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Packaged: native module is unpacked from asar (process.resourcesPath only
  // exists inside Electron).
  if (typeof process.resourcesPath === 'string') {
    const unpackedPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'src',
      'native',
      'build',
      'Release',
      'opbs_native.node'
    );
    if (fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }

    // Packaged: native module copied to resources root
    const resourcesPath = path.join(process.resourcesPath, 'opbs_native.node');
    if (fs.existsSync(resourcesPath)) {
      return resourcesPath;
    }
  }

  return devCandidates[0];
}

export function loadNative<T = Record<string, unknown>>(): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(resolveNativePath()) as T;
}