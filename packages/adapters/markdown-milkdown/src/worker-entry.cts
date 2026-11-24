/**
 * The file piscina loads in each worker thread. Piscina loads its task file with `require`, which for an ES module goes through
 * Node's require(esm) path (a native abort was seen there on worker start). This CommonJS file only forwards each task to the
 * real ES-module worker through `import()`, so the ES module is never required. The URL arrives as `workerData.workerUrl`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file
const threads = require('node:worker_threads') as typeof import('node:worker_threads');

type Handler = (task: unknown) => unknown;
// A real `import()`: the compiler turns a written one in a CommonJS file into `require`, which is what this file avoids.
// eslint-disable-next-line no-restricted-syntax -- the one place that needs it: see above
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ default: Handler }>;
let loaded: Promise<Handler> | undefined;

const load = (): Promise<Handler> => {
  const d: unknown = threads.workerData;
  const url = typeof d === 'object' && d !== null && 'workerUrl' in d ? d.workerUrl : undefined;
  if (typeof url !== 'string') throw new TypeError('worker-entry needs workerData.workerUrl');
  return importModule(url).then((m) => m.default);
};

module.exports = async (task: unknown): Promise<unknown> => {
  loaded ??= load();
  return (await loaded)(task);
};
