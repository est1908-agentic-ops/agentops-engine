// The single Temporal task queue the engine fleet polls: all built-in
// workflows (devCycle, platform, whiteboxBugHunt, configSync) and every
// engine activity. Tier-2 project workflows target it via the SDK's
// engineActivities()/childDevCycle() so privileged work runs on the engine's
// credential-holding workers. This VALUE is part of the published SDK's
// semver compatibility contract — do not change it without a major bump.
export const ENGINE_QUEUE = 'agentops-engine';

// The pre-SP2 queue name. The engine polls it too during the cutover so any
// Schedule still pointing here is served until the reconciler re-points it
// (see reconcile-agents ExistingSchedule.taskQueue). Remove in a follow-up.
export const LEGACY_ENGINE_QUEUE = 'agentops-devcycle';
