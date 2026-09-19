import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { PipeServer, PipeClient, generatePipeName, type PipeMessage } from '../../src/main/utils/pipe-ipc';

describe('Pipe IPC', () => {
  let server: PipeServer | null = null;
  let client: PipeClient | null = null;

  afterEach(() => {
    client?.close();
    server?.close();
  });

  it('generates unique pipe names', () => {
    const a = generatePipeName();
    const b = generatePipeName();
    expect(a).toMatch(/^\\\\.\\pipe\\opbs-/);
    expect(b).toMatch(/^\\\\.\\pipe\\opbs-/);
    expect(a).not.toBe(b);
  });

  it('delivers NDJSON messages from client to server', async () => {
    const pipeName = generatePipeName();
    server = new PipeServer(pipeName);
    const received: PipeMessage[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.start();

    client = new PipeClient(pipeName);
    await client.connect();

    client.send({ type: 'started' });
    client.send({ type: 'progress', phase: 'reading', percent: 50 });
    client.send({ type: 'result', ok: true });

    // Wait for messages to arrive.
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe('started');
    expect(received[1].type).toBe('progress');
    expect((received[1] as any).phase).toBe('reading');
    expect(received[2].type).toBe('result');
    expect((received[2] as any).ok).toBe(true);
  });

  it('handles partial NDJSON (message split across writes)', async () => {
    const pipeName = generatePipeName();
    server = new PipeServer(pipeName);
    const received: PipeMessage[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.start();

    client = new PipeClient(pipeName);
    await client.connect();

    // Write a message in two parts.
    const socket = (client as any).socket as net.Socket;
    socket.write('{"type":"pro');
    socket.write('gress","percent":42}\n');

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('progress');
    expect((received[0] as any).percent).toBe(42);
  });

  it('ignores malformed JSON lines', async () => {
    const pipeName = generatePipeName();
    server = new PipeServer(pipeName);
    const received: PipeMessage[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.start();

    client = new PipeClient(pipeName);
    await client.connect();

    const socket = (client as any).socket as net.Socket;
    socket.write('not valid json\n');
    socket.write('{"type":"started"}\n');

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('started');
  });

  it('server.send sends data to the client', async () => {
    const pipeName = generatePipeName();
    server = new PipeServer(pipeName);
    await server.start();

    client = new PipeClient(pipeName);
    await client.connect();

    // Wait for the server to register the client socket.
    await new Promise((r) => setTimeout(r, 200));

    const received: string[] = [];
    const socket = (client as any).socket as net.Socket;
    socket.setEncoding('utf-8');
    socket.on('data', (data: string) => received.push(data));

    expect(server.send({ type: 'cancel' })).toBe(true);

    // Wait for data to arrive (may need a bit longer on Windows named pipes).
    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBeGreaterThan(0);
    const msg = JSON.parse(received[0].trim());
    expect(msg.type).toBe('cancel');
  });

  it('client.send returns false when not connected', () => {
    client = new PipeClient(generatePipeName());
    expect(client.send({ type: 'started' })).toBe(false);
  });

  it('server.connected reflects connection state', async () => {
    const pipeName = generatePipeName();
    server = new PipeServer(pipeName);
    await server.start();

    expect(server.connected).toBe(false);

    client = new PipeClient(pipeName);
    await client.connect();
    // Give the server a moment to register the connection.
    await new Promise((r) => setTimeout(r, 50));

    expect(server.connected).toBe(true);
  });
});
