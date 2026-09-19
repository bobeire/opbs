import * as net from 'net';
import * as crypto from 'crypto';
import { logger } from './logger';

/**
 * Named-pipe IPC for OPBS elevated helper jobs.
 *
 * Replaces the polling-based temp-file protocol with a real-time stream.
 * The parent creates a pipe server; the elevated helper connects as a client
 * and writes newline-delimited JSON messages (NDJSON).
 *
 * Message types:
 *   { type: "started" }                          — helper booted, elevation confirmed
 *   { type: "progress", phase, percent, ... }    — progress update
 *   { type: "result", ok, error, ... }           — job complete
 *   { type: "cancelled" }                        — cancel acknowledged
 */

export type PipeMessage =
  | { type: 'started' }
  | { type: 'progress'; [key: string]: unknown }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'cancelled' };

export const PIPE_PREFIX = '\\\\.\\pipe\\opbs-';

/**
 * Generate a unique pipe name for a job.
 */
export function generatePipeName(): string {
  return `${PIPE_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Pipe server — runs in the parent process. Creates a named pipe, waits for
 * the helper to connect, and emits parsed NDJSON messages.
 */
export class PipeServer {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private messageHandler: ((msg: PipeMessage) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(public readonly pipeName: string) {}

  /**
   * Start listening for the helper connection. Resolves once the server is
   * ready (before the helper connects).
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.socket = socket;
        socket.setEncoding('utf-8');
        socket.on('data', (data: string) => this.onData(data));
        socket.on('error', (err) => {
          logger.warn(`Pipe socket error: ${err.message}`);
          this.errorHandler?.(err);
        });
        socket.on('close', () => {
          this.closeHandler?.();
        });
      });

      this.server.on('error', (err) => {
        logger.error(`Pipe server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.pipeName, () => {
        resolve();
      });
    });
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: (msg: PipeMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler for errors.
   */
  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Register a handler for connection close.
   */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /**
   * Send a message to the helper (e.g., cancel signal).
   * Returns false if the socket is not connected.
   */
  send(msg: unknown): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the server and any active connection.
   */
  close(): void {
    try { this.socket?.destroy(); } catch { /* already closed */ }
    try { this.server?.close(); } catch { /* already closed */ }
    this.server = null;
    this.socket = null;
  }

  /**
   * Whether the helper has connected.
   */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as PipeMessage;
        this.messageHandler?.(msg);
      } catch {
        logger.warn(`Pipe: ignoring malformed message: ${trimmed.slice(0, 120)}`);
      }
    }
  }
}

/**
 * Pipe client — runs in the elevated helper process. Connects to the pipe
 * server created by the parent and writes NDJSON messages.
 */
export class PipeClient {
  private socket: net.Socket | null = null;
  private connected = false;

  constructor(private readonly pipeName: string) {}

  /**
   * Connect to the pipe server. Resolves once connected.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.pipeName, () => {
        this.connected = true;
        resolve();
      });
      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
      });
      this.socket.on('close', () => {
        this.connected = false;
      });
    });
  }

  /**
   * Send a message to the parent. Returns false if not connected.
   */
  send(msg: unknown): boolean {
    if (!this.connected || !this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the connection.
   */
  close(): void {
    try { this.socket?.end(); } catch { /* already closed */ }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
