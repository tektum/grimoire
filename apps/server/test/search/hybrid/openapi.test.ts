import { describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.js';
import { makeContext } from '../../server/support/context.js';

// The OpenAPI document of `GET /v1/search` says what the semantic part adds (M7-T14): `semantic` on the page and `matchedPassage` on an item, a plain text of at most 300 characters.
type Schema = { type?: string; maxLength?: number; description?: string; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[] };
const doc = createApp(makeContext().ctx).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } }) as unknown as { components: { schemas: Record<string, Schema> } };

describe('the OpenAPI document of the search', () => {
  it('describes `semantic` on a page of results as a required boolean', () => {
    const page = doc.components.schemas['SearchPage'] as Schema;
    expect(page.properties?.['semantic']?.type).toBe('boolean');
    expect(page.properties?.['semantic']?.description).toMatch(/semantic search answered/);
    expect(page.required).toContain('semantic');
  });

  it('describes `matchedPassage` on an item as an optional object whose `text` is a string of at most 300 characters', () => {
    const item = doc.components.schemas['SearchItem'] as Schema;
    const passage = item.properties?.['matchedPassage'];
    expect(passage?.type).toBe('object');
    expect(passage?.properties?.['text']).toMatchObject({ type: 'string', maxLength: 300 });
    expect(passage?.required).toEqual(['text']);
    expect(item.required).not.toContain('matchedPassage');
  });
});
