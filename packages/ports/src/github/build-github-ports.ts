import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { GithubClient } from './github-client';
import { GithubScmPort } from './github-scm-port';
import { GithubTrackerPort } from './github-tracker-port';

export interface GithubPorts {
  scm: GithubScmPort;
  tracker: GithubTrackerPort;
}

function createGithubClient(token: string): GithubClient {
  const rest = new Octokit({ auth: token });
  const gql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
  // REST + GraphQL are separate packages; GithubClient is the narrow facade both ports share.
  return { rest: rest.rest, graphql: gql } as unknown as GithubClient;
}

export function createGithubPorts(token: string, git: GitCommandRunner): GithubPorts {
  const client = createGithubClient(token);
  return { scm: new GithubScmPort(client, git), tracker: new GithubTrackerPort(client) };
}
