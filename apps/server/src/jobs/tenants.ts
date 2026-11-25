/** Runs `work` for each tenant in turn, stopping at the next tenant when the signal aborts. A tenant that fails does not stop the others; the first failure is thrown at the end so the job is retried. */
export async function forEachTenant(ids: readonly string[], signal: AbortSignal, work: (tenantId: string) => Promise<void>): Promise<void> {
  let failure: { readonly error: unknown } | undefined;
  for (const tenantId of ids) {
    if (signal.aborted) break;
    try {
      await work(tenantId);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
