import { describe, it, expect, vi } from 'vitest';
import { writeRawWithRetry } from '../../src/main/helper/job-runner';

const ACCESS_DENIED =
  'WriteFile failed on \\\\.\\PhysicalDrive3 at offset 23068672 (1048576 bytes): Access is denied. (error 5 / 0x5)';

describe('writeRawWithRetry', () => {
  it('retries transient access-denied writes until they succeed', async () => {
    let calls = 0;
    await writeRawWithRetry(() => {
      calls += 1;
      if (calls < 3) throw new Error(ACCESS_DENIED);
    }, 10, 1);
    expect(calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(
      writeRawWithRetry(() => {
        calls += 1;
        throw new Error('WriteFile failed: The disk is full. (error 112 / 0x70)');
      }, 10, 1)
    ).rejects.toThrow(/disk is full/);
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget on persistent denial', async () => {
    let calls = 0;
    await expect(
      writeRawWithRetry(() => {
        calls += 1;
        throw new Error(ACCESS_DENIED);
      }, 5, 1)
    ).rejects.toThrow(/Access is denied/);
    expect(calls).toBe(5);
  });

  it('propagates async write failures through the retry loop', async () => {
    const attemptWrite = vi.fn(async () => {
      throw new Error(ACCESS_DENIED);
    });
    await expect(writeRawWithRetry(attemptWrite, 3, 1)).rejects.toThrow(/Access is denied/);
    expect(attemptWrite).toHaveBeenCalledTimes(3);
  });
});
