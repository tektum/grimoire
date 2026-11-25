import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { recordProgram } from './support/record-stage.mjs';
import { fileURLToPath } from 'node:url';
import { projectConfig } from '../../../infra/descope/config.ts';
import stage from '../../../infra/stage.ts';
import { stageConfig, stageSettings, stages } from '../../../infra/stages.ts';

// The owner's rule: all stages are the same with minor configuration changes, otherwise nothing can be tested on one and promoted to the next. One function builds a stage; the stages differ
// in a row of data and in the settings of their environment, and nothing in the code looks at a stage's name.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? files(full) : [full]; });
const code = [...files(path.join(root, 'infra')).filter((f) => /\.(ts|mjs)$/.test(f)), path.join(root, 'sst.config.ts')];
const NAMES = Object.keys(stages);

test('the stages are dev and staging, every row has the same fields, and the protected one is staging', () => {
  assert.deepEqual(NAMES, ['dev', 'staging']);
  const shape = (row) => JSON.stringify(Object.keys(row).sort()) + JSON.stringify(Object.keys(row.service).sort());
  assert.equal(new Set(NAMES.map((n) => shape(stages[n]))).size, 1);
  assert.deepEqual(NAMES.filter((n) => stages[n].protect), ['staging']);
  assert.throws(() => stageConfig('descope-dev'), /Unknown stage "descope-dev"\. The stages are: dev, staging\./);
});

test('no code of the infrastructure branches on a stage, or names one: the names are in infra/stages.json and the workflow\'s choices only', () => {
  for (const file of code) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const where = path.relative(root, file);
    assert.doesNotMatch(source, /\$app\.stage\s*[=!]==|\.stage\s*[=!]==|stage\s*[=!]==\s*['"]|\[\s*['"](dev|staging)['"]\s*\]\s*\.includes|case\s+['"](dev|staging)['"]/, `${where} branches on a stage`);
    for (const name of NAMES) assert.doesNotMatch(source, new RegExp(`['"\`]${name}['"\`]`), `${where} names the stage "${name}"`);
  }
});

test('one function builds every stage, and nothing but the row and the settings reaches it', () => {
  const config = readFileSync(path.join(root, 'sst.config.ts'), 'utf8');
  assert.equal((config.match(/grimoireStage\(/g) ?? []).length, 1, 'sst.config.ts calls the one function once');
  assert.match(config, /grimoireStage\(stageConfig\(\$app\.stage\), stageSettings\(\$app\.stage, process\.env\)\)/);
  const entries = readdirSync(path.join(root, 'infra')).filter((n) => /\.ts$/.test(n)).sort();
  assert.deepEqual(entries, ['stage.ts', 'stages.ts'], 'there is no other file per stage');
});

test('the Descope project of every stage differs only in what the row and the address say', () => {
  const settings = { dev: 'dev.example.test', staging: 'app.example.test' };
  const configs = NAMES.map((n) => projectConfig(stageConfig(n), { domain: settings[n], flows: {} }));
  const strip = (c) => ({ ...c, name: '', tags: [], appUrl: '', approvedDomains: [] });
  assert.deepEqual(strip(configs[0]), strip(configs[1]));
  assert.deepEqual(configs.map((c) => c.appUrl), ['https://dev.example.test', 'https://app.example.test']);
  assert.deepEqual(configs[0].approvedDomains, ['dev.example.test', '127.0.0.1', 'localhost']);
  assert.deepEqual(configs[1].approvedDomains, ['app.example.test']);
});

test('the settings of a stage come from variables named for no stage, and a missing or wrong one stops the run naming it and the environment', () => {
  const env = { GRIMOIRE_DOMAIN: 'dev.example.test', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'a.test, b.test', GRIMOIRE_FIRST_ADMIN_EMAILS: 'boss@a.test', GRIMOIRE_REFUSED_EMAIL_DOMAINS: '' };
  assert.deepEqual(stageSettings('dev', env), { domain: 'dev.example.test', allowedEmailDomains: ['a.test', 'b.test'], refusedEmailDomains: [], firstAdminEmails: ['boss@a.test'] });
  assert.throws(() => stageSettings('staging', { ...env, GRIMOIRE_DOMAIN: '' }), /GRIMOIRE_DOMAIN must be set \(a variable of the environment "staging"\)/);
  assert.throws(() => stageSettings('dev', { ...env, GRIMOIRE_ALLOWED_EMAIL_DOMAINS: undefined }), /GRIMOIRE_ALLOWED_EMAIL_DOMAINS must be set/);
  for (const bad of ['localhost', 'https://x.test', 'x.test:8443', 'a b.test']) assert.throws(() => stageSettings('dev', { ...env, GRIMOIRE_DOMAIN: bad }), /GRIMOIRE_DOMAIN must be the host name/, bad);
  assert.equal(stageSettings('dev', { GRIMOIRE_DOMAIN: 'x.test', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'a.test' }).firstAdminEmails.length, 0);
});

const record = (name, domain, extra = {}) => recordProgram(() => stage(stageConfig(name), { domain, allowedEmailDomains: ['descope.com'], refusedEmailDomains: [], firstAdminEmails: ['omer@descope.com'], ...extra })).calls;

test('the staging stack declares exactly what it declared before the stages were one function: the same resources, names and wiring, so a deploy replaces nothing', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/staging-declarations.json', import.meta.url), 'utf8')).calls;
  assert.deepEqual(record('staging', 'grimoire.descope.io'), golden);
  assert.equal(golden.length, 29);
});

