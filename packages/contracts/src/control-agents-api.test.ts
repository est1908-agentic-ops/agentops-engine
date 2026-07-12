import { describe, expect, it } from 'vitest';
import {
  AgentScheduleSummarySchema,
  ListAgentSchedulesResponseSchema,
  TriggerAgentResponseSchema,
} from './control-agents-api';

describe('control-agents-api', () => {
  it('parses an agent schedule summary', () => {
    const s = AgentScheduleSummarySchema.parse({
      scheduleId: 'agent:acme:nb',
      project: 'acme',
      agentName: 'nb',
      workflow: 'whiteboxBugHunt',
      cron: '0 2 * * *',
      paused: false,
    });
    expect(s.project).toBe('acme');
  });

  it('parses list + trigger responses', () => {
    expect(ListAgentSchedulesResponseSchema.parse({ agents: [] }).agents).toEqual([]);
    expect(TriggerAgentResponseSchema.parse({ scheduleId: 'agent:acme:nb', triggered: true }).triggered).toBe(true);
  });
});