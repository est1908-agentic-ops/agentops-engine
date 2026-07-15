import { AUTO_MERGE_DISABLE_LABEL, AUTO_MERGE_LABEL, type AutoMergeMode } from '@agentops/contracts';

export function decideMergeAuthority(input: {
  mode: AutoMergeMode;
  agentCreated: boolean;
  labels: readonly string[];
}): 'merge' | 'manual' {
  const labels = new Set(input.labels);
  if (input.mode === 'disabled' || labels.has(AUTO_MERGE_DISABLE_LABEL)) return 'manual';
  if (labels.has(AUTO_MERGE_LABEL)) return 'merge';
  return input.mode === 'all' && input.agentCreated ? 'merge' : 'manual';
}