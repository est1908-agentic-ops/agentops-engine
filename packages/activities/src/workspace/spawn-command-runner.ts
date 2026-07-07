import { spawn as nodeSpawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnFailed?: boolean;
}

export interface CommandRunner {
  run(command: string, opts: { cwd: string }): Promise<CommandResult>;
}

export interface SpawnCommandRunnerOptions {
  spawn?: typeof nodeSpawn;
}

export class SpawnCommandRunner implements CommandRunner {
  private readonly spawnFn: typeof nodeSpawn;

  constructor(opts: SpawnCommandRunnerOptions = {}) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
  }

  async run(command: string, opts: { cwd: string }): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = this.spawnFn(command, { cwd: opts.cwd, shell: true, env: process.env });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // A bad cwd or a missing shell emits 'error' instead of 'close' — without this
      // handler the returned promise would hang forever instead of resolving.
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr: stderr + err.message, exitCode: -1, spawnFailed: true });
      });
      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
      });
    });
  }
}
