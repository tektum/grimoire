import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { apiUrl, repoRoot } from '../support/env.ts';

// `bun run client-config.ts [file]`: makes the built client's config.json name the address the specifications and the rendered headers (headers.ts) use, `apiUrl()` (E2E_API_URL), so that the
// production content security policy lists the origin the client talks to. The built file names `localhost`; the headers are rendered for the stack as the specifications reach it.
const file = process.argv[2] ?? path.join(repoRoot, 'apps/web/dist/config.json');
const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
writeFileSync(file, `${JSON.stringify({ ...config, apiUrl: apiUrl() })}\n`);
process.stdout.write(`${file}: apiUrl ${apiUrl()}\n`);
