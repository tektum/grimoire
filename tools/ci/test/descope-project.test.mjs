import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectConfig, readFlows } from '../../../infra/descope/config.ts';
import { stageConfig } from '../../../infra/stages.ts';
import { buildStyles, contrastOn, contrastRatio, mix, parseTokens, readTokens } from '../../../infra/descope/theme.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const tokens = readTokens(root);
const dev = stageConfig('dev');
const staging = stageConfig('staging');
const DEV_HOST = 'dev.grimoire.descope.io';

test('the styles of a project are the web client\'s design tokens: accent, paper, ink, fonts and radius, light and dark', () => {
  const { styles } = buildStyles(tokens);
  assert.equal(styles.light.globals.colors.primary.main, tokens.light['--accent']);
  assert.equal(styles.dark.globals.colors.primary.main, tokens.dark['--accent']);
  assert.equal(styles.light.globals.colors.surface.main, tokens.light['--paper-raised']); // the card of the flow is the raised surface of the application's own cards
  assert.equal(styles.dark.globals.colors.surface.main, tokens.dark['--paper-raised']);
  assert.equal(styles.light.globals.colors.surface.contrast, tokens.light['--ink']);
  assert.notEqual(tokens.light['--accent'], tokens.dark['--accent']);
  assert.equal(styles.light.globals.fonts.font1.family[0], 'Inter'); // every component is in the interface font unless told otherwise, as the application's controls are
  assert.deepEqual(styles.light.globals.fonts.font2.family.slice(0, 2), ['Literata', 'Literata fallback']);
  assert.deepEqual(styles.light.globals.radius, { sm: tokens.light['--radius-1'], md: tokens.light['--radius-2'] });
  // The light and dark blocks are the themes, not the overrides for increased contrast or forced colours that also select :root.
  for (const mode of ['light', 'dark']) for (const name of ['--paper', '--ink-2', '--hairline']) assert.match(tokens[mode][name], /^#[0-9a-f]{6}$/i, `${mode} ${name}`);
});

test('a change to the accent in tokens.css changes the styles: they are made from the file, not copied from it', () => {
  const css = read('apps/web/src/ui/tokens.css').replaceAll('#2b4c9b', '#aa0000');
  assert.equal(buildStyles(parseTokens(css)).styles.light.globals.colors.primary.main, '#aa0000');
});

test('the shades are derived from the accent, and the contrast colour is the one that reads', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(contrastOn('#ffffff'), '#000000');
  assert.equal(contrastOn('#0b5cad'), '#ffffff');
  assert.equal(contrastOn('#7db4f0'), '#000000');
  const primary = buildStyles(tokens).styles.light.globals.colors.primary;
  assert.deepEqual(Object.keys(primary), ['main', 'dark', 'light', 'highlight', 'contrast']);
  assert.throws(() => mix('blue', '#fff', 0.5), /#rrggbb/);
});

test('the text colour on every palette reaches the WCAG minimum of 4.5 to 1, in both modes (the crossover is a luminance of about 0.179, not 0.4)', () => {
  const { styles } = buildStyles(tokens);
  for (const mode of ['light', 'dark']) {
    for (const [name, palette] of Object.entries(styles[mode].globals.colors)) {
      assert.ok(contrastRatio(palette.main, palette.contrast) >= 4.5, `${mode} ${name}: ${palette.contrast} on ${palette.main}`);
    }
  }
  assert.equal(contrastOn('#a39d8f'), '#000000'); // the dark-mode muted colour: black reads at about 7.8 to 1, white at 2.7 to 1
  assert.equal(contrastOn('#767676'), '#000000'); // a mid grey just above the crossover (luminance 0.181) takes black
  assert.equal(contrastOn('#757575'), '#ffffff'); // and just below it (0.178) white
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 1e-9);
});

