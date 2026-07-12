// temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD — the stable
// proto enum value for a Keyword-typed search attribute. Used as a literal to
// avoid a direct @temporalio/proto dependency in the worker.
const KEYWORD = 2;

// Custom search attributes the reconciler / Schedule action / continuous-start
// stamp on every reconciled agent run (SP2 design §7). Temporal validates search
// attributes at write time, so these must exist in the namespace before the first
// Schedule create — otherwise create() is rejected with INVALID_ARGUMENT
// ("search attribute <name> is not defined"). The worker ensures them at boot so
// there's no manual pre-deploy registration step (scripts/register-search-attributes.sh
// stays as a manual fallback).
export const CUSTOM_SEARCH_ATTRIBUTES = ['project', 'agentName', 'workflowType'] as const;

export interface OperatorConnectionLike {
  operatorService: {
    addSearchAttributes(req: { namespace?: string; searchAttributes?: Record<string, number> }): Promise<unknown>;
  };
}

// Idempotently register the custom search attributes. Registered one at a time
// on purpose: Temporal's AddSearchAttributes fails the whole batch with
// AlreadyExists if ANY attribute in it already exists, so a batched call would
// never add a genuinely-new attribute once one is present. Per-attribute calls
// make each independently idempotent (mirrors the shell fallback's loop).
export async function ensureSearchAttributes(
  connection: OperatorConnectionLike,
  namespace: string | undefined,
): Promise<void> {
  const ns = namespace ?? 'default';
  for (const name of CUSTOM_SEARCH_ATTRIBUTES) {
    try {
      await connection.operatorService.addSearchAttributes({ namespace: ns, searchAttributes: { [name]: KEYWORD } });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
}

function isAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exist|already registered|alreadyexists/i.test(msg);
}
