import { describe, it, expect } from 'vitest';
import { parseOpenPageArg, OPEN_PAGE_ALLOWLIST } from '../../src/main/utils/startup-nav';

describe('parseOpenPageArg', () => {
  it('returns the page for a valid flag', () => {
    expect(parseOpenPageArg(['C:\\OPBS.exe', '--open-page', 'browse'])).toBe('browse');
    expect(parseOpenPageArg(['OPBS.exe', '--open-page', 'backup'])).toBe('backup');
  });

  it('returns null when the flag is absent', () => {
    expect(parseOpenPageArg(['OPBS.exe'])).toBeNull();
    expect(parseOpenPageArg(['OPBS.exe', '--cli', 'mrimg', 'info', 'x.mrimg'])).toBeNull();
  });

  it('returns null when the value is missing or looks like another flag', () => {
    expect(parseOpenPageArg(['OPBS.exe', '--open-page'])).toBeNull();
    expect(parseOpenPageArg(['OPBS.exe', '--open-page', '--cli'])).toBeNull();
  });

  it('returns null for pages outside the allowlist', () => {
    expect(parseOpenPageArg(['OPBS.exe', '--open-page', 'dashboard'])).toBeNull();
    expect(parseOpenPageArg(['OPBS.exe', '--open-page', 'not-a-page'])).toBeNull();
    expect(parseOpenPageArg(['OPBS.exe', '--open-page', 'browse; calc'])).toBeNull();
  });

  it('every allowlisted page is a plain lowercase token', () => {
    for (const page of OPEN_PAGE_ALLOWLIST) {
      expect(page).toMatch(/^[a-z-]+$/);
    }
  });
});
