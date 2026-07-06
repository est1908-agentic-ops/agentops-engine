export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  // True only when the child process itself could not be spawned (e.g. the
  // `git` binary is missing) — as opposed to git running and exiting
  // non-zero. Lets callers tell a permanent environment defect (retrying
  // won't help) apart from a transient failure (e.g. a network blip during
  // clone/fetch), which should still retry.
  spawnFailed?: boolean;
}

export interface GitCommandRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
