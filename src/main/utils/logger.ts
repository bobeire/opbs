import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

type AnyLog = {
  info: (m: string, d?: unknown) => void;
  debug: (m: string, d?: unknown) => void;
  warn: (m: string, d?: unknown) => void;
  error: (m: string, d?: unknown) => void;
  transports: {
    file: { level: string; getFile: () => { path: string } };
    console: { level: string };
  };
};

function loadElectronLog(): AnyLog | null {
  try {
    // Lazy require so the WinPE/CLI payload (bundled with only fzstd/zstdify
    // and the native addon) can load this module graph without electron-log.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const log = require('electron-log') as unknown as AnyLog;
    return log;
  } catch {
    return null;
  }
}

function getUserDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: { getPath(name: string): string };
    } | string;
    if (typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    // Not running inside Electron.
  }
  return path.join(os.tmpdir(), 'opbs');
}

/**
 * Logger that prefers electron-log (crash/file handling, rotation) but falls
 * back to a minimal file+console logger when electron-log is not bundled,
 * e.g. inside the WinPE smoke/restore payload.
 */
class Logger {
  private fallbackDir: string;
  private fallbackFile: string;
  private level: LogLevel = LogLevel.INFO;
  private el: AnyLog | null;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.el = loadElectronLog();
    const logDir = path.join(getUserDataDir(), 'logs');
    if (!fs.existsSync(logDir)) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {
        // best effort
      }
    }
    this.fallbackDir = logDir;
    const date = new Date().toISOString().split('T')[0];
    this.fallbackFile = path.join(logDir, `opbs-${date}.log`);
    this.setLevel(level);
  }

  private format(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}`;
    if (data !== undefined) {
      entry += ` | ${JSON.stringify(data)}`;
    }
    return entry;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private writeFallback(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;
    const entry = this.format(level, message, data);
    try {
      fs.appendFileSync(this.fallbackFile, entry + '\n');
    } catch {
      // ignore write failures
    }
    console.log(entry);
  }

  debug(message: string, data?: unknown): void {
    if (this.el) {
      this.el.debug(message, data);
    } else {
      this.writeFallback(LogLevel.DEBUG, message, data);
    }
  }

  info(message: string, data?: unknown): void {
    if (this.el) {
      this.el.info(message, data);
    } else {
      this.writeFallback(LogLevel.INFO, message, data);
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.el) {
      this.el.warn(message, data);
    } else {
      this.writeFallback(LogLevel.WARN, message, data);
    }
  }

  error(message: string, error?: unknown): void {
    if (this.el) {
      this.el.error(message, error);
    } else {
      this.writeFallback(LogLevel.ERROR, message, error);
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
    if (this.el) {
      try {
        this.el.transports.file.level = level.toLowerCase();
        this.el.transports.console.level = level.toLowerCase();
      } catch {
        // ignore
      }
    }
  }

  getLogDir(): string {
    if (this.el) {
      try {
        return path.dirname(this.el.transports.file.getFile().path);
      } catch {
        // fall through
      }
    }
    return this.fallbackDir;
  }
}

export const logger = new Logger(LogLevel.INFO);