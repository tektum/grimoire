// Checks the built client (contracts section 2). Exits 1 with one line per problem.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The ways the app's own code says "descope" without carrying the provider's code: the name of its loader (`loadDescope`), the file names of the two chunks it
 * imports on demand (`descope-sdk-<hash>.js`, `descope-signin-<hash>.js`, written in the entry's preload list), and the label of a session's method
 * (`method: "descope"`, only that exact property). Anything else with the word in a chunk the entry document loads is the provider's code, which belongs on the sign-in page only.
 */
export const OWN_DESCOPE_USES = [/loadDescope/gi, /descope-(?:sdk|signin)-[\w-]+\.js/g, /method:\s*["'`]descope["'`]/g];
/** `text` with the app's own uses of the word taken out. */
export const withoutOwnDescopeUses = (text) => OWN_DESCOPE_USES.reduce((rest, pattern) => rest.replace(pattern, ''), text);

/** Problems of a build in `dist`, as strings; empty when the build is as required. */
export function checkBuild(dist) {
  const problems = [];
  if (!existsSync(path.join(dist, 'config.json'))) problems.push('config.json is missing from the build');
  const read = (file) => readFileSync(path.join(dist, file), 'utf8');
  if (!existsSync(path.join(dist, 'login.html'))) problems.push('login.html is missing from the build (the sign-in screen is its own document)');
  const html = existsSync(path.join(dist, 'index.html')) ? read('index.html') : null;
  if (html === null) return [...problems, 'index.html is missing from the build'];
  const assets = existsSync(path.join(dist, 'assets')) ? readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')) : [];
  const text = (file) => read(path.join('assets', file));

  // Chunks the entry document loads at start: its scripts and what they import statically, transitively.
  const loaded = new Set();
  const visit = (file) => {
    if (loaded.has(file) || !assets.includes(file)) return;
    loaded.add(file);
    for (const m of text(file).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(m[1]);
  };
  for (const m of html.matchAll(/(?:src|href)="(?:\.\/)?assets\/([^"]+\.js)"/g)) visit(m[1]);
  for (const file of loaded)
    for (const word of ['descope', 'fingerprint', 'fpnpmcdn'])
      if ((word === 'descope' ? withoutOwnDescopeUses(text(file)) : text(file)).toLowerCase().includes(word))
        problems.push(`assets/${file}, loaded by index.html, contains "${word}" (the sign-in libraries load on the sign-in page only)`);

  for (const file of assets)
    if (text(file).includes('grimoire-design-sample')) problems.push(`assets/${file} contains the marker grimoire-design-sample (the design sample page is not in a production build)`);
  for (const file of assets)
    if (text(file).includes('grimoire-dev-signin')) problems.push(`assets/${file} contains the marker grimoire-dev-signin (the development sign-in is not in a production build)`);

  for (const [name, source] of [['index.html', html], ...assets.map((f) => [`assets/${f}`, text(f)])])
    if (/(?:["'`(=]|url\()\/assets\//.test(source)) problems.push(`${name} has an absolute /assets/ path (every asset path must be relative)`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'));
  const problems = checkBuild(dist);
  for (const p of problems) process.stderr.write(`check-build: ${p}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write('check-build: ok\n');
}
