// Runs the infrastructure program of a stage with the cloud and the identity provider replaced by recorders, and returns what it declared: every resource's type, name and arguments, in
// order. Nothing is created and nothing is contacted. A value the provider would compute (an id, an address) is a placeholder named after where it came from, so two programs that wire
// their resources the same way record the same text. The big documents of the provider (flows, styles) are recorded as `<document>`: they change on purpose, in their own pull requests.
const DOCUMENT_KEYS = new Set(['data']);

const PATHS = new WeakMap();

export function placeholder(path) {
  const target = function () {};
  const proxy = new Proxy(target, {
    get(_, prop) {
      if (prop === 'toJSON' || prop === Symbol.toPrimitive || prop === 'toString') return () => `<${path}>`;
      if (prop === 'apply') return (fn) => placeholder(`${path}|apply(${String(fn).length > 0 ? 'fn' : ''})`);
      if (typeof prop === 'symbol') return undefined;
      return placeholder(`${path}.${prop}`);
    },
    apply: () => placeholder(`${path}()`),
  });
  PATHS.set(proxy, path);
  return proxy;
}

export function recordProgram(run) {
  const calls = [];
  const raw = []; // the arguments as given (functions kept), for a test that has to run a transform
  const plain = (value, key) => {
    if (DOCUMENT_KEYS.has(key)) return '<document>';
    if (typeof value === 'function') return PATHS.has(value) ? `<${PATHS.get(value)}>` : '<function>';
    if (Array.isArray(value)) return value.map((v) => plain(v));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, k)]));
    }
    return value;
  };
  const klass = (type) => class {
    constructor(name, args, opts) {
      calls.push({ type, name, args: plain(args ?? {}), ...(opts === undefined ? {} : { opts: plain(opts) }) });
      raw.push({ type, name, args });
      return placeholder(name);
    }
    /** `X.get(name, id)`: an existing resource read by id, recorded as its own kind of call. */
    static get(name, id) {
      calls.push({ type: `${type}.get`, name, args: { id: plain(id) } });
      return placeholder(name);
    }
  };
  const namespace = (prefix) => new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      const path = `${prefix}.${prop}`;
      if (/^[A-Z]/.test(prop)) return klass(`${prefix}:${prop}`);
      // A data lookup (`getXOutput(args)`): whatever is read from the result is a placeholder named after the lookup and its arguments (`region` keeps its older, shorter name).
      if (/^get.*Output$/.test(prop)) return (args) => new Proxy({}, { get: (_, field) => (typeof field !== 'string' ? undefined : field === 'region' ? placeholder(`${path}.region`) : placeholder(`${path}(${JSON.stringify(plain(args ?? {}))}).${field}`)) });
      if (/^[a-z]/.test(prop) && prefix.split('.').length > 1) return (args) => ({ call: path, args: plain(args ?? {}) });
      return namespace(path);
    },
  });
  const tag = (strings, ...values) => placeholder(strings.reduce((out, s, i) => out + s + (i < values.length ? `{${String(values[i])}}` : ''), 'interpolate:'));
  const g = globalThis;
  const saved = Object.fromEntries(['sst', 'aws', 'random', 'descope', '$app', '$interpolate', '$output', '$resolve', '$util'].map((k) => [k, g[k]]));
  g.$app = { name: 'grimoire', stage: 'recorded' };
  g.sst = namespace('sst'); g.aws = namespace('aws'); g.random = namespace('random'); g.descope = namespace('descope');
  g.$interpolate = tag;
  g.$output = (v) => placeholder(`output(${typeof v === 'string' ? v : 'value'})`);
  g.$resolve = (v) => placeholder(`resolve(${Object.keys(v ?? {}).join(',')})`);
  g.$util = {};
  let returned;
  try { returned = run(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } }
  return { calls, raw, returned: plain(returned ?? {}) };
}
