// The shape every port-wiring call site (gateway/worker/cli) builds once a
// project has been resolved from the managed (DB-backed) project registry
// and its credential(s) decrypted. Not zod-validated -- constructed
// programmatically from a ManagedProject + decrypted token(s), never parsed
// from raw external input, so a plain discriminated type is enough; no
// registry-parsing schema exists anymore (see the Linear trigger design
// doc's DB-only addendum for why the old static PROJECT_REGISTRY_JSON
// mechanism was removed).
export type ResolvedProjectEntry =
  | {
      trackerType: 'github';
      project: string;
      repo: string;
      token: string;
    }
  | {
      trackerType: 'linear';
      project: string;
      repo: string;
      token: string;
      linearTeamKey: string;
      linearTriggerLabelId: string;
      linearToken: string;
    };
