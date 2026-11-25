import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { recordProgram } from './support/record-stage.mjs';
import { fileURLToPath } from 'node:url';
import { projectConfig } from '../../../infra/descope/config.ts';
import stage from '../../../infra/stage.ts';
import { POSTGRES_VERSION, stageConfig, stageSettings, stages } from '../../../infra/stages.ts';

// The owner's rule: all stages are the same with minor configuration changes, otherwise nothing can be tested on one and promoted to the next. One function builds a stage; the stages differ
// in a row of data and in the settings of their environment, and nothing in the code looks at a stage's name.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? files(full) : [full]; });
const code = [...files(path.join(root, 'infra')).filter((f) => /\.(ts|mjs)$/.test(f)), path.join(root, 'sst.config.ts')];
const NAMES = Object.keys(stages);

test('the stages are dev and staging, every row has the same fields, and the protected one is staging', () => {
  assert.deepEqual(NAMES, ['dev', 'staging']);
  const shape = (row) => JSON.stringify(Object.keys(row).filter((k) => k !== 'vpcFrom').sort()) + JSON.stringify(Object.keys(row.service).sort());
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

test('the staging stack declares what its fixture holds: every resource it had before, under the same name, plus the security groups of the shared VPC, so a deploy replaces nothing', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/staging-declarations.json', import.meta.url), 'utf8')).calls;
  assert.deepEqual(record('staging', 'grimoire.descope.io'), golden);
  const before = ["Project", "Settings", "Otp", "UserToken", "Session", "Password", "Magiclink", "Enchantedlink", "Embeddedlink", "Totp", "Passkey", "Oauth", "Styles", "Flow-sign-up-or-in", "Vpc", "Db", "DbAppPassword", "DbMigratorPassword", "DbOpsPassword", "Files", "Cluster", "AdminUrl", "AppPassword", "MigratorPassword", "OpsPassword", "MigratorUrl", "AppUrl", "OpsUrl", "Server"];
  const added = golden.map((c) => c.name).filter((n) => !before.includes(n));
  assert.ok(before.every((n) => golden.some((c) => c.name === n)), 'every resource of before is still declared, under the same name');
  assert.ok(added.length > 0 && added.every((n) => /^(Service|Db|VpcFlow|VpcDefault)/.test(n)), `what is new belongs to the network: ${added}`);
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
  const sameNetwork = (calls) => calls.filter((c) => !/^Vpc/.test(c.name)); // the one allowed difference: the stage that owns the VPC makes it, the others read it
  const dev = normal(sameNetwork(record('dev', 'dev.example.test')), 'dev.example.test', '0.25 vCPU', 'Grimoire dev stage', 'development');
  const staging = normal(sameNetwork(record('staging', 'dev.example.test')), 'dev.example.test', '0.5 vCPU', 'Grimoire staging', 'staging');
  assert.equal(dev, staging);
});

test('every stage runs one pinned Postgres minor, never below 17.3, so no stage can start with a pgvector older than the embedding migration needs', () => {
  const minor = /^17\.(\d+)$/.exec(POSTGRES_VERSION);
  assert.ok(minor, `POSTGRES_VERSION is "17.<minor>", not a bare major that lets RDS pick: ${POSTGRES_VERSION}`);
  assert.ok(Number(minor[1]) >= 3, 'RDS for PostgreSQL 17 has pgvector 0.8.0 from 17.3; 17.2 has 0.7.4');
  for (const name of NAMES) {
    const versions = record(name, 'any.example.test').filter((c) => c.type === 'sst.aws:Postgres').map((c) => c.args.version);
    assert.deepEqual(versions, [POSTGRES_VERSION], `${name} declares the pinned version`);
  }
});

test('semantic search is off in the app of every stage, with the same value everywhere: the model needs about 3 GiB, which the task size of the stages does not give yet', () => {
  for (const name of NAMES) {
    const app = record(name, 'any.example.test').find((c) => c.type === 'sst.aws:Service').args.containers.find((c) => c.name === 'app');
    assert.equal(app.environment.GRIMOIRE_SEMANTIC_SEARCH, 'off', `${name} sets the switch itself, so a new default cannot turn it on`);

test('one VPC for every stage: the stage that owns it is protected and makes it, the others look it up by the owner\'s tags and make no VPC, NAT or address of their own', () => {
  const owners = NAMES.filter((n) => stages[n].vpcFrom === undefined);
  assert.deepEqual(owners, ['staging'], 'exactly one stage owns the VPC');
  assert.equal(stages.dev.vpcFrom, 'staging');
  for (const name of NAMES) {
    const from = stages[name].vpcFrom;
    if (from !== undefined) {
      assert.ok(NAMES.includes(from), `${name} reads the VPC of a stage that exists`);
      assert.equal(stages[from].vpcFrom, undefined, `${from} owns its VPC, it does not read another`);
      assert.equal(stages[from].protect, true, `${from} owns the VPC others live in: nothing may remove it`);
    }
  }
  const made = record('staging', 'grimoire.example.test').filter((c) => /^sst\.aws:Vpc/.test(c.type));
  assert.equal(made.length, 1);
  assert.equal(made[0].type, 'sst.aws:Vpc');
  assert.equal(made[0].name, 'Vpc');
  // The NAT instance only forwards what the VPC's own subnets send: inbound from the VPC's range only (SST's default is the whole internet).
  assert.deepEqual(made[0].args.transform.natSecurityGroup.ingress, [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['10.0.0.0/16'] }]);
  const read = record('dev', 'dev.example.test').filter((c) => /^sst\.aws:Vpc/.test(c.type));
  assert.deepEqual(read, [{ type: 'sst.aws:Vpc.get', name: 'Vpc', args: { id: '<aws.ec2.getVpcOutput({"tags":{"sst:app":"grimoire","sst:stage":"staging"}}).id>' } }]);
});

test('every stage has its own security groups, each with a description and rules that name groups, not address ranges, wherever a group can be named', () => {
  for (const name of NAMES) {
    const calls = record(name, 'any.example.test');
    const one = (type, n) => { const found = calls.filter((c) => c.type === type && c.name === n); assert.equal(found.length, 1, `${name}: one ${n}`); return found[0]; };
    const groups = calls.filter((c) => c.type === 'aws.ec2:SecurityGroup');
    assert.deepEqual(groups.map((g) => g.name).sort(), ['DbSecurityGroup', 'ServiceSecurityGroup']);
    for (const g of groups) {
      assert.ok(g.args.description.length >= 20, `${g.name} says what it is for`);
      assert.equal(g.args.ingress, undefined, `${g.name} has no inline rules: each rule is a resource of its own, so none is lost to the other kind`);
      assert.equal(g.args.egress, undefined);
      assert.equal(g.args.vpcId, '<Vpc.id>');
    }
    const rules = (type) => calls.filter((c) => c.type === type).map((c) => ({ name: c.name, ...c.args }));
    assert.deepEqual(rules('aws.vpc:SecurityGroupIngressRule').map((r) => r.name).sort(), ['DbFromService', 'ServiceFromLoadBalancer']);
    const dbIn = one('aws.vpc:SecurityGroupIngressRule', 'DbFromService').args;
    assert.deepEqual({ ...dbIn, description: undefined }, { securityGroupId: '<DbSecurityGroup.id>', referencedSecurityGroupId: '<ServiceSecurityGroup.id>', ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, description: undefined });
    const lb = one('aws.vpc:SecurityGroupIngressRule', 'ServiceFromLoadBalancer').args;
    assert.equal(lb.securityGroupId, '<ServiceSecurityGroup.id>');
    assert.deepEqual([lb.ipProtocol, lb.fromPort, lb.toPort, lb.cidrIpv4], ['tcp', 8080, 8080, undefined]);
    assert.match(String(lb.referencedSecurityGroupId), /Server\.nodes\.loadBalancer\.securityGroups/);
    // Out of the service: HTTPS to the internet (the identity provider, the file store, the registry), the database by group, and name resolution inside the VPC. Nothing else.
    const out = rules('aws.vpc:SecurityGroupEgressRule').map((r) => [r.name, r.securityGroupId, r.ipProtocol, r.fromPort, r.toPort, r.cidrIpv4 ?? r.referencedSecurityGroupId]);
    assert.deepEqual(out.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      ['ServiceToDatabase', '<ServiceSecurityGroup.id>', 'tcp', 5432, 5432, '<DbSecurityGroup.id>'],
      ['ServiceToDnsTcp', '<ServiceSecurityGroup.id>', 'tcp', 53, 53, '10.0.0.0/16'],
      ['ServiceToDnsUdp', '<ServiceSecurityGroup.id>', 'udp', 53, 53, '10.0.0.0/16'],
      ['ServiceToHttps', '<ServiceSecurityGroup.id>', 'tcp', 443, 443, '0.0.0.0/0'],
    ]);
    const pg = one('sst.aws:Postgres', 'Db');
    assert.deepEqual(pg.args.transform, { instance: { vpcSecurityGroupIds: ['<DbSecurityGroup.id>'] } });
  }
});

test('nothing runs in the VPC\'s default security group, and the owner of the VPC strips it of every rule, after the database and the service have left it', () => {
  const source = readFileSync(path.join(root, 'infra/stage.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /vpc\.securityGroups|defaultSecurityGroup/, 'no component is given the VPC\'s own groups');
  const owner = recordProgram(() => stage(stageConfig('staging'), { domain: 'g.example.test', allowedEmailDomains: ['descope.com'], refusedEmailDomains: [], firstAdminEmails: [] })).calls;
  const stripped = owner.filter((c) => c.type === 'aws.ec2:DefaultSecurityGroup');
  assert.equal(stripped.length, 1);
  assert.deepEqual(stripped[0].args, { vpcId: '<Vpc.id>', ingress: [], egress: [] });
  assert.deepEqual(stripped[0].opts.dependsOn, ['<Db>', '<Server>'], 'it is stripped only once nothing of this stage depends on it');
  assert.equal(record('dev', 'dev.example.test').filter((c) => c.type === 'aws.ec2:DefaultSecurityGroup').length, 0, 'the stage that does not own the VPC does not touch its groups');
});

test('the VPC logs all its traffic: the owner of the VPC makes a flow log to an encrypted log group with a retention, through a role that can write to that group and nothing else', () => {
  const calls = record('staging', 'grimoire.example.test');
  const one = (type) => { const found = calls.filter((c) => c.type === type); assert.equal(found.length, 1, type); return found[0]; };
  const key = one('aws.kms:Key');
  assert.equal(key.args.enableKeyRotation, true);
  assert.match(String(key.args.policy), /aws\.iam\.getPolicyDocumentOutput\(/);
  assert.match(String(key.args.policy), /logs\.\{?[^"]*amazonaws\.com|logs\./, 'CloudWatch Logs may use the key');
  const group = one('aws.cloudwatch:LogGroup');
  assert.equal(group.args.retentionInDays, 365);
  assert.equal(group.args.kmsKeyId, '<VpcFlowLogsKey.arn>');
  const flow = one('aws.ec2:FlowLog');
  assert.deepEqual({ ...flow.args, tags: undefined }, { vpcId: '<Vpc.id>', trafficType: 'ALL', logDestinationType: 'cloud-watch-logs', logDestination: '<VpcFlowLogs.arn>', iamRoleArn: '<VpcFlowLogsRole.arn>', maxAggregationInterval: 60, tags: undefined });
  const role = one('aws.iam:Role');
  assert.match(String(role.args.assumeRolePolicy), /vpc-flow-logs\.amazonaws\.com/);
  assert.match(String(role.args.assumeRolePolicy), /aws:SourceAccount/);
  const policy = one('aws.iam:RolePolicy');
  assert.equal(policy.args.role, '<VpcFlowLogsRole.name>');
  const doc = String(policy.args.policy);
  assert.match(doc, /logs:CreateLogStream/);
  assert.match(doc, /logs:PutLogEvents/);
  assert.doesNotMatch(doc, /"resources":\["\*"\]|logs:\*|iam:/, 'only this log group, only writing');
  const dev = record('dev', 'dev.example.test').map((c) => c.type);
  for (const type of ['aws.ec2:FlowLog', 'aws.kms:Key', 'aws.cloudwatch:LogGroup', 'aws.iam:Role', 'aws.iam:RolePolicy']) assert.ok(!dev.includes(type), `${type} belongs to the stage that owns the VPC`);
});

test('the service runs in the stage\'s own service group, with the subnets and the public address the component chose', () => {
  for (const name of NAMES) {
    const { raw } = recordProgram(() => stage(stageConfig(name), { domain: 'any.example.test', allowedEmailDomains: ['descope.com'], refusedEmailDomains: [], firstAdminEmails: [] }));
    const transform = raw.find((c) => c.type === 'sst.aws:Service').args.transform.service;
    assert.equal(typeof transform, 'function');
    const g = globalThis;
    const saved = g.$output;
    g.$output = (v) => ({ apply: (fn) => fn(v) });
    try {
      const args = { networkConfiguration: { assignPublicIp: true, subnets: ['subnet-a'], securityGroups: ['sg-default'] } };
      transform(args);
      assert.deepEqual(JSON.parse(JSON.stringify(args.networkConfiguration)), { assignPublicIp: true, subnets: ['subnet-a'], securityGroups: ['<ServiceSecurityGroup.id>'] });
    } finally { g.$output = saved; }
  }
});
