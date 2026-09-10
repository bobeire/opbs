import { app } from 'electron';
import { logger } from './logger';

export interface ErrorReportingConfig {
  enabled: boolean;
  endpoint: string;
}

interface QueuedReport {
  ts: number;
  level: 'error' | 'unhandled';
  name: string;
  message: string;
  stack?: string;
  context?: string;
}

let config: ErrorReportingConfig = { enabled: false, endpoint: '' };
const queue: QueuedReport[] = [];
let timer: NodeJS.Timeout | null = null;

/** Mask absolute paths from stack traces to avoid shipping local file system layout. */
function sanitize(text: string): string {
  return text
    .replace(/[A-Za-z]:\\(?:[^\\\s,;()]+\\)+[^\\\s,;()]*/g, '<path>')
    .replace(/\/(?:[^/\s]+)\/(?:[^/\s]+\/)*[^/\s]*/g, '<path>')
    .replace(/file:\/\/\S+/g, '<file>');
}

export function setErrorReporting(next: ErrorReportingConfig): void {
  config = { enabled: Boolean(next?.enabled), endpoint: next?.endpoint || '' };
}

function queueReport(report: QueuedReport): void {
  if (!config.enabled) {
    return;
  }
  queue.push(report);
  if (queue.length >= 20) {
    void flush();
    return;
  }
  if (timer) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 30_000);
  timer.unref?.();
}

async function flush(): Promise<void> {
  const batch = queue.splice(0, queue.length);
  if (batch.length === 0 || !config.enabled || !config.endpoint) {
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app: 'opbs',
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        reports: batch
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch (error) {
    logger.warn(`Error report upload failed: ${error instanceof Error ? error.message : error}`);
  }
}

export function reportError(error: unknown, context?: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  queueReport({
    ts: Date.now(),
    level: 'error',
    name: err.name || 'Error',
    message: err.message || String(error),
    stack: sanitize(err.stack || ''),
    context
  });
  logger.error(`${context ? `[${context}] ` : ''}${err.message}`);
}

export function initErrorReporter(provider: () => ErrorReportingConfig): void {
  setErrorReporting(provider());
  process.on('uncaughtException', (err) => {
    reportError(err, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    reportError(reason, 'unhandledRejection');
  });
  const interval = setInterval(() => void flush(), 60_000);
  interval.unref?.();
  void flush();
}