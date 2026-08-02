export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly nonRetryable: boolean = false,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
