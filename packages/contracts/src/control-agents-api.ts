import { z } from 'zod';

export const AgentScheduleSummarySchema = z.object({
  scheduleId: z.string().min(1),
  project: z.string().min(1),
  agentName: z.string().min(1),
  workflow: z.string().min(1),
  cron: z.string().min(1),
  paused: z.boolean(),
  nextRun: z.string().optional(),
});
export type AgentScheduleSummary = z.infer<typeof AgentScheduleSummarySchema>;

export const ListAgentSchedulesResponseSchema = z.object({
  agents: z.array(AgentScheduleSummarySchema),
});
export type ListAgentSchedulesResponse = z.infer<typeof ListAgentSchedulesResponseSchema>;

export const TriggerAgentResponseSchema = z.object({
  scheduleId: z.string().min(1),
  triggered: z.boolean(),
});
export type TriggerAgentResponse = z.infer<typeof TriggerAgentResponseSchema>;