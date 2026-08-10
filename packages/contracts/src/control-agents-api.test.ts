import { describe, expect, it } from 'vitest';
import {
  AgentScheduleSummarySchema,
  ListAgentSchedulesResponseSchema,
  TriggerAgentResponseSchema,
  AGENT_SCHEDULE_ID_PREFIX,
  isAgentScheduleId,
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
    expect(
      TriggerAgentResponseSchema.parse({ scheduleId: 'agent:acme:nb', triggered: true }).triggered,
    ).toBe(true);
  });

  describe('isAgentScheduleId', () => {
    it('returns true for valid agent schedule ids', () => {
      expect(isAgentScheduleId('agent:acme:nb')).toBe(true);
      expect(isAgentScheduleId('agent:')).toBe(true);
    });

    it('returns false for platform schedules', () => {
      expect(isAgentScheduleId('reconcile:all')).toBe(false);
      expect(isAgentScheduleId('self-heal')).toBe(false);
    });

    it('returns false for empty and non-agent ids', () => {
      expect(isAgentScheduleId('')).toBe(false);
      expect(isAgentScheduleId('agent')).toBe(false);
    });

    it('constant equals agent prefix', () => {
      expect(AGENT_SCHEDULE_ID_PREFIX).toBe('agent:');
    });
  });
});
