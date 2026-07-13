export interface GithubIssueData {
  title: string;
  body: string | null;
  labels: Array<string | { name?: string }>;
}

export interface GithubClient {
  rest: {
    issues: {
      get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: GithubIssueData }>;
      createComment(params: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
      addLabels(params: { owner: string; repo: string; issue_number: number; labels: string[] }): Promise<unknown>;
      removeLabel(params: { owner: string; repo: string; issue_number: number; name: string }): Promise<unknown>;
      create(params: { owner: string; repo: string; title: string; body: string; labels?: string[] }): Promise<{ data: { number: number; html_url: string } }>;
    };
    pulls: {
      create(params: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
      }): Promise<{ data: { number: number; html_url: string } }>;
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{ data: { head: { sha: string } } }>;
      list(params: {
        owner: string;
        repo: string;
        head: string;
        state?: 'open' | 'closed' | 'all';
      }): Promise<{ data: Array<{ number: number; html_url: string }> }>;
    };
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch: string } }>;
      getContent(params: { owner: string; repo: string; path: string }): Promise<{ data: { content?: string } }>;
      getCombinedStatusForRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { state: string; total_count: number } }>;
    };
    checks: {
      listForRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { total_count?: number; check_runs: Array<{ status: string; conclusion: string | null }> } }>;
    };
  };
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
