import type { AppSettings } from './settings-manager';
import type { CloudStoreOptions } from './cloud-store';
import type { S3Config } from './s3';
import type { SftpConfig } from './sftp';
import type { FtpConfig } from './ftp';

/** The app's Settings → Cloud (S3) entry as a store-client profile. */
export function s3ProfileFrom(settings: AppSettings): Partial<S3Config> | undefined {
  const s3 = settings.cloud?.s3;
  if (!s3) return undefined;
  return {
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: s3.bucket,
    prefix: s3.prefix,
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle,
    objectLockMode: s3.objectLockMode || undefined,
    objectLockRetainDays: s3.objectLockMode ? s3.objectLockRetainDays : undefined
  };
}

/** The app's Settings → Cloud (SFTP) entry as a store-client profile. */
export function sftpProfileFrom(settings: AppSettings): Partial<SftpConfig> | undefined {
  const sftp = settings.cloud?.sftp;
  if (!sftp) return undefined;
  return {
    host: sftp.host,
    port: sftp.port,
    username: sftp.username,
    password: sftp.password || undefined,
    privateKey: sftp.privateKey || undefined,
    remotePath: sftp.remotePath
  };
}

/** The app's Settings → Cloud (FTP/FTPS) entry as a store-client profile. */
export function ftpProfileFrom(settings: AppSettings): Partial<FtpConfig> | undefined {
  const ftp = settings.cloud?.ftp;
  if (!ftp) return undefined;
  return {
    host: ftp.host,
    port: ftp.port,
    username: ftp.username,
    password: ftp.password || undefined,
    remotePath: ftp.remotePath,
    secure: ftp.secure
  };
}

/** Store-client credential options for whichever cloud profiles are configured. */
export function cloudStoreOptionsFrom(settings: AppSettings): CloudStoreOptions {
  const s3Profile = s3ProfileFrom(settings);
  const sftpProfile = sftpProfileFrom(settings);
  const ftpProfile = ftpProfileFrom(settings);
  return {
    ...(s3Profile ? { s3Profile } : {}),
    ...(sftpProfile ? { sftpProfile } : {}),
    ...(ftpProfile ? { ftpProfile } : {})
  };
}
