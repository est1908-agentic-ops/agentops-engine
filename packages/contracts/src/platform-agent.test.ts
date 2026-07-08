import { describe, expect, it } from 'vitest';
import {
  PlatformAgentInputSchema,
  PlatformAgentResultSchema,
  PlatformSentinelSchema,
} from './platform-agent';

describe('PlatformAgentInputSchema', () => {
  it('requires a non-empty prompt', () => {
    expect(() => PlatformAgentInputSchema.parse({ prompt: '' })).toThrow();
  });

  it('allows hintRepos to be omitted', () => {
    const parsed = PlatformAgentInputSchema.parse({ prompt: 'check the last failures' });
    expect(parsed.hintRepos).toBeUndefined();
  });

  it('accepts hintRepos as a list of repo slugs', () => {
    const parsed = PlatformAgentInputSchema.parse({
      prompt: 'check the last failures',
      hintRepos: ['flair-hr/agentops-engine'],
    });
    expect(parsed.hintRepos).toEqual(['flair-hr/agentops-engine']);
  });
});

describe('PlatformSentinelSchema', () => {
  it('defaults actionsTaken and proposedFixes to empty arrays', () => {
    const parsed = PlatformSentinelSchema.parse({ summary: 'all quiet' });
    expect(parsed.actionsTaken).toEqual([]);
    expect(parsed.proposedFixes).toEqual([]);
  });

  it('parses actionsTaken and proposedFixes when present', () => {
    const parsed = PlatformSentinelSchema.parse({
      summary: 'found one bug',
      actionsTaken: [
        { type: 'terminate', workflowId: 'issue-broccoli-94', reason: 'stuck retry loop' },
      ],
      proposedFixes: [{ repo: 'flair-hr/agentops-engine', goal: 'bound retry attempts' }],
    });
    expect(parsed.actionsTaken).toHaveLength(1);
    expect(parsed.proposedFixes).toHaveLength(1);
  });

  it('rejects an actionsTaken entry with an invalid type', () => {
    expect(() =>
      PlatformSentinelSchema.parse({
        summary: 'x',
        actionsTaken: [{ type: 'restart', workflowId: 'w', reason: 'r' }],
      }),
    ).toThrow();
  });
});

describe('PlatformAgentResultSchema', () => {
  it('defaults actionsTaken, childWorkflows, and skippedFixes to empty arrays', () => {
    const parsed = PlatformAgentResultSchema.parse({ summary: 'all quiet' });
    expect(parsed.actionsTaken).toEqual([]);
    expect(parsed.childWorkflows).toEqual([]);
    expect(parsed.skippedFixes).toEqual([]);
  });

  it('parses a result with child workflows', () => {
    const parsed = PlatformAgentResultSchema.parse({
      summary: 'opened one fix',
      childWorkflows: [
        { workflowId: 'platform-1-fix-1', repo: 'flair-hr/agentops-engine', goal: 'bound retries' },
      ],
    });
    expect(parsed.childWorkflows).toHaveLength(1);
  });

  it('parses a result with skipped fixes', () => {
    const parsed = PlatformAgentResultSchema.parse({
      summary: 'found one bug',
      skippedFixes: [
        {
          repo: 'agentic-ops/agent-runner',
          goal: 'add retry backoff',
          reason: 'no project registered for repo "agentic-ops/agent-runner"',
        },
      ],
    });
    expect(parsed.skippedFixes).toHaveLength(1);
  });
});
