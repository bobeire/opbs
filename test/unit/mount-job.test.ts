import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMountJob, dispatchHelperJob } from '../../src/main/helper/job-runner';
import type { PipeClient } from '../../src/main/utils/pipe-ipc';

vi.mock('../../src/main/imaging/mount-manager', () => {
  const handle = {
    id: 7,
    mountPoint: 'Z:',
    unmount: vi.fn(() => true)
  };
  return {
    winfspAvailable: vi.fn(() => true),
    mountImage: vi.fn(() => handle),
    __handle: handle
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountManager = (await import('../../src/main/imaging/mount-manager')) as any;

function mockPipe(): PipeClient & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: (msg: Record<string, unknown>) => {
      sent.push(msg);
    }
  } as unknown as PipeClient & { sent: Array<Record<string, unknown>> };
}

describe('runMountJob', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mount-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    fs.writeFileSync(
      jobPath,
      JSON.stringify({ type: 'mount', imagePath: 'C:\\img.opbs', partitionIndex: 0 })
    );
    mountManager.mountImage.mockClear();
    mountManager.__handle.unmount.mockClear();
    mountManager.winfspAvailable.mockReturnValue(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends mounted progress and result over the pipe', async () => {
    const pipe = mockPipe();
    const job = runMountJob(jobPath, resultPath, progressPath, cancelPath, pipe);

    // Wait for the mount progress to arrive before cancelling.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !pipe.sent.some((m) => m.type === 'progress')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(cancelPath, '');
    await job;

    const progress = pipe.sent.find((m) => m.type === 'progress');
    // nativeId (not `id`) so the parent can key by mount UUID without collision.
    expect(progress).toMatchObject({ state: 'mounted', mountPoint: 'Z:', nativeId: 7 });
    expect(progress).not.toHaveProperty('id');
    expect(JSON.parse(fs.readFileSync(progressPath, 'utf-8'))).toMatchObject({
      state: 'mounted',
      mountPoint: 'Z:',
      nativeId: 7
    });

    const result = pipe.sent.find((m) => m.type === 'result');
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({ ok: true });
    expect(mountManager.__handle.unmount).toHaveBeenCalled();
  });

  it('reports WinFsp-missing failures on the pipe without mounting', async () => {
    mountManager.winfspAvailable.mockReturnValue(false);
    const pipe = mockPipe();
    await runMountJob(jobPath, resultPath, progressPath, cancelPath, pipe);

    const result = pipe.sent.find((m) => m.type === 'result');
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.error)).toMatch(/WinFsp is not installed/);
    expect(mountManager.mountImage).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({ ok: false });
  });

  it('reports mountImage failures with the thrown message', async () => {
    mountManager.mountImage.mockImplementationOnce(() => {
      throw new Error('NTSTATUS 0xc0000034');
    });
    const pipe = mockPipe();
    await runMountJob(jobPath, resultPath, progressPath, cancelPath, pipe);

    const result = pipe.sent.find((m) => m.type === 'result');
    expect(result).toMatchObject({ ok: false, error: 'NTSTATUS 0xc0000034' });
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf-8'))).toMatchObject({
      ok: false,
      error: 'NTSTATUS 0xc0000034'
    });
  });

  it('dispatches mount jobs through dispatchHelperJob', async () => {
    const pipe = mockPipe();
    const job = dispatchHelperJob(jobPath, resultPath, progressPath, cancelPath, undefined, pipe);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !pipe.sent.some((m) => m.type === 'progress')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(cancelPath, '');
    await job;

    expect(pipe.sent.some((m) => m.type === 'progress')).toBe(true);
    expect(pipe.sent.find((m) => m.type === 'result')).toMatchObject({ ok: true });
  });
});
