import { S3Store, resolveS3Config, type S3Config } from './s3';
import { SftpStore, resolveSftpConfig, type SftpConfig } from './sftp';
import { FtpStore, resolveFtpConfig, type FtpConfig } from './ftp';

/** Optional credential overrides for `cloudStoreFromLocation`. */
export interface CloudStoreOptions {
  region?: string;
  s3Profile?: Partial<S3Config>;
  sftpProfile?: Partial<SftpConfig>;
  ftpProfile?: Partial<FtpConfig>;
}

/**
 * Object-store client for an `s3://`, `sftp://` or `ftp://` location.
 *
 * Credentials resolve in layers: the URI itself (user/host/path), then the
 * supplied profile (the app's Settings → Cloud entry), then the standard
 * environment variables (`AWS_*`, `SFTP_*`, `FTP_*`). The CLI calls this with
 * no profile; the GUI passes the saved profiles so a fetch works without any
 * env vars set.
 */
export function cloudStoreFromLocation(uri: string, opts: CloudStoreOptions = {}): S3Store | SftpStore | FtpStore {
  const trimmed = uri.trim();
  if (trimmed.startsWith('sftp://')) {
    const config = resolveSftpConfig(opts.sftpProfile, trimmed);
    if (!config.username) {
      throw new Error(`sftp:// location requires a username (sftp://user@host/path) or SFTP_USER`);
    }
    if (!config.password && !config.privateKey) {
      throw new Error('SFTP credentials are required (SFTP_PASSWORD or SFTP_PRIVATE_KEY)');
    }
    return new SftpStore({ config });
  }
  if (trimmed.startsWith('ftp://')) {
    const config = resolveFtpConfig(opts.ftpProfile, trimmed);
    if (!config.username) {
      throw new Error(`ftp:// location requires a username (ftp://user@host/path) or FTP_USER`);
    }
    if (!config.password) {
      throw new Error('FTP credentials are required (FTP_PASSWORD)');
    }
    return new FtpStore({ config });
  }
  const region = opts.region ?? opts.s3Profile?.region;
  const config = resolveS3Config(region !== undefined ? { ...opts.s3Profile, region } : opts.s3Profile, trimmed);
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error(
      opts.s3Profile
        ? 'S3 credentials are missing (Settings → Cloud (S3), or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
        : 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables are required'
    );
  }
  return new S3Store(config);
}
