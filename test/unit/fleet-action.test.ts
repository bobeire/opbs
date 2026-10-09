import { describe, it, expect } from 'vitest';
import { buildActionArgs, runQueuedActions, ActionExecution, ACTION_TIMEOUT_MS } from '../../src/main/fleet/action';
import { FLEET_ACTION_NAMES, FleetActionRequest } from '../../src/main/fleet/schema';

function request(overrides: Partial<FleetActionRequest> = {}): FleetActionRequest {
  return {
    id: 'id1',
    machineId: 'm1',
    action: 'verify',
    dir: 'D:\\OPBS',
    issuedAt: 1_700_000_000_000,
    ...overrides
  };
}

describe('buildActionArgs', () => {
  it('maps every whitelisted action to its CLI invocation with --json', () => {
    expect(buildActionArgs({ action: 'verify', dir: 'D:\\OPBS' })).toEqual({
      ok: true,
      args: ['verify', '--dir', 'D:\\OPBS', '--scope', 'newest', '--json']
    });
    expect(buildActionArgs({ action: 'verify', dir: 'D:\\OPBS', scope: 'all' })).toEqual({
      ok: true,
      args: ['verify', '--dir', 'D:\\OPBS', '--scope', 'all', '--json']
    });
    expect(buildActionArgs({ action: 'scrub', dir: 'D:\\OPBS', scope: 'all' })).toEqual({
      ok: true,
      args: ['scrub', '--dir', 'D:\\OPBS', '--scope', 'all', '--json']
    });
    expect(buildActionArgs({ action: 'chain', dir: 'D:\\OPBS' })).toEqual({
      ok: true,
      args: ['chain', 'check', '--dir', 'D:\\OPBS', '--json']
    });
    expect(buildActionArgs({ action: 'analytics', dir: 'D:\\OPBS' })).toEqual({
      ok: true,
      args: ['analytics', 'D:\\OPBS', '--json']
    });
    expect(buildActionArgs({ action: 'anomalies', dir: 'D:\\OPBS' })).toEqual({
      ok: true,
      args: ['anomalies', 'check', '--dir', 'D:\\OPBS', '--json']
    });
    expect(buildActionArgs({ action: 'storage-health', dir: 'D:\\OPBS' })).toEqual({
      ok: true,
      args: ['storage-health', '--dir', 'D:\\OPBS', '--json']
    });
  });

  it('never emits a repair or write flag', () => {
    for (const action of FLEET_ACTION_NAMES) {
      const built = buildActionArgs({ action, dir: 'D:\\OPBS' });
      expect(built.ok, action).toBe(true);
      if (built.ok) expect(built.args).not.toContain('--repair');
    }
  });

  it('refuses unknown actions and a missing dir', () => {
    expect(buildActionArgs({ action: 'restore' as never, dir: 'D:\\OPBS' })).toEqual({
      ok: false,
      error: 'unsupported action "restore" (read-only diagnostics only)'
    });
    expect(buildActionArgs({ action: 'verify', dir: undefined })).toEqual({
      ok: false,
      error: 'missing target dir'
    });
  });
});

describe('runQueuedActions', () => {
  function executor(
    log: string[],
    responses: ActionExecution | ActionExecution[] | ((args: string[]) => ActionExecution)
  ) {
    let call = 0;
    return async (args: string[], _timeoutMs: number): Promise<ActionExecution> => {
      log.push(args.join(' '));
      if (typeof responses === 'function') return responses(args);
      if (Array.isArray(responses)) return responses[call++];
      return responses;
    };
  }

  it('runs actions sequentially and reports parsed JSON detail on success', async () => {
    const log: string[] = [];
    const results = await runQueuedActions([request({ id: 'a' }), request({ id: 'b', action: 'chain' })], {
      executor: executor(log, [
        { code: 0, killed: false, stdout: '{\n  "blocksVerified": 4096\n}\n', stderr: '' },
        { code: 0, killed: false, stdout: 'chains ok', stderr: '' }
      ]),
      now: (() => {
        let t = 1000;
        return () => (t += 1);
      })()
    });

    expect(log).toEqual([
      'verify --dir D:\\OPBS --scope newest --json',
      'chain check --dir D:\\OPBS --json'
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'a', ok: true, summary: '{"blocksVerified":4096}' });
    expect(results[0].detail).toEqual({ blocksVerified: 4096 });
    expect(results[1]).toMatchObject({ id: 'b', action: 'chain', ok: true, summary: 'chains ok' });
    expect(results[1].detail).toBeUndefined();
    expect(results[0].finishedAt).toBeGreaterThanOrEqual(results[0].startedAt);
  });

  it('reports exit-code failures with the stderr summary', async () => {
    const results = await runQueuedActions([request({ action: 'scrub' })], {
      executor: executor([], [{ code: 1, killed: false, stdout: '', stderr: 'FAILED: unreadable sector at 0x1000\n' }])
    });
    expect(results[0]).toMatchObject({ ok: false, summary: 'FAILED: unreadable sector at 0x1000' });
  });

  it('summarizes timeouts distinctly', async () => {
    const results = await runQueuedActions([request()], {
      executor: executor([], [{ code: null, killed: true, stdout: '', stderr: '' }]),
      timeoutMs: 60_000
    });
    expect(results[0]).toMatchObject({ ok: false, summary: 'timed out after 60s' });
  });

  it('falls back to stdout or the exit code when stderr is empty', async () => {
    const results = await runQueuedActions([request({ action: 'analytics' })], {
      executor: executor([], { code: 2, killed: false, stdout: 'line one\nline two\n', stderr: '' })
    });
    expect(results[0].summary).toBe('line one');
    const bare = await runQueuedActions([request({ id: 'z' })], {
      executor: executor([], [{ code: 7, killed: false, stdout: '', stderr: '' }])
    });
    expect(bare[0].summary).toBe('exit code 7');
  });

  it('drops oversized detail but keeps the summary', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(40 * 1024) });
    const results = await runQueuedActions([request()], {
      executor: executor([], [{ code: 0, killed: false, stdout: big, stderr: '' }])
    });
    expect(results[0].detail).toBeUndefined();
    expect(results[0].ok).toBe(true);
    expect(results[0].summary.length).toBeLessThanOrEqual(300);
  });

  it('fails unsupported requests without ever spawning', async () => {
    const log: string[] = [];
    const results = await runQueuedActions(
      [request({ action: 'restore' as never }), request({ id: '2', dir: undefined })],
      { executor: executor(log, []) }
    );
    expect(log).toEqual([]);
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0].summary).toContain('unsupported action');
    expect(results[1].summary).toContain('missing target dir');
    expect(results[0].finishedAt).toBeGreaterThanOrEqual(results[0].startedAt);
  });

  it('defaults to a 15 minute per-action timeout', () => {
    expect(ACTION_TIMEOUT_MS).toBe(15 * 60_000);
  });
});
