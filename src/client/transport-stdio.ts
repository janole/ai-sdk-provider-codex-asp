import { type ChildProcessWithoutNullStreams, spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

import type {
  CodexTransport,
  CodexTransportEventMap,
  JsonRpcMessage,
} from './transport';

export interface StdioTransportSettings {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type ListenerStore = {
  [K in keyof CodexTransportEventMap]: Set<CodexTransportEventMap[K]>;
};

const DEFAULT_COMMAND = 'codex';
const DEFAULT_ARGS = ['app-server', '--listen', 'stdio://'];

export class StdioTransport implements CodexTransport {
  private readonly settings: StdioTransportSettings;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners: ListenerStore = {
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };
  private stdoutBuffer = '';

  constructor(settings: StdioTransportSettings = {}) {
    this.settings = settings;
  }

  async connect(): Promise<void> {
    if (this.process !== null) {
      return;
    }

    const options: SpawnOptionsWithoutStdio = {
      cwd: this.settings.cwd,
      env: this.settings.env,
      stdio: 'pipe',
    };

    const child = spawn(
      this.settings.command ?? DEFAULT_COMMAND,
      this.settings.args ?? DEFAULT_ARGS,
      options,
    );

    this.process = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      this.handleStdoutChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      this.emit('error', new Error(`codex stderr: ${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`));
    });

    child.on('error', (error) => {
      this.emit('error', error);
    });

    child.on('close', (code, signal) => {
      this.process = null;
      this.emit('close', code, signal);
    });
  }

  async disconnect(): Promise<void> {
    if (this.process === null) {
      return;
    }

    const child = this.process;
    this.process = null;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };

      child.once('close', () => finish());
      child.once('exit', () => finish());

      if (!child.killed) {
        child.kill();
      }

      setTimeout(finish, 250);
    });
  }

  async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (this.process === null || this.process.stdin.destroyed) {
      throw new Error('StdioTransport is not connected.');
    }

    const payload = `${JSON.stringify(message)}\n`;

    await new Promise<void>((resolve, reject) => {
      this.process?.stdin.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.sendMessage(
      params === undefined ? { method } : { method, params },
    );
  }

  on<K extends keyof CodexTransportEventMap>(
    event: K,
    listener: CodexTransportEventMap[K],
  ): () => void {
    const listeners = this.listeners[event] as Set<CodexTransportEventMap[K]>;
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    let lineBreakIndex = this.stdoutBuffer.indexOf('\n');

    while (lineBreakIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, lineBreakIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineBreakIndex + 1);

      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          this.emit('message', message);
        } catch (error) {
          this.emit('error', error);
        }
      }

      lineBreakIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private emit<K extends keyof CodexTransportEventMap>(
    event: K,
    ...args: Parameters<CodexTransportEventMap[K]>
  ): void {
    const listeners = this.listeners[event] as Set<(...handlerArgs: Parameters<CodexTransportEventMap[K]>) => void>;

    for (const listener of listeners) {
      listener(...args);
    }
  }
}
