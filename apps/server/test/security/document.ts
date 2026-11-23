import type { Policy } from '../../src/http/policy.js';
import { buildDocument } from '../../src/openapi/emit.js';

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  minProperties?: number;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};
interface RawOperation {
  operationId: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  'x-grimoire-policy': Policy;
  'x-grimoire-idempotent'?: boolean;
  'x-grimoire-rate-limit'?: { max: number; windowSeconds: number };
}
interface RawDocument { paths: Record<string, Record<string, RawOperation>>; components?: { schemas?: Record<string, Schema> } }

/** One operation of the generated document, which is the only list the walks use (a hand-kept list is only checked against it). */
export interface Operation {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly policy: Policy;
  readonly idempotent: boolean;
  readonly bodySchema: Schema | undefined;
  readonly pathParams: readonly string[];
  readonly raw: RawOperation;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

export function operationsOf(document: object): Operation[] {
  const doc = document as RawDocument;
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const raw = item[method];
      if (raw === undefined) continue;
      out.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: raw.operationId,
        policy: raw['x-grimoire-policy'],
        idempotent: raw['x-grimoire-idempotent'] === true,
        bodySchema: raw.requestBody?.content?.['application/json']?.schema,
        pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
        raw,
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export const document = (): RawDocument => buildDocument() as RawDocument;
export const operations = (): Operation[] => operationsOf(buildDocument());

/** The operations that do not carry a policy (the factory refuses to build such a document, so this is what a bypass would leave). */
export const withoutPolicy = (ops: readonly Operation[]): string[] => ops.filter((o) => o.policy === undefined || typeof (o.policy as { kind?: unknown }).kind !== 'string').map((o) => o.key);

/** A JSON example of a body schema that the route accepts: required fields, enough optional ones to satisfy `minProperties`, and ids from `hints`. */
export function exampleBody(schema: Schema, hints: Readonly<Record<string, unknown>>): unknown {
  const components = document().components?.schemas ?? {};
  const resolve = (s: Schema): Schema => (s.$ref === undefined ? s : resolve(components[s.$ref.split('/').pop() as string] as Schema));
  const make = (raw: Schema, name: string): unknown => {
    if (name in hints) return hints[name];
    const s = resolve(raw);
    if (s.nullable === true) return null;
    if (s.allOf !== undefined) return Object.assign({}, ...s.allOf.map((part) => make(part, name)) as object[]);
    const union = s.oneOf ?? s.anyOf;
    if (union !== undefined) return make(union[0] as Schema, name);
    if (s.enum !== undefined) return s.enum[0];
    switch (s.type) {
      case 'string': return s.format === 'uuid' ? hints['uuid'] : 'x'.repeat(Math.max(s.minLength ?? 1, 1));
      case 'integer':
      case 'number': return s.minimum ?? 0;
      case 'boolean': return false;
      case 'array': return (s.minItems ?? 0) > 0 ? [make(s.items as Schema, name)] : [];
      default: {
        const properties = s.properties ?? {};
        const required = s.required ?? [];
        const names = [...required];
        const optional = Object.keys(properties).filter((k) => !required.includes(k));
        // A body with nothing required still needs one field, or a route that refuses an empty change would refuse it.
        while (names.length < Math.max(s.minProperties ?? 0, required.length === 0 ? 1 : 0) && optional.length > 0) names.push(optional.shift() as string);
        return Object.fromEntries(names.map((k) => [k, make(properties[k] as Schema, k)]));
      }
    }
  };
  return make(schema, '');
}

/** The names of the fields of an operation's JSON body (the schema itself, or what it extends). */
export function bodyFields(op: Operation): string[] {
  const components = document().components?.schemas ?? {};
  const names = (s: Schema | undefined): string[] => {
    if (s === undefined) return [];
    if (s.$ref !== undefined) return names(components[s.$ref.split('/').pop() as string]);
    return [...Object.keys(s.properties ?? {}), ...(s.allOf ?? []).flatMap(names)];
  };
  return names(op.bodySchema);
}