test('the operator role (docs/tenancy.md section 3.2) has a password of its own: db-setup alone receives it, and the server alone its connection', () => {
  const calls = record('staging', 'grimoire.descope.io');
  const named = (name) => calls.find((c) => c.name === name);
  assert.deepEqual(named('DbOpsPassword'), { type: 'random:RandomPassword', name: 'DbOpsPassword', args: { length: 40, special: false } });
  assert.deepEqual(named('OpsPassword'), { type: 'aws.ssm:Parameter', name: 'OpsPassword', args: { type: 'SecureString', value: '<DbOpsPassword.result>' } });
  assert.deepEqual(named('OpsUrl')?.args.type, 'SecureString');
  const ssm = Object.fromEntries(named('Server').args.containers.map((c) => [c.name, c.ssm]));
  assert.deepEqual(ssm['db-setup'].GRIMOIRE_DB_OPS_PASSWORD, '<OpsPassword.arn>');
  assert.deepEqual(ssm.app, { GRIMOIRE_DATABASE_URL: '<AppUrl.arn>', GRIMOIRE_DATABASE_OPS_URL: '<OpsUrl.arn>' });
  assert.deepEqual(Object.keys(ssm.migrate), ['GRIMOIRE_DATABASE_MIGRATION_URL']);
});

test('no two stages share a project name: Descope refuses a second project of a name that exists', () => {
  const names = Object.values(stages).map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('the dev stack declares the same resources as the staging one: they differ in the address, the project\'s name and tag, and the size of the task, and in nothing else', () => {
  const normal = (calls, domain, cpu, name, tag) => JSON.stringify(calls).replaceAll(domain, 'DOMAIN').replaceAll(cpu, 'CPU').replaceAll(name, 'NAME').replaceAll(`"${tag}"`, '"TAG"').replaceAll('"127.0.0.1","localhost"', '').replace(/,\]/g, ']').replace(/\[,/g, '[').replace(/,,/g, ',');
  const dev = normal(record('dev', 'dev.example.test'), 'dev.example.test', '0.25 vCPU', 'Grimoire dev stage', 'development');
  const staging = normal(record('staging', 'dev.example.test'), 'dev.example.test', '0.5 vCPU', 'Grimoire staging', 'staging');
  assert.equal(dev, staging);
});
