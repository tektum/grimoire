import { z } from 'zod';
import type { Config } from '@tektum/grimoire-core/ports/config';
import { parseEnv } from './schema.js';

export type Env = Readonly<Record<string, string | undefined>>;
export interface LoadOptions { readonly purpose?: 'server' | 'migrate' | 'files-setup' }

/** Lists every bad variable. Messages name the variable and the rule, never a value. */
export interface ConfigProblem { readonly setting: string; readonly rule: string }

export class ConfigError extends Error {
  readonly issues: string[];
  /** The same issues as data: log these, so a scrubber never has to guess from a name whether a rule text is safe. */
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    const issues = problems.map((p) => `${p.setting}: ${p.rule}`);
    super(`Invalid configuration:\n${issues.map((i) => `- ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
    this.problems = problems;
  }
}

/** One issue per variable, built only from schema-authored messages (zod's default messages can echo input). */
function toProblems(zodIssues: readonly z.core.$ZodIssue[]): ConfigProblem[] {
  const seen = new Set<string>();
  const issues: ConfigProblem[] = [];
  for (const issue of zodIssues) {
    const name = String(issue.path[0] ?? 'config');
    if (seen.has(name)) continue;
    seen.add(name);
    issues.push({ setting: name, rule: issue.message });
  }
  return issues;
}

export function loadConfig(env: Env, opts: LoadOptions = {}): Config {
  let result: ReturnType<typeof parseEnv>;
  try {
    result = parseEnv(env, opts.purpose ?? 'server');
  } catch {
    // Fixed text on purpose: an unexpected error must never carry input (possibly a secret) out.
    throw new ConfigError([{ setting: 'configuration', rule: 'could not be validated' }]);
  }
  if ('issues' in result) throw new ConfigError(toProblems(result.issues));
  return result.config;
}

export function loadConfigFromProcessEnv(opts?: LoadOptions): Config {
  return loadConfig(process.env, opts);
}

export { TEST_SLOW_MARKER, parseTestFacilities } from './test-facilities.js';
export type { TestFacilities } from './test-facilities.js';
