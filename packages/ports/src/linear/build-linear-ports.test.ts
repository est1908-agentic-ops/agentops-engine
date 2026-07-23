import { describe, expect, it, vi } from 'vitest';
import { createLinearTracker } from './build-linear-ports';
import { LinearTrackerPort } from './linear-tracker-port';

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('createLinearTracker', () => {
  it('returns a LinearTrackerPort instance', () => {
    // Also proves construction never makes a network call: LinearGraphqlClient's
    // constructor only stores the token and fetchImpl, no request is issued until
    // a client method is called — this synchronous call would throw or hang otherwise.
    const tracker = createLinearTracker('fake-token');

    expect(tracker).toBeInstanceOf(LinearTrackerPort);
  });

  it('wires the GraphQL client into the port, routing tracker calls through the vendor client', async () => {
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
    const tracker = createLinearTracker('fake-token', fetchImpl);

    const issue = await tracker.getIssue('linear:ENG-1');

    expect(issue).toEqual({
      ref: 'linear:ENG-1',
      title: 'Fix the thing',
      body: 'body text',
      labels: ['agentops'],
    });
    // Confirm the fake fetch was called with the Linear endpoint.
    const [endpoint] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(endpoint).toBe('https://api.linear.app/graphql');
  });
});
