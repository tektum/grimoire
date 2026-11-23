import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import openapiTS, { astToString } from 'openapi-typescript';

// Guards the generator pin: openapi-typescript declares TypeScript 5 as its peer, the repository uses TypeScript 6.
const document = {
  openapi: '3.1.0',
  info: { title: 'probe', version: '1' },
  paths: {
    '/v1/things/{id}': {
      post: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  },
};

function diagnostics(source: string): string[] {
  const file = 'probe.ts';
  const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === file ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2023) : read(name, ...rest));
  return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('openapi-typescript under the repository TypeScript', () => {
  it('emits types that compile, and the types reject a wrong request body', async () => {
    const generated = astToString(await openapiTS(document as never));
    expect(ts.version.startsWith('6.')).toBe(true);
    const uses = (body: string): string =>
      `${generated}\ntype Body = paths['/v1/things/{id}']['post']['requestBody']['content']['application/json'];\nexport const body: Body = ${body};\n`;
    expect(diagnostics(uses('{ title: "x" }'))).toEqual([]);
    expect(diagnostics(uses('{ title: 1 }')).join('\n')).toContain("'number' is not assignable to type 'string'");
  }, 30_000); // it type-checks generated code with the TypeScript compiler: ~1.3 s alone, over the 5 s default under full-suite coverage load on two cores
});
