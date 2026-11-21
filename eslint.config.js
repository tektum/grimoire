import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Provider modules the core must never import (R2.19, R12.34).
const forbiddenModules = [
  "@aws-sdk",
  "@descope",
  "@hocuspocus",
  "@hono",
  "pg",
  "kysely",
  "pg-boss",
  "hono",
  "ws",
  "crossws",
  "pino",
  "rate-limiter-flexible",
  "yjs",
  "y-protocols",
];
const forbiddenImportPatterns = forbiddenModules.flatMap((m) => [m, `${m}/*`]);
const forbiddenSourceRegex = `^(?:${forbiddenModules.map((m) => m.replace(/[-/]/g, "\\$&")).join("|")})(?:$|[^\\w-])`;
const importMessage =
  "packages/core must not import provider SDKs or runtime libraries; use a port interface (R2.19).";
const envMessage =
  "packages/core must not read process.env in packages/core; only the config adapter reads the environment (R2.19).";

const envRules = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: envMessage,
  },
  {
    selector: "MemberExpression[object.name='process'][property.value='env']",
    message: envMessage,
  },
  {
    selector: "MemberExpression[object.property.name='process'][property.name='env']",
    message: envMessage,
  },
  {
    selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
    message: envMessage,
  },
];

// Server-only libraries: never in the browser client or the shared libraries (R11.1).
const serverOnlyModules = ["hono", "@hono", "@hocuspocus/server", "kysely", "pg", "pino", "pg-boss", "crossws", "rate-limiter-flexible"];
const serverOnlyPatterns = serverOnlyModules.flatMap((m) => [m, `${m}/*`]);
const serverOnlyMessage = "Server-only library: not allowed here; the browser client and shared libraries stay provider-free (R11.1).";
const adapterPackage = (name) => `@tektum/grimoire-adapter-${name}`;
const adaptersExcept = (name) => ["@tektum/grimoire-adapter-*", `!${adapterPackage(name)}`];
const adapterLayerMessage =
  "An adapter may import only @tektum/grimoire-core and its own library: never another adapter or anything under apps/ (R2.18).";
const escapeRegex = (s) => s.replace(/[-/]/g, "\\$&");
const dynamicRulesFor = (sourceRegex, message) => [
  { selector: `ImportExpression[source.value=/${sourceRegex}/]`, message },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${sourceRegex}/]`, message },
  // A template literal without expressions is a plain string: refuse it by module name too.
  { selector: `ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=/${sourceRegex}/]`, message },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=/${sourceRegex}/]`,
    message,
  },
];
const dynamicImportRules = dynamicRulesFor(forbiddenSourceRegex, importMessage);
const serverOnlyRegex = `^(?:${serverOnlyModules.map(escapeRegex).join("|")})(?:$|[^\\w-])`;
const appsRegex = "^@tektum\\/grimoire-(?:server|web)(?:$|\\/)";
const allAdaptersRegex = "^@tektum\\/grimoire-adapter-";
const adapterNames = ["auth-descope", "auth-dev", "auth-fake", "collab-hocuspocus", "config-env", "db-kysely", "logger-json", "markdown-milkdown"];

// Packages whose imports are restricted the same way: no adapters, no apps, no server-only libraries.
const noAdaptersNoServerOnly = (message) => ({
  patterns: [
    { group: serverOnlyPatterns, message: serverOnlyMessage },
    { group: ["@tektum/grimoire-adapter-*", "@tektum/grimoire-server", "@tektum/grimoire-server/*", "@tektum/grimoire-web", "@tektum/grimoire-web/*"], message },
  ],
});
const noAdaptersNoServerOnlySyntax = (message) => [
  ...dynamicRulesFor(serverOnlyRegex, serverOnlyMessage),
  ...dynamicRulesFor(`${allAdaptersRegex}|${appsRegex}`, message),
];

const webMessage = "apps/web may not import adapters or apps/server; it may use @tektum/grimoire-core (contracts are silent, so core is allowed) (R11.1).";
const libMessage = "Shared libraries may not import adapters, apps or server-only libraries (R2.18, R11.1).";
const composeMessage =
  "Only apps/server/src/composition.ts constructs adapters; elsewhere import adapter packages as types only (contracts section 1, R2.18).";

// Relative specifiers that name another package's directory (the scan test in packages/core/test/boundaries is the
// authority: it resolves every relative specifier and fails when it leaves the package).
const relativeMessage = "Do not reach into another package by a relative path; import it by package name (R2.18).";
// Anchored to relative specifiers (`./` or `../`): a bare package subpath such as `crossws/adapters/node` must not match.
const relativePatterns = [{ regex: "^\\.{1,2}\\/(?:.*\\/)?(?:packages|apps|adapters)(?:\\/|$)", message: relativeMessage }];
// Indirect loaders would bypass every import rule: createRequire, process.mainModule, eval and Function.
const loaderMessage = "Indirect module loading and code evaluation bypass the import rules; use a literal import (R2.18).";
// The whole module is banned (not just the name): `import m from "node:module"; m.createRequire` would pass importNames.
const loaderPaths = ["node:module", "module"].map((name) => ({ name, message: loaderMessage }));
const restrictedImports = (patterns = [], paths = []) => [
  "error",
  { paths: [...paths, ...loaderPaths], patterns: [...patterns, ...relativePatterns] },
];

