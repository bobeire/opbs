import * as https from 'https';
import * as http from 'http';
import { logger } from './logger';

export interface NotifyPayload {
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Best-effort notification delivery. Tries a native toast when running under
 * Electron, then optionally fires an empty worker to a webhook URL. It never
 * throws - failed notifications degrade to a log line.
 */
export async function tryNotify(payload: NotifyPayload, webhookUrl?: string): Promise<void> {
  try {
    showToast(payload);
  } catch (err) {
    logger.warn(`Toast failed: ${err instanceof Error ? err.message : err}`);
  }

  if (webhookUrl) {
    await postWebhook(webhookUrl, payload).catch((err) => {
      logger.warn(`Webhook to ${webhookUrl} failed: ${err instanceof Error ? err.message : err}`);
    });
  }
}

function showToast(payload: NotifyPayload): void {
  // Importing electron is only valid inside the main process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | undefined;
  const Notification = electron?.Notification;
  if (Notification && Notification.isSupported()) {
    new Notification({ title: payload.title, body: payload.body }).show();
    return;
  }
  logger.info(`Notify (no toast available): ${payload.title} - ${payload.body}`);
}

function postWebhook(urlString: string, payload: NotifyPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ title: payload.title, body: payload.body, severity: payload.severity });
    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        res.resume();
        resolve();
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}