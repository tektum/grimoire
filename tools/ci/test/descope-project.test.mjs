import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectConfig, readFlows } from '../../../infra/descope/config.ts';
import { buildStyles, contrastOn, contrastRatio, mix, parseTokens, readTokens } from '../../../infra/descope/theme.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const tokens = readTokens(root);

test('the styles of a project are the web client\'s design tokens: accent, paper, ink, fonts and radius, light and dark', () => {
  const { styles } = buildStyles(tokens);
  assert.equal(styles.light.globals.colors.primary.main, tokens.light['--accent']);
  assert.equal(styles.dark.globals.colors.primary.main, tokens.dark['--accent']);
  assert.equal(styles.light.globals.colors.surface.main, tokens.light['--paper']);
  assert.equal(styles.dark.globals.colors.surface.main, tokens.dark['--paper']);
  assert.equal(styles.light.globals.colors.surface.contrast, tokens.light['--ink']);
  assert.notEqual(tokens.light['--accent'], tokens.dark['--accent']);
  assert.deepEqual(styles.light.globals.fonts.font1.family.slice(0, 2), ['ui-serif', 'Georgia']);
  assert.equal(styles.light.globals.fonts.font2.family[0], 'system-ui');
  assert.deepEqual(styles.light.globals.radius, { sm: tokens.light['--radius-1'], md: tokens.light['--radius-2'] });
});

test('a change to the accent in tokens.css changes the styles: they are made from the file, not copied from it', () => {
  const css = read('apps/web/src/ui/tokens.css').replaceAll('#0b5cad', '#aa0000');
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

test('the development project is made and named by code, for local runs', () => {
  const c = projectConfig('descope-dev', { tokens });
  assert.equal(c.name, 'Grimoire development');
  assert.equal(c.appUrl, 'http://127.0.0.1:4173');
  assert.deepEqual(c.approvedDomains, ['127.0.0.1', 'localhost']);
  assert.equal(c.environment, undefined);
});

test('the staging project takes its address from the domain it is given, and refuses anything that is not a host name', () => {
  const c = projectConfig('staging', { stagingDomain: 'grimoire.descope.io', tokens });
  assert.equal(c.name, 'Grimoire staging');
  assert.equal(c.appUrl, 'https://grimoire.descope.io');
  assert.deepEqual(c.approvedDomains, ['grimoire.descope.io']);
  for (const bad of [undefined, '', 'localhost', 'https://grimoire.descope.io', 'grimoire.descope.io:8443', 'a b.test', 'grimoire.descope.io/x']) {
    assert.throws(() => projectConfig('staging', { stagingDomain: bad, tokens }), /STAGING_DOMAIN/, String(bad));
  }
});

test('sign-in is a one-time code by email and nothing else: every other method is off, and the flow says the same', () => {
  const c = projectConfig('descope-dev', { tokens });
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
  const { session } = projectConfig('descope-dev', { tokens });
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
  assert.doesNotMatch(read('infra/descope-dev.ts') + source, /P3MKkY4NTeugh4LndRLzgCZJtoPS|import:/);
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
  assert.equal(JSON.parse(projectConfig('descope-dev', { flows: {} }).styles).componentsVersion, undefined);
});
