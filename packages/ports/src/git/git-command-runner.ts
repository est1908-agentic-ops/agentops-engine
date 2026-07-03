export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