test('every flow file of the folder is a flow of the project, and an empty folder or a file that is not JSON stops the run', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'grimoire-flows-'));
  try {
    mkdirSync(join(dir, 'infra/descope/flows'), { recursive: true });
    assert.throws(() => readFlows(dir), /has no flow/);
    cpSync(`${root}infra/descope/flows/sign-up-or-in.json`, join(dir, 'infra/descope/flows/sign-up-or-in.json'));
    cpSync(`${root}infra/descope/flows/sign-up-or-in.json`, join(dir, 'infra/descope/flows/step-up.json'));
    writeFileSync(join(dir, 'infra/descope/flows/README.md'), 'not a flow');
    assert.deepEqual(Object.keys(readFlows(dir)), ['sign-up-or-in', 'step-up']);
    writeFileSync(join(dir, 'infra/descope/flows/broken.json'), '{ not json');
    assert.throws(() => readFlows(dir), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the development project is made and named by code, signs in at the address of its stage and, for local runs, at the loopback names', () => {
  const c = projectConfig(dev, { domain: DEV_HOST, tokens });
  assert.equal(c.name, 'Grimoire dev stage');
  // The company already has a project named "Grimoire development" (the one of the stage this replaces) and Descope refuses a second of the same name: the first deploy of dev stopped there.
  assert.notEqual(c.name, 'Grimoire development');
  assert.equal(c.appUrl, `https://${DEV_HOST}`);
  assert.deepEqual(c.approvedDomains, [DEV_HOST, '127.0.0.1', 'localhost']);
  assert.equal(c.environment, undefined);
});

test('the staging project takes its address from the domain it is given, and refuses anything that is not a host name', () => {
  const c = projectConfig(staging, { domain: 'grimoire.descope.io', tokens });
  assert.equal(c.name, 'Grimoire staging');
  assert.equal(c.appUrl, 'https://grimoire.descope.io');
  assert.deepEqual(c.approvedDomains, ['grimoire.descope.io']);
  for (const bad of [undefined, '', 'localhost', 'https://grimoire.descope.io', 'grimoire.descope.io:8443', 'a b.test', 'grimoire.descope.io/x']) {
    assert.throws(() => projectConfig(staging, { domain: bad, tokens }), /GRIMOIRE_DOMAIN/, String(bad));
  }
});

test('sign-in is a one-time code by email and nothing else: every other method is off, and the flow says the same', () => {
  const c = projectConfig(dev, { domain: DEV_HOST, tokens });
  assert.deepEqual([...c.disabledMethods].sort(), ['embeddedlink', 'enchantedlink', 'magiclink', 'oauth', 'passkey', 'password', 'totp']);
  const flow = JSON.parse(c.flows['sign-up-or-in']);
  const text = JSON.stringify(flow.contents);
  assert.ok(text.includes('sign-up-or-in-otp-email') && text.includes('verify-code-otp-email'));
  for (const method of ['otp-sms', 'password', 'magiclink', 'magic-link', 'enchanted', 'oauth', 'social', 'webauthn', 'passkey', 'totp']) assert.ok(!text.includes(method), `the flow uses ${method}`);
  assert.ok(flow.contents.tasks[flow.contents.startTask] !== undefined || flow.contents.tasks.start !== undefined);
  assert.ok(flow.metadata.name && flow.screens.length >= 1);
});

test('the flows are the files of infra/descope/flows, read as JSON, one per flow id', () => {
  assert.deepEqual(Object.keys(readFlows(root)), ['sign-up-or-in']);
  assert.deepEqual(JSON.parse(readFlows(root)['sign-up-or-in']), JSON.parse(read('infra/descope/flows/sign-up-or-in.json')));
});

test('the session tokens are shorter than the server accepts (a day by default), and the refresh token rotates', () => {
  const { session } = projectConfig(dev, { domain: DEV_HOST, tokens });
  assert.equal(session.sessionTokenExpiration, '10 minutes');
  assert.equal(session.refreshTokenRotation, true);
  const minutes = Number(/^(\d+) minutes$/.exec(session.sessionTokenExpiration)?.[1]);
  assert.ok(minutes * 60 <= 86400);
});

test('no Descope role, permission or tenant is created: the product authorizes with its own database', () => {
  const source = read('infra/descope/project.ts');
  for (const kind of ['descope.Role', 'descope.Permission', 'descope.AppRole', 'descope.Tenant', 'descope.ManagementKey', 'descope.Descoper']) assert.ok(!source.includes(kind), kind);
});

test('the project is protected from deletion and nothing adopts the hand-made project', () => {
  const source = read('infra/descope/project.ts');
  assert.match(source, /deletionProtection: true/);
  assert.doesNotMatch(read('infra/stage.ts') + source, /P3MKkY4NTeugh4LndRLzgCZJtoPS|import:/);
});

