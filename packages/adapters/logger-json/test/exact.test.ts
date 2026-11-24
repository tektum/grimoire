import { describe, expect, it } from 'vitest';
import { MAX_STRING_CHARS, REDACTED, redactString } from '../src/scrub.js';
import { dsn } from './dsn.js';

const R = REDACTED;

// Exact outputs: a secret is replaced and every byte around it is kept. A test that only looked for the secret's absence
// would also pass for a scrubber that deleted the whole line.
describe('bearer and basic credentials', () => {
  it.each([
    ['bearer ends at a space', 'got Bearer abc.def-ghi now', `got Bearer ${R} now`],
    ['bearer ends at a semicolon', 'got Bearer abc; next', `got Bearer ${R}; next`],
    ['bearer ends at a comma', 'got Bearer abc, next', `got Bearer ${R}, next`],
    ['bearer ends at a tab', 'got Bearer abc\tnext', `got Bearer ${R}\tnext`],
    ['bearer ends at a newline', 'got Bearer abc\nnext', `got Bearer ${R}\nnext`],
    ['bearer to the end of the text', 'got Bearer abc', `got Bearer ${R}`],
    ['the scheme word is kept in its own case', 'a BEARER   tok more', `a BEARER ${R} more`],
    ['basic ends at a semicolon', 'sent basic dXNlcjpwdw==;x', `sent basic ${R};x`],
    ['basic with credentials containing = and /', 'sent Basic dXNlcjpwdw+/== end', `sent Basic ${R} end`],
    ['two credentials in one text', 'Bearer a1 and Basic b2.', `Bearer ${R} and Basic ${R}`],
    ['a word that merely contains bearer is not a scheme', 'unbearer abc and bearers abc', 'unbearer abc and bearers abc'],
    ['a word that merely starts with basic is not a scheme', 'basically fine', 'basically fine'],
    ['a scheme word without a value is left alone', 'Bearer', 'Bearer'],
    ['a double quote does not end a bearer value (only whitespace, ; and , do)', 'got Bearer abc"def"ghi now', `got Bearer ${R} now`],
    ['a single quote does not end a bearer value either', "got Bearer abc'def now", `got Bearer ${R} now`],
  ])('%s', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it('an authorization header is redacted whatever the scheme, together with the rest of its line', () => {
    expect(redactString('Authorization: Bearer abc now')).toBe(`Authorization=${R}`);
    expect(redactString('Authorization: Basic dXNlcjpwdw==;x')).toBe(`Authorization=${R};x`);
    expect(redactString('Authorization: Basic dXNlcjpwdw==\nnext')).toBe(`Authorization=${R}\nnext`);
  });
});

describe('credentials inside URLs', () => {
  it.each([
    ['user and password', 'see https://bob:s3cret@db.example.com:5432/app ok', `see https://${R}@db.example.com:5432/app ok`],
    ['user only', 'see https://bob@db.example.com/app ok', `see https://${R}@db.example.com/app ok`],
    ['password only', 'see https://:s3cret@db.example.com/app ok', `see https://${R}@db.example.com/app ok`],
    ['a password containing @', `x ${dsn('u:p@ss', 'h/db')} y`, `x postgres://${R}@h/db y`],
    ['a password containing spaces', 'x postgres://u:a b c@h/db y', `x postgres://${R}@h/db y`],
    ['text before the scheme is kept', `conn=${dsn('u:pw', 'h/db')}`, `conn=postgres://${R}@h/db`],
    ['a scheme at the very start of the text', '://u:pw@h/x', `://${R}@h/x`],
    ['an @ before the scheme is not userinfo', 'mail a@b.c then https://h/p', 'mail a@b.c then https://h/p'],
    ['a URL without credentials is untouched', 'GET https://example.com/a/b ok', 'GET https://example.com/a/b ok'],
  ])('%s', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
});

describe('JWT-shaped tokens', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl';
  it.each([
    ['inside a sentence', `the token ${jwt} was refused`, `the token ${R} was refused`],
    ['followed by a comma', `token ${jwt}, trailing`, `token ${R}, trailing`],
    ['in parentheses', `(${jwt}) trailing`, `(${R}) trailing`],
    ['in quotes', `said "${jwt}" twice`, `said "${R}" twice`],
    ['after a slash', `GET /x/${jwt}`, `GET /x/${R}`],
    ['two of them', `${jwt} ${jwt}`, `${R} ${R}`],
    ['with a prefix glued on', `x-${jwt}`, R],
    ['a run with eyJ and ONE dot is redacted (an unsigned or truncated token)', 'a eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0 b', `a ${R} b`],
    ['a run with eyJ but no dot is not a JWT', 'a eyJabc no dot b', 'a eyJabc no dot b'],
    ['a dotted run without eyJ is not a JWT', 'file a.b.c here', 'file a.b.c here'],
  ])('%s', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
});

describe('where a key=value secret ends', () => {
  it.each([
    ['at a semicolon', 'password=abc;next=1', `password=${R};next=1`],
    ['at a newline', 'password=abc\nnext=1', `password=${R}\nnext=1`],
    ['at the first of a semicolon and a newline', 'password=abc\nx=1;y=2', `password=${R}\nx=1;y=2`],
    ['only at the end of the text when nothing else ends it', 'password=abc next, more', `password=${R}`],
    ['after spaces following the separator', 'password=   abc;n', `password=${R};n`],
    ['a colon separator is rewritten to =', 'password: abc;n', `password=${R};n`],
    ['spaces between the separator and an opening quote are skipped', 'password=  "a b" next', `password=${R} next`],
    ['a double-quoted value ends at its closing quote', 'password="a b;c" next', `password=${R} next`],
    ['a single-quoted value ends at its closing quote', "token='a b' next", `token=${R} next`],
    ['an escaped quote does not end the value', 'password="a\\"b" next', `password=${R} next`],
    ['an escaped backslash before the quote does end the value', 'password="a\\\\" next', `password=${R} next`],
    ['the other quote character does not end the value', 'password="a\'b" next', `password=${R} next`],
    ['an unclosed quote runs to the end', 'password="a b c', `password=${R}`],
    ['a quoted key keeps its quotes', '{"password":"hunter2","user":"ann"}', `{"password"=${R},"user":"ann"}`],
    ['a key that is not secret is left alone', 'user=ann;count=5', 'user=ann;count=5'],
    ['text before the key is kept', 'login failed (host=h;password=abc;db=x)', `login failed (host=h;password=${R};db=x)`],
    ['two secrets in one text', 'password=a;token=b;ok=1', `password=${R};token=${R};ok=1`],
  ])('%s', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
});

describe('query strings and fragments', () => {
  it.each([
    ['a path query ends at whitespace', 'GET /p?a=b more words', `GET /p?${R} more words`],
    ['a URL query runs to the end of the text, spaces included', 'GET https://h/p?a=b more words', `GET https://h/p?${R}`],
    ['a fragment ends at whitespace', 'see /p#frag more', `see /p#${R} more`],
    ['a fragment before a query wins', 'see /p#f?x=1 more', `see /p#${R} more`],
    ['a query before a fragment is cut at the query', 'see /p?x=1#f more', `see /p?${R} more`],
    ['a hash after a leading hash is a fragment', '#a#secret more', `#a#${R} more`],
    ['a token that starts with ? is a query', '?secret more', `?${R} more`],
    ['a token that starts with ? and holds a hash is still a query', '?secret#f more', `?${R} more`],
    ['a scheme right at the start of a token with a query drops the rest', '://h/p?a=1 rest and more', `://h/p?${R}`],
    ['a scheme after the ? does not drop the rest', '/p?u=http://x more words', `/p?${R} more words`],
    ['a lone hash at the start is not a fragment', '#lead word', '#lead word'],
    ['text without ? or # is untouched', 'plain words, 1:2 and a/b', 'plain words, 1:2 and a/b'],
  ])('%s', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
});

describe('adversarial text keeps the work bounded', () => {
  const n = 1_000_000;
  const shapes: Array<[string, string]> = [
    ['spaces then colons', `${' '.repeat(n / 2)}${':'.repeat(n / 2)}`],
    ['key characters then equals signs', `${'a'.repeat(n / 2)}${'='.repeat(n / 2)}`],
    ['equals signs separated by spaces', ' ='.repeat(n / 2)],
    ['unclosed quoted secrets', 'password="'.repeat(n / 10)],
    ['backslashes in a quoted secret', `password="${'\\'.repeat(n)}`],
    ['userinfo markers', `://${'@'.repeat(n)}`],
    ['bearer followed by a very long run', `bearer ${'a'.repeat(n)}`],
    ['bearer followed by spaces only', `bearer${' '.repeat(n)}`],
    ['dots and eyJ', 'eyJ.'.repeat(n / 4)],
    ['question marks inside one token', '?'.repeat(n)],
  ];
  it.each(shapes)('%s: the output is cut at the cap, with the cut length reported', (_n, input) => {
    const out = redactString(input);
    expect(out.length).toBeLessThanOrEqual(MAX_STRING_CHARS + 40);
    // Either the cut is reported with its count, or the whole text was dropped or redacted to something short: a silent cut at the cap would be as long as the cap.
    if (!/…\[truncated \d+ chars\]$/.test(out)) expect(out.length).toBeLessThan(MAX_STRING_CHARS);
  });
  it('a long text without any whitespace is dropped whole, leaving only the count', () => {
    expect(redactString('y'.repeat(MAX_STRING_CHARS + 952))).toBe('…[truncated 952 chars]');
  });
  it('a secret that straddles the cap is dropped with its partial token; the count reports the characters beyond the cap', () => {
    const out = redactString(`${'x'.repeat(MAX_STRING_CHARS - 3)} pw=a${'b'.repeat(10)}`);
    expect(out).toBe(`${'x'.repeat(MAX_STRING_CHARS - 3)} …[truncated 12 chars]`);
  });
  it('text of exactly the cap is not truncated, one character over is', () => {
    const atCap = 'y '.repeat(MAX_STRING_CHARS / 2);
    expect(redactString(atCap)).toBe(atCap);
    const endsInToken = `${'y '.repeat(MAX_STRING_CHARS / 2 - 1)}yy`; // the last token ends exactly at the cap
    expect(redactString(endsInToken)).toBe(endsInToken);
    expect(redactString(`${atCap}z`)).toBe(`${atCap}…[truncated 1 chars]`);
  });
});
