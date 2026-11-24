import { parseArgs } from 'node:util';

export const TENANT_ADOPT_USAGE = 'usage: grimoire tenant-adopt --from <tenant id> --to <tenant id> [--name <name> --domain <domain>]';

export interface TenantAdoptArgs { readonly from: string; readonly to: string; readonly name?: string; readonly domain?: string }

/** The arguments of `grimoire tenant-adopt`, or undefined for a usage error (an unknown option, a missing value, a positional argument, no `--from` or `--to`). */
export function parseTenantAdoptArgs(args: readonly string[]): TenantAdoptArgs | undefined {
  try {
    const { values } = parseArgs({ args: [...args], options: { from: { type: 'string' }, to: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' } } });
    const { from, to, name, domain } = values;
    if (from === undefined || to === undefined) return undefined;
    return { from, to, ...(name === undefined ? {} : { name }), ...(domain === undefined ? {} : { domain }) };
  } catch {
    return undefined;
  }
}