test('every resource of the project takes its project id from the project, never a literal', () => {
  const source = read('infra/descope/project.ts');
  const resources = [...source.matchAll(/new descope\.(\w+)\(/g)].map((m) => m[1]);
  assert.ok(resources.length >= 12, resources.join());
  assert.equal([...source.matchAll(/projectId,/g)].length >= resources.length - 1, true);
  assert.doesNotMatch(source, /projectId: ['"]/);
});

test('the styles name no components version: Descope refuses a version that is not the project\'s own, and that version moves with its releases', () => {
  const data = buildStyles(tokens);
  assert.deepEqual(Object.keys(data).sort(), ['references', 'styles']);
  assert.equal(JSON.parse(projectConfig(dev, { domain: DEV_HOST, flows: {} }).styles).componentsVersion, undefined);
});

// The sign-in flow makes or joins the tenant of the email domain (docs/tenancy.md), and the user token carries the tenant and the profile. Both were run on a throwaway project.
const flow = JSON.parse(read('infra/descope/flows/sign-up-or-in.json'));
const tasks = flow.contents.tasks;
const next = (id, interaction) => tasks[id].next.rules.find((r) => r.interactionId === interaction)?.taskId;

test('after the one-time code the flow ends for a person who has a tenant, joins the tenant of the email domain, and makes it only when there is none', () => {
  const verify = Object.entries(tasks).find(([, t]) => t.action === 'verify-code-otp-email')?.[0];
  assert.ok(verify);
  const check = next(verify, 'success');
  assert.equal(tasks[check].type, 'condition');
  const [has] = tasks[check].conditions;
  assert.deepEqual(has.atomicConditions, [{ operator: 'greater-than', predicate: { type: 'inline', value: 0 }, target: { type: 'context', value: 'user.tenantCount' } }]);
  assert.equal(tasks[next(check, has.interactionId)].action, 'logged-in', 'a person with a tenant is done');
  const join = next(check, 'ELSE');
  assert.equal(tasks[join].action, 'update-user-tenant-email-domain');
  assert.equal(tasks[next(join, 'success')].action, 'logged-in');
  const create = next(join, 'ActionErrorUpdateUserTenantByEmailDomainNoTenant');
  assert.equal(tasks[create].action, 'createTenant');
  assert.equal(tasks[next(create, 'success')].action, 'logged-in');
  // A tenant made in the meantime is joined, not made twice, and the retry has a way out: it is a second join whose "no tenant" answer is not routed back (a tenant that exists
  // under the domain's name but does not list the domain would otherwise send the person round the two steps for ever).
  const again = next(create, 'TenantExists');
  assert.notEqual(again, join);
  assert.equal(tasks[again].action, 'update-user-tenant-email-domain');
  assert.equal(next(again, 'success') !== undefined && tasks[next(again, 'success')].action, 'logged-in');
  assert.equal(next(again, 'ActionErrorUpdateUserTenantByEmailDomainNoTenant'), undefined);
});

test('the tenant is named after the email domain, lists that domain for self-provisioning, and is the person\'s current tenant', () => {
  const create = Object.values(tasks).find((t) => t.action === 'createTenant');
  assert.deepEqual(create.arguments, {
    dynamicName: { type: 'inline', value: '{{user.emailDomain}}' },
    dynamicSelfProvision: { type: 'inline', value: '{{user.emailDomain}}' },
    setAsSelectedTenant: { type: 'inline', value: true },
  });
});

test('every task of the flow is reachable from its start, and every step it names exists', () => {
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const rule of tasks[id].next?.rules ?? []) {
      assert.ok(tasks[rule.taskId], `task ${id} names a missing task ${rule.taskId}`);
      walk(rule.taskId);
    }
  };
  walk(flow.contents.startTask === 'start' ? tasks.start.next.rules[0].taskId : flow.contents.startTask);
  assert.deepEqual([...seen].sort(), Object.keys(tasks).filter((k) => k !== 'start').sort());
});

test('the user token carries the profile under the names the server reads, and the tenant is made the current one by the template', () => {
  const { userToken } = projectConfig(staging, { domain: 'app.example.test', flows: {} });
  assert.equal(userToken.name, 'grimoire-user');
  assert.deepEqual(Object.keys(userToken.claims).sort(), ['email', 'emailVerified', 'name']);
  assert.deepEqual(userToken.claims, { email: '{{user.email}}', name: '{{user.name}}', emailVerified: '{{user.verifiedEmail}}' });
  const project = read('infra/descope/project.ts');
  assert.match(project, /autoTenantClaim: true/);
  assert.match(project, /userJwtTemplate: userToken\.id/);
});

test('the secondary text and the borders of the controls can be read on the card, in both modes: 4.5 to 1 for text, 3 to 1 for borders', () => {
  const { styles } = buildStyles(tokens);
  for (const mode of ['light', 'dark']) {
    const { surface } = styles[mode].globals.colors;
    assert.ok(contrastRatio(surface.dark, surface.main) >= 4.5, `${mode}: labels and hints (${surface.dark}) on the card (${surface.main})`);
    assert.ok(contrastRatio(surface.light, surface.main) >= 3, `${mode}: the border of a control (${surface.light}) on the card (${surface.main})`);
    assert.ok(contrastRatio(surface.contrast, surface.main) >= 4.5, `${mode}: the main text on the card`);
  }
});

test('the first screen of the flow says in one line what it is for (the page above the card already carries the title), asks for the address as a required field with its own messages, and has one full-width button', () => {
  const login = JSON.parse(read('infra/descope/flows/sign-up-or-in.json')).screens.find((screen) => screen.screenId === 'new-1');
  const components = Object.values(login.contents);
  const texts = components.filter((c) => c.displayName === 'Text' || c.displayName === 'Subtitle').map((c) => c.props.children.trim());
  assert.deepEqual(texts, ['Sign in or create an account with your email'], 'the title is said once, by the page above the card');
  const email = components.find((c) => c.displayName === 'Email Input').props;
  assert.equal(email.required, true, 'an empty address is stopped by the field, not sent to the provider (which answers "Failed to sign up or in")');
  assert.equal(email['data-errormessage-value-missing'], 'Enter your email address');
  assert.equal(email['data-errormessage-pattern-mismatch'], 'Enter a valid email address, like name@company.com');
  const buttons = components.filter((c) => c.displayName === 'Button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props['full-width'], true);
  assert.equal(buttons[0].props.children, 'Continue');
  assert.equal(login.interactions[0].label, 'Continue');
});

test('a public mail provider is stopped before the provider signs anyone up: the check comes right after the address, a free address reaches a screen with one way back, and nothing else is changed', () => {
  const flow = JSON.parse(read('infra/descope/flows/sign-up-or-in.json'));
  const tasks = flow.contents.tasks;
  const byAction = (action) => Object.values(tasks).find((task) => task.action === action);
  const check = byAction('check-if-free-email');
  assert.equal(tasks['1'].next.rules[0].taskId, check.id, 'the address goes to the check first');
  const split = tasks[check.next.rules[0].taskId];
  assert.equal(split.type, 'condition');
  const free = split.conditions.find((c) => c.interactionId !== 'ELSE');
  assert.deepEqual(free.atomicConditions, [{ operator: 'is-true', target: { type: 'context', value: 'isFreeEmailProvider' } }]);
  const toFree = split.next.rules.find((r) => r.interactionId === free.interactionId).taskId;
  const toElse = split.next.rules.find((r) => r.interactionId === 'ELSE').taskId;
  assert.equal(tasks[toElse].action, 'load-mail-provider-host', 'a work address goes on to the code, as before');
  const stop = tasks[toFree];
  assert.equal(stop.type, 'screen');
  assert.equal(stop.screenId, `new-${stop.id}`, 'a screen is named after its task: the provider only serves a screen it has renamed that way (found by running it)');
  assert.deepEqual(stop.next.rules.map((r) => r.taskId), ['1'], 'the only way out is back to the address');
  const screen = flow.screens.find((s) => s.screenId === stop.screenId);
  assert.equal(Object.values(screen.contents).filter((c) => c.displayName === 'Email Input').length, 0, 'it asks for nothing');
  assert.match(Object.values(screen.contents).map((c) => c.props.children ?? '').join(' '), /work email address/);
  // nothing reaches the tenant steps without the check: every path from the address to the code goes through it
  const reach = (from, avoid, seen = new Set()) => { if (from === avoid || seen.has(from)) return seen; seen.add(from); for (const r of tasks[from]?.next?.rules ?? []) reach(r.taskId, avoid, seen); return seen; };
  assert.equal(reach('1', check.id).has('2'), false, 'the mail host and the code are only reached through the check');
});
