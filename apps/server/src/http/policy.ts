type Need = 'read' | 'write' | 'admin';

/** What a route requires of the caller. Every route declares one; the factory checks it at compile time. */
export type Policy =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated'; readonly provision?: boolean }
  | { readonly kind: 'admin' }
  | { readonly kind: 'collection'; readonly param: string; readonly need: Need }
  | { readonly kind: 'collection-body'; readonly field: string; readonly need: 'write' }
  | { readonly kind: 'page'; readonly param: string; readonly need: 'read' | 'write' }
  | { readonly kind: 'page-body'; readonly field: string; readonly need: 'write' }
  | { readonly kind: 'attachment'; readonly param: string; readonly need: 'read' }
  | { readonly kind: 'uploader'; readonly param: string }
  | { readonly kind: 'import'; readonly param: string; readonly who: 'creator' | 'creator-or-admin' }
  | { readonly kind: 'trash'; readonly param: string; readonly need: 'read' | 'write' };

/** A limit for one route, counted per user on top of the overall limit. */
export interface RouteRateLimit { readonly max: number; readonly windowSeconds: number }
