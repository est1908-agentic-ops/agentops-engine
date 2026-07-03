import { describe, expect, it } from 'vitest';
import type { ProductConfig } from '@agentops/contracts';
import { preImplementStages } from './pre-implement-stages';

const baseConfig: ProductConfig = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('preImplementStages', () => {
  it('returns context, design, plan by default (no assess, no triage)', () => {
    expect(
      preImplementStages({ config: baseConfig, hasHumanDesign: false, hasHumanPlan: false }),
    ).toEqual(['context', 'design', 'plan']);
  });

  it('includes assess when config.stages.assess is true', () => {
    const config = { ...baseConfig, stages: { assess: true } };
    expect(preImplementStages({ config, hasHumanDesign: false, hasHumanPlan: false })).toEqual([
      'context',
      'assess',
      'design',
      'plan',
    ]);
  });

  it('skips design+plan when triage is TRIVIAL and no human artifacts exist', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: false,
        hasHumanPlan: false,
      }),
    ).toEqual(['context']);
  });

  it('does NOT skip design+plan when triage is STANDARD', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'STANDARD',
        hasHumanDesign: false,
        hasHumanPlan: false,
      }),
    ).toEqual(['context', 'design', 'plan']);
  });

  it('a human-authored design always wins over TRIVIAL triage', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: true,
        hasHumanPlan: false,
      }),
    ).toEqual(['context', 'design']);
  });

  it('a human-authored plan always wins over TRIVIAL triage, independent of design', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: false,
        hasHumanPlan: true,
      }),
    ).toEqual(['context', 'plan']);
  });
});
