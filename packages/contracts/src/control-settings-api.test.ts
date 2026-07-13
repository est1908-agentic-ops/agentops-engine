import { describe, expect, it } from 'vitest';
import {
  SelfHealSettingsResponseSchema,
  UpdateSelfHealSettingsRequestSchema,
} from './control-settings-api';

describe('control-settings-api', () => {
  it('parses self-heal settings response', () => {
    const parsed = SelfHealSettingsResponseSchema.parse({
      enabled: true,
      cron: '*/30 * * * *',
      scheduleActive: false,
    });
    expect(parsed.scheduleActive).toBe(false);
  });

  it('parses self-heal update request', () => {
    expect(UpdateSelfHealSettingsRequestSchema.parse({ enabled: false }).enabled).toBe(false);
  });
});