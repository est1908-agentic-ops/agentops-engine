import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from './agent-backend';
import type { CliSpec } from './cli-spec';

export class ProcessCliProcessError extends Error {}
export class ProcessCliTimeoutError extends Error {}
export class ProcessCliAuthError extends Error {}

export interface ProcessCliRunnerOptions {
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

export class ProcessCliRunner implements AgentBackend {
  private readonly spawnFn: typeof nodeSpawn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;

  constructor(
    private readonly spec: CliSpec,
    opts: ProcessCliRunnerOptions = {},
  ) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.env = opts.env;
    this.killGraceMs = opts.killGraceMs ?? 5000;
  }

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const args = this.spec.buildArgs(req);
    const start = Date.now();
    const child = this.spawnFn(this.spec.binary, args, {
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
          reject(new ProcessCliTimeoutError(`${this.spec.binary} timed out after ${req.limits.timeoutMs}ms`)),
        );
      }, req.limits.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        settle(() => reject(new ProcessCliProcessError(`failed to spawn ${this.spec.binary}: ${err.message}`)));
      });

      child.on('close', (exitCode: number | null) => {
        settle(() => {
          const wallMs = Date.now() - start;

          if (this.spec.isAuthError(stderr)) {
            reject(new ProcessCliAuthError(stderr.trim()));
            return;
          }
          if (stdout.trim().length === 0 && (exitCode ?? 1) !== 0) {
            reject(
              new ProcessCliProcessError(
                `${this.spec.binary} exited ${exitCode} with no output: ${stderr.trim()}`,
              ),
            );
            return;
          }
          try {
            resolve(this.spec.parseOutput(stdout, stderr, wallMs));
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
}
