// Narrow facade over Linear's GraphQL API -- only what LinearTrackerPort
// needs, not a general Linear SDK (mirrors GithubClient's role for
// GithubTrackerPort/GithubScmPort). `id` arguments throughout accept either
// a UUID or the shorthand identifier ("ENG-123") interchangeably, per
// Linear's own docs -- LinearTrackerPort still resolves and threads the real
// UUID through mutations rather than relying on that everywhere, since it's
// only documented for entity lookups, not confirmed for every mutation input.
export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  labelIds: string[];
  labelNames: string[];
}

export interface LinearClient {
  getIssue(identifier: string): Promise<LinearIssueData>;
  createComment(issueId: string, body: string): Promise<void>;
  findLabelId(teamKey: string, name: string): Promise<string | null>;
  setLabelIds(issueId: string, labelIds: string[]): Promise<void>;
}

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

export class LinearGraphqlClient implements LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`LinearGraphqlClient: request failed with status ${res.status}`);
    }
    const body = (await res.json()) as LinearGraphqlResponse<T>;
    if (body.errors?.length) {
      throw new Error(`LinearGraphqlClient: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error('LinearGraphqlClient: response had no data');
    }
    return body.data;
  }

  async getIssue(identifier: string): Promise<LinearIssueData> {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          labels { nodes { id name } }
        }
      }
    `;
    const data = await this.request<{
      issue: { id: string; identifier: string; title: string; description: string | null; labels: { nodes: Array<{ id: string; name: string }> } };
    }>(query, { id: identifier });
    return {
      id: data.issue.id,
      identifier: data.issue.identifier,
      title: data.issue.title,
      description: data.issue.description,
      labelIds: data.issue.labels.nodes.map((label) => label.id),
      labelNames: data.issue.labels.nodes.map((label) => label.name),
    };
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const query = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }
    `;
    await this.request(query, { issueId, body });
  }

  async findLabelId(teamKey: string, name: string): Promise<string | null> {
    const query = `
      query($teamKey: String!, $name: String!) {
        issueLabels(filter: { team: { key: { eq: $teamKey } }, name: { eq: $name } }) {
          nodes { id }
        }
      }
    `;
    const data = await this.request<{ issueLabels: { nodes: Array<{ id: string }> } }>(query, { teamKey, name });
    return data.issueLabels.nodes[0]?.id ?? null;
  }

  async setLabelIds(issueId: string, labelIds: string[]): Promise<void> {
    const query = `
      mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) { success }
      }
    `;
    await this.request(query, { issueId, labelIds });
  }
}
