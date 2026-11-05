import { describe, it, expect } from 'vitest';
import { launchElevatedJob } from '../../src/main/helper/launcher';

/**
 * The CLI's non-elevated path used to crash with
 * "Cannot read properties of undefined (reading 'isPackaged')" because
 * `require('electron').app` is undefined under plain node.exe. The user saw
 * that instead of "run with --elevated", which is the actual answer.
 */
describe('launchElevatedJob under plain Node.js', () => {
  it('names --elevated instead of dereferencing electron.app', () => {
    const job = { type: 'backup' };
    expect(() => launchElevatedJob(job)).toThrow(/--elevated/);
    expect(() => launchElevatedJob(job)).not.toThrow(/isPackaged/);
  });
});
