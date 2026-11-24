// What each stage's Descope project is made of, as plain data (no SST, no network), so it can be tested. `project.ts` turns it into resources.
// Everything in a project is code here: nothing is edited in the console, and no role, permission or tenant is created, because the product authorizes with its own database.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildStyles, readTokens } from './theme.ts';
import type { TokenSets } from './theme.ts';

export type DescopeStage = 'descope-dev' | 'staging';

export interface ProjectConfig {
  readonly name: string;
  readonly tags: readonly string[];
  /** Left unset for development and staging projects; `production` only for a production project. */
  readonly environment: string | undefined;
  readonly appUrl: string;
  /** Hosts only, no port: the provider takes none. */
  readonly approvedDomains: readonly string[];
  readonly session: { readonly sessionTokenExpiration: string; readonly refreshTokenExpiration: string; readonly refreshTokenRotation: boolean };
  /** Methods the project switches off: the sign-in flow is a one-time code by email and nothing else. */
  readonly disabledMethods: readonly ('password' | 'magiclink' | 'enchantedlink' | 'embeddedlink' | 'totp' | 'passkey' | 'oauth')[];
  readonly otp: { readonly expirationTime: string };
  readonly flows: Readonly<Record<string, string>>;
  readonly styles: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const stageNames: Record<DescopeStage, string> = { 'descope-dev': 'Grimoire development', staging: 'Grimoire staging' };

/** The flows of a project: file name (without `.json`) is the flow id; the content is the console's export of the flow, as JSON text. */
export function readFlows(repoRoot: string = process.cwd()): Record<string, string> {
  const dir = path.join(repoRoot, 'infra/descope/flows');
  return Object.fromEntries(['sign-up-or-in'].map((id) => [id, JSON.stringify(JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')))]));
}

export function projectConfig(stage: DescopeStage, options: { readonly stagingDomain?: string | undefined; readonly tokens?: TokenSets; readonly flows?: Record<string, string> } = {}): ProjectConfig {
  const common = {
    name: stageNames[stage],
    tags: ['grimoire', stage === 'descope-dev' ? 'development' : stage],
    environment: undefined,
    session: { sessionTokenExpiration: '10 minutes', refreshTokenExpiration: '3 weeks', refreshTokenRotation: true },
    disabledMethods: ['password', 'magiclink', 'enchantedlink', 'embeddedlink', 'totp', 'passkey', 'oauth'] as const,
    otp: { expirationTime: '5 minutes' },
    flows: options.flows ?? readFlows(),
    styles: JSON.stringify(buildStyles(options.tokens ?? readTokens())),
  };
  if (stage === 'descope-dev') return { ...common, appUrl: 'http://127.0.0.1:4173', approvedDomains: ['127.0.0.1', 'localhost'] };
  const domain = options.stagingDomain;
  if (domain === undefined || !HOST.test(domain)) throw new Error('STAGING_DOMAIN must be the host name of the staging site, for example app.example.test (a variable of the staging environment)');
  return { ...common, appUrl: `https://${domain}`, approvedDomains: [domain] };
}
