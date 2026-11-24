import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCredentialedUrls } from '../check-test-db-urls.mjs';

const lines = (source) => findCredentialedUrls(source, 'a.test.ts');
// The sources under test are assembled here: this file is itself a test file, and holds no URL literal.
const url = (userInfo, rest = 'h/db', scheme = 'postgresql') => `${scheme}://${userInfo}@${rest}`;
const q = (value) => `'${value}'`;

test('a credentialed Postgres URL written out is found, in a string or in a template, with either scheme', () => {
  assert.deepEqual(lines(`const a = ${q(url('u:pw'))};\nconst b = "${url('u:pw', 'h/db', 'postgres')}";\nconst c = \`${url('u:pw', '${host}/db')}\`;`), [1, 2, 3]);
  assert.deepEqual(lines(`const t = \`${url("u:${'x'}literal")}\`;`), [1], 'a password that is partly literal counts');
});

test('a password that is only interpolated, a URL without a password and a URL that is not Postgres pass', () => {
  assert.deepEqual(lines(`const a = \`${url('u:${password}')}\`;`), []);
  assert.deepEqual(lines(`const b = ${q(url('u'))}; const c = ${q(url('u', 'h/db').replace('u@', ''))}; const d = ${q(url('bob:s3cret', 'h/p', 'https'))};`), []);
  assert.deepEqual(lines("const e = adminUrl('postgres'); const f = placeholderDatabaseUrl('h');"), []);
});

test('a comment is not a literal, and the line of a literal inside a longer expression is reported', () => {
  assert.deepEqual(lines(`// ${url('u:pw')}\nconst x = {\n  url: ${q(url('u:pw'))},\n};`), [3]);
});

test('an interpolated user name does not hide a literal password', () => {
  assert.deepEqual(lines(`const a = \`${url('${user}:pw')}\`;`), [1]);
  assert.deepEqual(lines(`const b = \`${url('${user}:${password}')}\`;`), [], 'a wholly interpolated password still passes');
});

test('a URL split over concatenated literals is one literal, however it is split or wrapped', () => {
  const head = `${'postgresql'}://u:`;
  assert.deepEqual(lines(`const a = ${q(head)} + ${q('pw@h/db')};`), [1]);
  assert.deepEqual(lines(`const b = (${q(head)} + ${q('p')}) + ${q('w@h/db')};`), [1]);
  assert.deepEqual(lines(`const c = ${q(head)} + password + ${q('@h/db')};`), [], 'a password that is a variable is not a literal');
  assert.deepEqual(lines(`const d = ${q(head)} + ${q('pw')} + host;`), [], 'no @: not yet a credential');
});
