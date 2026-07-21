import { spawn as nodeSpawn } from 'node:child_process';
import type { GitCommandResult, GitCommandRunner } from '@agentops/ports';

export interface SpawnGitCommandRunnerOptions {
  spawn?: typeof nodeSpawn;
  authToken?: () => string | undefined;
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  private readonly spawnFn: typeof nodeSpawn;
  private readonly authToken?: () => string | undefined;

  constructor(opts: SpawnGitCommandRunnerOptions = {}) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.authToken = opts.authToken;
  }

  async run(args: string[], opts: { cwd: string }): Promise<GitCommandResult> {
    const token = this.authToken?.();
    const env: Record<string, string> = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }

    return new Promise((resolve) => {
      const child = this.spawnFn('git', args, {
        cwd: opts.cwd,
        env,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // A bad cwd or a missing `git` binary emits 'error' instead of 'close' — without
      // this handler the returned promise would hang forever instead of resolving.
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
