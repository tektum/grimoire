/**
 * The file piscina loads in each worker thread. Piscina loads its task file with `require`, which for an ES module goes through
 * Node's require(esm) path (a native abort was seen there on worker start). This CommonJS file is hand-written, not compiled, and sits in the package
 * root (next to `dist`, never inside it), so its `import()` stays a real one: it forwards each task to the ES-module worker named by `workerData.workerUrl`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file
const { workerData } = require('node:worker_threads');

let loaded;

module.exports = async (task) => {
  loaded ??= (async () => {
    const url = workerData?.workerUrl;
    if (typeof url !== 'string') throw new TypeError('worker-entry needs workerData.workerUrl');
    // eslint-disable-next-line no-restricted-syntax -- the point of this file: the specifier is the URL of the ES-module worker, given at start
    return (await import(url)).default;
  })();
  return (await loaded)(task);
};
