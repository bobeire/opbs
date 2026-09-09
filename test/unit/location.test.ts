import { describe, it, expect } from 'vitest';
import { normalizeBackupLocation, isNonFilesystemLocation, isNetworkLocation } from '../../src/main/utils/location';

describe('backup location URIs', () => {
  it('passes through plain local paths', () => {
    expect(normalizeBackupLocation('D:\\OPBS')).toBe('D:\\OPBS');
    expect(normalizeBackupLocation('D:/OPBS')).toBe('D:\\OPBS');
  });

  it('normalizes file:// URIs to local paths', () => {
    expect(normalizeBackupLocation('file:///C:/Users/me/OPBS')).toBe('C:\\Users\\me\\OPBS');
    expect(normalizeBackupLocation('file:///D:/backups')).toBe('D:\\backups');
  });

  it('normalizes file:// and smb:// to UNC paths', () => {
    expect(normalizeBackupLocation('smb://nas/share/OPBS')).toBe('\\\\nas\\share\\OPBS');
    expect(normalizeBackupLocation('smb3://nas/share')).toBe('\\\\nas\\share');
    expect(normalizeBackupLocation('file://nas/share/OPBS')).toBe('\\\\nas\\share\\OPBS');
  });

  it('keeps UNC paths and normalizes separators', () => {
    expect(normalizeBackupLocation('\\\\nas\\share')).toBe('\\\\nas\\share');
    expect(normalizeBackupLocation('//nas/share/OPBS')).toBe('\\\\nas\\share\\OPBS');
  });

  it('classifies non-filesystem and network locations', () => {
    expect(isNonFilesystemLocation('s3://bucket/OPBS')).toBe(true);
    expect(isNonFilesystemLocation('sftp://host/path')).toBe(true);
    expect(isNonFilesystemLocation('D:\\OPBS')).toBe(false);
    expect(isNetworkLocation('\\\\nas\\share')).toBe(true);
    expect(isNetworkLocation('smb://nas/share')).toBe(true);
    expect(isNetworkLocation('D:\\OPBS')).toBe(false);
  });
});
