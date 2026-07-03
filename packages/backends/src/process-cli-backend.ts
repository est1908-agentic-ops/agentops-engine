import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from './agent-backend';

export class ProcessCliProcessError extends Error {}
export class ProcessCliTimeoutError extends Error {}
export class ProcessCliAuthError extends Error {}

export interface ProcessCliBackendOptions {
  executablePath: string;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

export abstract class ProcessCliBackend implements AgentBackend {
  protected readonly executablePath: string;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;

  constructor(opts: ProcessCliBackendOptions) {
    this.executablePath = opts.executablePath;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.env = opts.env;
    this.killGraceMs = opts.killGraceMs ?? 5000;
  }

  protected abstract buildArgs(req: BackendRunRequest): string[];
  protected abstract parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult;
  protected abstract isAuthError(stderr: string): boolean;

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const args = this.buildArgs(req);
    const start = Date.now();
    const child = this.spawnFn(this.executablePath, args, {
      cwd: req.workspaceRef,
      env: this.env ?? process.env,
    });
    child.stdin?.write(req.prompt);
    child.stdin?.end();

    return new Promise<AgentRunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
        settle(() =>
          reject(new ProcessCliTimeoutError(`${this.executablePath} timed out after ${req.limits.timeoutMs}ms`)),
        );
      }, req.limits.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        settle(() => reject(new ProcessCliProcessError(`failed to spawn ${this.executablePath}: ${err.message}`)));
      });

      child.on('close', (exitCode: number | null) => {
        settle(() => {
          const wallMs = Date.now() - start;

          if (this.isAuthError(stderr)) {
            reject(new ProcessCliAuthError(stderr.trim()));
            return;
          }
          if (stdout.trim().length === 0 && (exitCode ?? 1) !== 0) {
            reject(
              new ProcessCliProcessError(
                `${this.executablePath} exited ${exitCode} with no output: ${stderr.trim()}`,
              ),
            );
            return;
          }
          resolve(this.parseOutput(stdout, stderr, wallMs));
        });
      });
    });
  }
}
