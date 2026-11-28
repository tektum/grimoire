// What each stage's Descope project is made of, as plain data (no SST, no network), so it can be tested. `project.ts` turns it into resources.
// Everything in a project is code here: nothing is edited in the console, and no role, permission or tenant is created, because the product authorizes with its own database.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildStyles, readTokens } from './theme.ts';
import type { TokenSets } from './theme.ts';
import { HOST, PRODUCTION_ENVIRONMENT } from '../stages.ts';
import type { StageConfig } from '../stages.ts';

export interface ProjectConfig {
  readonly name: string;
  readonly tags: readonly string[];
  /** Left unset for every stage but the customer-facing one, which carries the provider's own environment value for it. */
  readonly environment: string | undefined;
  readonly appUrl: string;
  /** Hosts only, no port: the provider takes none. */
  readonly approvedDomains: readonly string[];
  readonly session: { readonly sessionTokenExpiration: string; readonly refreshTokenExpiration: string; readonly refreshTokenRotation: boolean };
  /** Methods the project switches off: the sign-in flow is a one-time code by email and nothing else. */
  readonly disabledMethods: readonly ('password' | 'magiclink' | 'enchantedlink' | 'embeddedlink' | 'totp' | 'passkey' | 'oauth')[];
  readonly otp: { readonly expirationTime: string };
  /** The claims of the session token the server reads (see docs/tenancy.md): the person's tenant (`dct`, from the template's automatic current-tenant claim) and the profile, so the server needs no management key. */
  readonly userToken: { readonly name: string; readonly description: string; readonly claims: Readonly<Record<string, string>> };
  readonly flows: Readonly<Record<string, string>>;
  readonly styles: string;
}

/**
 * The flows of a project: every `.json` file of `infra/descope/flows`, the file name (without `.json`) being the flow id and the content the console's export of the flow, as JSON text.
 * An empty folder is an error, and a file that is not JSON stops the run, so a flow added to the folder is deployed or the deploy fails.
 */
export function readFlows(repoRoot: string = process.cwd()): Record<string, string> {
  const dir = path.join(repoRoot, 'infra/descope/flows');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`${dir} has no flow: a project needs its sign-in flow`);
  return Object.fromEntries(files.map((name) => [name.slice(0, -'.json'.length), JSON.stringify(JSON.parse(readFileSync(path.join(dir, name), 'utf8')))]));
}

export function projectConfig(stage: StageConfig, options: { readonly domain: string; readonly tokens?: TokenSets; readonly flows?: Record<string, string> }): ProjectConfig {
  const common = {
    name: stage.name,
    tags: ['grimoire', stage.tag],
    // The provider's own flag for a customer-facing project (`StageConfig.production`): the provider keeps Static OTP for test users on a project that is not marked, so only the
    // stage whose row says it is customer-facing marks it. Data, not a name: no code here may branch on a stage's name (tools/ci/test/stage-parity.test.mjs).
    environment: stage.production ? PRODUCTION_ENVIRONMENT : undefined,
    session: { sessionTokenExpiration: '10 minutes', refreshTokenExpiration: '3 weeks', refreshTokenRotation: true },
    disabledMethods: ['password', 'magiclink', 'enchantedlink', 'embeddedlink', 'totp', 'passkey', 'oauth'] as const,
    otp: { expirationTime: '5 minutes' },
    userToken: {
      name: 'grimoire-user',
      description: 'The tenant and the profile of the person, read by the server',
      claims: { email: '{{user.email}}', name: '{{user.name}}', emailVerified: '{{user.verifiedEmail}}' },
    },
    flows: options.flows ?? readFlows(),
    styles: JSON.stringify(buildStyles(options.tokens ?? readTokens())),
  };
  const domain = options.domain;
  if (!HOST.test(domain)) throw new Error('GRIMOIRE_DOMAIN must be the host name of the site, for example app.example.test (a variable of the stage\'s environment).');
  return { ...common, appUrl: `https://${domain}`, approvedDomains: [domain, ...stage.localHosts] };
}
