import type { ProductConfig, Stage } from '@agentops/contracts';

export type TriageLevel = 'TRIVIAL' | 'STANDARD';

export interface PreImplementInput {
  config: ProductConfig;
  triageLevel?: TriageLevel;
  hasHumanDesign: boolean;
  hasHumanPlan: boolean;
}

export function preImplementStages(input: PreImplementInput): Stage[] {
  const stages: Stage[] = ['context'];
  if (input.config.stages.assess) {
    stages.push('assess');
  }

  const triageIsTrivial = input.config.stages.triage === true && input.triageLevel === 'TRIVIAL';

  if (!triageIsTrivial || input.hasHumanDesign) {
    stages.push('design');
  }
  if (!triageIsTrivial || input.hasHumanPlan) {
    stages.push('plan');
  }

  return stages;
}
