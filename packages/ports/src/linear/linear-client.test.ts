import { describe, expect, it, vi } from 'vitest';
import { LinearGraphqlClient } from './linear-client';

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('LinearGraphqlClient', () => {
  it('sends the API key as a raw Authorization header, no Bearer prefix', async () => {
    const fetchImpl = fakeFetch({
      data: { issue: { id: 'uuid-1', identifier: 'ENG-1', title: 't', description: null, labels: { nodes: [] } } },
    });
    const client = new LinearGraphqlClient('lin_api_key', fetchImpl);

    await client.getIssue('ENG-1');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe('lin_api_key');
  });

  it('parses an issue, mapping labels to ids and names', async () => {
    const fetchImpl = fakeFetch({
      data: {
        issue: {
          id: 'uuid-1',
          identifier: 'ENG-1',
          title: 'Fix the thing',
          description: 'body text',
          labels: { nodes: [{ id: 'label-uuid', name: 'agentops' }] },
        },
      },
    });
    const client = new LinearGraphqlClient('key', fetchImpl);

    const issue = await client.getIssue('ENG-1');

    expect(issue).toEqual({
      id: 'uuid-1',
      identifier: 'ENG-1',
      title: 'Fix the thing',
      description: 'body text',
      labelIds: ['label-uuid'],
      labelNames: ['agentops'],
    });
  });

  it('throws when the HTTP response is not ok', async () => {
    const fetchImpl = fakeFetch({}, false, 401);
    const client = new LinearGraphqlClient('key', fetchImpl);

    await expect(client.getIssue('ENG-1')).rejects.toThrow(/status 401/);
  });

  it('throws when the GraphQL response carries errors', async () => {
    const fetchImpl = fakeFetch({ errors: [{ message: 'not found' }] });
    const client = new LinearGraphqlClient('key', fetchImpl);

    await expect(client.getIssue('ENG-1')).rejects.toThrow(/not found/);
  });

  it('finds a label id by team and name, or null when absent', async () => {
    const fetchImpl = fakeFetch({ data: { issueLabels: { nodes: [{ id: 'label-uuid' }] } } });
    const client = new LinearGraphqlClient('key', fetchImpl);

    expect(await client.findLabelId('ENG', 'agentops')) .toBe('label-uuid');

    const emptyFetch = fakeFetch({ data: { issueLabels: { nodes: [] } } });
    const emptyClient = new LinearGraphqlClient('key', emptyFetch);
    expect(await emptyClient.findLabelId('ENG', 'missing')).toBeNull();
  });

  it('createComment and setLabelIds send the expected variables', async () => {
    const fetchImpl = fakeFetch({ data: { commentCreate: { success: true } } });
    const client = new LinearGraphqlClient('key', fetchImpl);

    await client.createComment('issue-uuid', 'hello');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.variables).toEqual({ issueId: 'issue-uuid', body: 'hello' });
  });
});
