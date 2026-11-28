// The stages of the product, as data. Every stage is built by the same function (`stage.ts`) from one of the rows below and the settings of its environment; nothing in `infra/`
// or in `sst.config.ts` branches on a stage name, so what is tested on one stage is what is promoted to the next. A stage differs from another only in `stages.json` and in its settings.
import table from './stages.json' with { type: 'json' };
/** A host name: dot-separated labels of letters, digits and hyphens. */
export const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface StageConfig {
  /** The Descope project's name and tag. */
  readonly name: string;
  readonly tag: string;
  /** SST protects every resource of the stage from deletion. */
  readonly protect: boolean;
  /** Hosts of the Descope project besides the stage's own address: a stage that local runs sign in against approves the loopback names. */
  readonly localHosts: readonly string[];
  readonly nat: 'ec2' | 'managed';
  /** The stage whose VPC this stage lives in. Absent: this stage owns its VPC and the others may read it, so it must be protected (a VPC with another stage's database in it is not for removing). */
  readonly vpcFrom?: string;
  /**
   * `true`: the stage's database is an Aurora Serverless v2 cluster and **not** an RDS instance, for a stage with no instance to restore from (production). `false`: the
   * instance alone, until a snapshot moves the stage to a cluster (dev, staging). Never both: a stage that has a snapshot keeps its instance beside the cluster as the way back,
   * which is the snapshot path and not this flag (docs/operations/production-stage-plan.md section 8).
   */
  readonly aurora: boolean;
  /** One task on purpose, whatever the stage: the migrations run under a database lock, so a second task would only wait. */
  readonly service: { readonly cpu: '0.25 vCPU' | '0.5 vCPU' | '1 vCPU'; readonly memory: '2 GB' | '4 GB' };
  /** The stage's key in `stages.json`, which the app puts on every log line as `env` (`GRIMOIRE_ENV`). Set by the table reader, not written in the rows. */
  readonly env: string;
}

/**
 * The rows are in `stages.json`, a file with no code in it, because `sst.config.ts` has to read `protect` before any module can be loaded (it may not import). The memory is above the
 * collaboration memory guard (1 GiB by default, with Node, socket buffers and the Markdown worker on top of it), so the guard refuses work before the platform kills the task: every stage has
 * the same. The sizes of the row `staging` are the ones the product runs on; `dev` is the smallest that runs it.
 */
const row = (name: string, value: unknown): StageConfig => {
  const v = value as Partial<StageConfig> & { service?: Partial<StageConfig['service']> };
  const bad = (what: string): never => { throw new Error(`stages.json, stage "${name}": ${what}`); };
  if (typeof v.name !== 'string' || v.name === '' || typeof v.tag !== 'string' || v.tag === '') bad('name and tag are required');
  if (typeof v.protect !== 'boolean') bad('protect must be true or false');
  if (!Array.isArray(v.localHosts) || !v.localHosts.every((h) => typeof h === 'string' && h !== '')) bad('localHosts must be a list of hosts');
  if (v.nat !== 'ec2' && v.nat !== 'managed') bad('nat must be "ec2" or "managed"');
  if (v.vpcFrom !== undefined && (typeof v.vpcFrom !== 'string' || v.vpcFrom === '')) bad('vpcFrom must name the stage whose VPC this one lives in');
  if (v.service?.cpu !== '0.25 vCPU' && v.service?.cpu !== '0.5 vCPU' && v.service?.cpu !== '1 vCPU') bad('service.cpu must be a Fargate size this stack uses');
  if (v.service?.memory !== '2 GB' && v.service?.memory !== '4 GB') bad('service.memory must be at least the collaboration guard\'s share (2 GB)');
  if (typeof v.aurora !== 'boolean') bad('aurora must be true or false: true means the cluster and no instance');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) bad('the stage name is the app\'s GRIMOIRE_ENV: lowercase letters, digits and hyphens, starting with a letter, at most 32 characters');
  return { ...(v as Omit<StageConfig, 'env'>), env: name };
};

/**
 * The database engine, one value for every stage (what is tested on one is what is promoted to the next). A bare "17" lets a new stage take whatever minor RDS defaults to; the
 * pgvector of an instance depends on its minor (0.7.x up to 17.2, 0.8.0 from 17.3, 0.8.1 from 17.8, 0.8.2 from 17.10), and the embedding migration (0011) uses what 0.8.0 has,
 * so no stage may start below 17.3. 17.9 is what the running stage has (automatic minor upgrades are off there).
 */
export const POSTGRES_VERSION = '17.9';

export const stages: Readonly<Record<string, StageConfig>> = Object.fromEntries(Object.entries(table).map(([name, value]) => [name, row(name, value)]));

export function stageConfig(stage: string): StageConfig {
  const config = stages[stage];
  if (config === undefined) throw new Error(`Unknown stage "${stage}". The stages are: ${Object.keys(stages).join(', ')}.`);
  return config;
}

/** What the operator of a stage sets, as variables of its GitHub environment: the address, who may sign in, and who is the first administrator. */
export interface StageSettings {
  readonly domain: string;
  readonly allowedEmailDomains: readonly string[];
  readonly refusedEmailDomains: readonly string[];
  readonly firstAdminEmails: readonly string[];
  /**
   * The ARN of a snapshot of the stage's RDS instance (`GRIMOIRE_AURORA_SNAPSHOT`, an ARN because a cluster restores from an instance's snapshot by ARN only): set, the stage's database is an
   * Aurora cluster restored from it (docs/operations/database-setup.md). It stays set once the stage has moved: without it the cluster would leave the program.
   */
  readonly auroraSnapshot?: string;
}

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');

export function stageSettings(stage: string, env: Readonly<Record<string, string | undefined>>): StageSettings {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} must be set (a variable of the environment "${stage}").`);
    return value;
  };
  const domain = required('GRIMOIRE_DOMAIN');
  if (!HOST.test(domain)) throw new Error('GRIMOIRE_DOMAIN must be the host name of the site, for example app.example.test (a variable of the stage\'s environment).');
  required('GRIMOIRE_ALLOWED_EMAIL_DOMAINS');
  const snapshot = env['GRIMOIRE_AURORA_SNAPSHOT'] ?? '';
  // Named for the stage, as the runbook names it: dev and staging share an account, and a cluster restored from the other stage's snapshot would keep that data (the snapshot is ignored once the cluster exists).
  const name = /^arn:aws:rds:[a-z0-9-]+:\d{12}:snapshot:([A-Za-z][A-Za-z0-9-]*)$/.exec(snapshot)?.[1];
  if (snapshot !== '' && name?.startsWith(`grimoire-${stage}-`) !== true) {
    throw new Error(`GRIMOIRE_AURORA_SNAPSHOT must be the ARN of a snapshot of the stage's RDS instance, named for the stage (grimoire-${stage}-...), for example arn:aws:rds:us-east-1:123456789012:snapshot:grimoire-${stage}-to-aurora (a variable of the environment "${stage}").`);
  }
  return {
    domain,
    allowedEmailDomains: list(env['GRIMOIRE_ALLOWED_EMAIL_DOMAINS']),
    refusedEmailDomains: list(env['GRIMOIRE_REFUSED_EMAIL_DOMAINS']),
    firstAdminEmails: list(env['GRIMOIRE_FIRST_ADMIN_EMAILS']),
    ...(snapshot === '' ? {} : { auroraSnapshot: snapshot }),
  };
}
