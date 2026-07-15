import { z } from 'zod';

export const SelfHealSettingsSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().min(1),
});
export type SelfHealSettings = z.infer<typeof SelfHealSettingsSchema>;

export const SelfHealSettingsResponseSchema = SelfHealSettingsSchema.extend({
  scheduleActive: z.boolean(),
});
export type SelfHealSettingsResponse = z.infer<typeof SelfHealSettingsResponseSchema>;

export const UpdateSelfHealSettingsRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateSelfHealSettingsRequest = z.infer<typeof UpdateSelfHealSettingsRequestSchema>;