// Only string literals (and expression-free templates, which the module rules above read as strings) may be imported
// dynamically, so the module rules cannot be bypassed.
const nonLiteralMessage = "Dynamic import() and require() take a plain string literal, so the import rules can see the module.";
const nonLiteralRules = [
  {
    selector: "ImportExpression:not([source.type='Literal']):not([source.type='TemplateLiteral'][source.expressions.length=0])",
    message: nonLiteralMessage,
  },
  {
    selector:
      "CallExpression[callee.name='require']:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0])",
    message: nonLiteralMessage,
  },
];
nonLiteralRules.push(
  { selector: "MemberExpression[object.name='process'][property.name='mainModule']", message: loaderMessage },
  { selector: "MemberExpression[object.name='process'][property.value='mainModule']", message: loaderMessage },
  { selector: "CallExpression[callee.name='eval']", message: loaderMessage },
  { selector: "CallExpression[callee.name='Function']", message: loaderMessage },
  { selector: "NewExpression[callee.name='Function']", message: loaderMessage },
  { selector: "MemberExpression[object.name='globalThis'][property.name=/^(?:eval|Function)$/]", message: loaderMessage },
);
// Our own code that genuinely imports a computed path (each reasoned here; both are the only such files).
const nonLiteralExempt = [
  "packages/adapters/db-kysely/src/index.ts", // loads migration files by path for Kysely's migration provider
  "packages/core/test/boundaries/reference-excluded.test.ts", // imports the repository's vitest.config.js by file URL
];
const scope = (files, imports, syntax, exempt = []) => [
  { files, ignores: exempt, rules: { "no-restricted-imports": imports, "no-restricted-syntax": ["error", ...syntax, ...nonLiteralRules] } },
  ...(exempt.length
    ? [{ files: exempt, rules: { "no-restricted-imports": imports, "no-restricted-syntax": ["error", ...syntax] } }]
    : []),
];

export default defineConfig([
  globalIgnores(["reference/**", "**/node_modules/**", "**/dist/**", "**/coverage/**", "packages/core/test/boundaries/fixtures/**"]),
  tseslint.configs.recommended,
  // Every workspace package: no relative reach into other packages, no computed dynamic imports.
  ...scope(["apps/**", "packages/**"], restrictedImports(), [], nonLiteralExempt),
  ...scope(
    ["packages/core/**"],
    restrictedImports(
      [{ group: forbiddenImportPatterns, message: importMessage }],
      [
        { name: "process", message: envMessage },
        { name: "node:process", message: envMessage },
      ],
    ),
    [...envRules, ...dynamicImportRules],
    nonLiteralExempt.filter((f) => f.startsWith("packages/core/")),
  ),
  // Adapters: core and own library only.
  ...adapterNames.flatMap((name) =>
    scope(
      [`packages/adapters/${name}/**`],
      restrictedImports([
        { group: adaptersExcept(name), message: adapterLayerMessage },
        { group: ["@tektum/grimoire-server", "@tektum/grimoire-server/*", "@tektum/grimoire-web", "@tektum/grimoire-web/*"], message: adapterLayerMessage },
      ]),
      dynamicRulesFor(`^@tektum\\/grimoire-adapter-(?!${escapeRegex(name)}(?:$|\\/))|${appsRegex}`, adapterLayerMessage),
      nonLiteralExempt.filter((f) => f.startsWith(`packages/adapters/${name}/`)),
    ),
  ),
  // apps/web: no server-only libraries, adapters or apps/server.
  ...scope(["apps/web/**"], restrictedImports(noAdaptersNoServerOnly(webMessage).patterns), noAdaptersNoServerOnlySyntax(webMessage)),
  ...scope(
    ["packages/editor-schema/**", "packages/api-client/**"],
    restrictedImports(noAdaptersNoServerOnly(libMessage).patterns),
    noAdaptersNoServerOnlySyntax(libMessage),
  ),
  // apps/server: adapters only as types, except in composition.ts (the one place adapters are constructed).
  {
    files: ["apps/server/src/**"],
    ignores: ["apps/server/src/composition.ts", "apps/server/src/cli.ts"],
    rules: {
      "no-restricted-imports": restrictedImports([{ group: ["@tektum/grimoire-adapter-*"], allowTypeImports: true, message: composeMessage }]),
      "no-restricted-syntax": ["error", ...dynamicRulesFor(allAdaptersRegex, composeMessage), ...nonLiteralRules],
    },
  },
  // composition.ts and cli.ts (the migration command line, a second composition root; reported to the manager in
  // M1-T02c) construct adapters, so only the relative-path and computed-import rules apply to them.
  ...scope(["apps/server/src/composition.ts", "apps/server/src/cli.ts"], restrictedImports(), []),
]);
