import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAndConsumeJob } from '../../src/main/helper/job-file';

describe('readAndConsumeJob', () => {
  let dir: string;
  let jobPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-jobfile-'));
    jobPath = path.join(dir, 'job.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses the job and removes the file', () => {
    fs.writeFileSync(jobPath, JSON.stringify({ type: 'backup', encryption: { keyHex: 'ab12' } }));

    const job = readAndConsumeJob<{ type: string; encryption: { keyHex: string } }>(jobPath);

    expect(job).toEqual({ type: 'backup', encryption: { keyHex: 'ab12' } });
    expect(fs.existsSync(jobPath)).toBe(false);
  });

  it('removes the file even when the JSON is corrupt', () => {
    fs.writeFileSync(jobPath, '{"type":"backup","keyHex":"ab');

    expect(() => readAndConsumeJob(jobPath)).toThrow();
    expect(fs.existsSync(jobPath)).toBe(false);
  });

  it('throws when the file does not exist', () => {
    expect(() => readAndConsumeJob(jobPath)).toThrow();
  });
});
