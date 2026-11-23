import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { RouteConfig } from '@hono/zod-openapi';
import { errorResponse } from './error.js';
import type { AppEnv } from './env.js';
import type { Policy, RouteRateLimit } from './policy.js';

/** The one place a router is made. The validation hook belongs to each instance, so a router made any other way would answer in the library's own shape. */
export function createRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => (result.success ? undefined : errorResponse('invalid')),
  });
}

export const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('Error');

const standard = (description: string) => ({ description, content: { 'application/json': { schema: ErrorSchema } } });

const STANDARD_RESPONSES = {
  401: standard('Missing, malformed or expired token'),
  403: standard('Not allowed'),
  404: standard('Not found'),
  422: standard('The request is not valid'),
  429: standard('Too many requests'),
  503: standard('The service is unavailable'),
} as const;

export interface RouteDefinition extends Omit<RouteConfig, 'security' | 'responses'> {
  readonly policy: Policy;
  readonly responses: RouteConfig['responses'];
  readonly rateLimit?: RouteRateLimit;
  readonly idempotent?: boolean;
}

/** The route's own `request`, kept in its literal type so a handler's `c.req.valid` knows the validated shapes. */
type RequestOf<D> = D extends { readonly request: infer R } ? { request: R } : unknown;

/** `policy` is required, so a route without one does not type-check. */
export function defineRoute<const D extends RouteDefinition>(def: D) {
  const { policy, rateLimit, idempotent, responses, ...config } = def;
  const isPublic = policy.kind === 'public';
  const standardResponses = isPublic ? { 422: STANDARD_RESPONSES[422], 429: STANDARD_RESPONSES[429], 503: STANDARD_RESPONSES[503] } : STANDARD_RESPONSES;
  return createRoute({
    ...config,
    responses: { ...standardResponses, ...responses },
    ...(isPublic ? {} : { security: [{ bearerAuth: [] }] }),
    'x-grimoire-policy': policy,
    ...(rateLimit === undefined ? {} : { 'x-grimoire-rate-limit': rateLimit }),
    ...(idempotent === true ? { 'x-grimoire-idempotent': true } : {}),
  } as unknown as Omit<RouteConfig, 'request'> & { path: D['path']; responses: D['responses'] } & RequestOf<D>);
}
