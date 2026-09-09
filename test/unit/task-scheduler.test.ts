import { describe, it, expect } from 'vitest';
import { buildSchTasksArgs } from '../../src/main/utils/task-scheduler';

describe('buildSchTasksArgs', () => {
  it('creates a daily task at a default time with /RL HIGHEST', () => {
    const args = buildSchTasksArgs('OPBS verify', '"C:\\prog.exe" --cli verify --dir "D:\\bk"');
    expect(args).toEqual([
      '/Create',
      '/TN',
      'OPBS verify',
      '/TR',
      '"\"C:\\prog.exe\" --cli verify --dir \"D:\\bk\""',
      '/F',
      '/SC',
      'DAILY',
      '/ST',
      '02:00',
      '/RL',
      'HIGHEST'
    ]);
  });

  it('honors an explicit time and asSystem', () => {
    const args = buildSchTasksArgs('OPBS backup', '"exe" --cli backup c.json --elevated', {
      time: '03:30',
      asSystem: true
    });
    expect(args).toContain('/SC');
    expect(args).toContain('DAILY');
    expect(args).toContain('/ST');
    expect(args).toContain('03:30');
    expect(args).toContain('/RU');
    expect(args).toContain('SYSTEM');
    expect(args).not.toContain('/RL');
  });

  it('creates an on-login task when requested', () => {
    const args = buildSchTasksArgs('OPBS verify', '"exe" --cli verify --dir D:\\bk', {
      onLogin: true
    });
    expect(args).toContain('/SC');
    expect(args).toContain('ONLOGON');
    expect(args).not.toContain('/ST');
  });

  it('omits /F when overwrite is explicitly disabled', () => {
    const args = buildSchTasksArgs('task', 'cmd', { overwrite: false });
    expect(args).not.toContain('/F');
  });
});