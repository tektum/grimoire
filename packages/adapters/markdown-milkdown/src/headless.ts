import {
  Editor,
  ParserReady,
  SerializerReady,
  config,
  init,
  parser,
  parserCtx,
  schema,
  schemaCtx,
  serializer,
  serializerCtx,
} from '@milkdown/core';
import { Clock, Container, Ctx } from '@milkdown/ctx';
import { escapeClosingBracketsCtx, grimoireEditorPlugins, hasTooManyClosingBrackets } from '@tektum/grimoire-editor-schema';
import { installEventGlobals } from './polyfill.js';

const readHeadless = (ctx: Ctx) => {
  const serialize = ctx.get(serializerCtx);
  return {
    schema: ctx.get(schemaCtx),
    parse: ctx.get(parserCtx),
    // Synchronous, so the flag cannot be seen by another document: a document with thousands of `]` has them escaped (see CLOSING_BRACKET_LIMIT).
    serialize: (doc: Parameters<typeof serialize>[0]): string => {
      ctx.set(escapeClosingBracketsCtx, hasTooManyClosingBrackets(doc));
      return serialize(doc);
    },
  };
};

export type Headless = ReturnType<typeof readHeadless>;

/**
 * Milkdown's own schema, parser and serializer on a bare `@milkdown/ctx` context: its core plugins run, the view, the
 * keymaps and the commands do not, so no DOM is needed. About 15 lines because Milkdown has no headless API (measured:
 * docs/proof/m2-conversion.md). The caller starts waiting before the plugins run because the ready signals are events and a missed one
 * never fires.
 */
export async function createHeadless(plugins = grimoireEditorPlugins): Promise<Headless> {
  installEventGlobals();
  const ctx = new Ctx(new Container(), new Clock());
  // `init` only stores the editor object in a slice that nothing here reads; an unstarted Editor satisfies its type.
  const all = [config(async () => undefined), init(Editor.make()), schema, parser, serializer, ...plugins];
  const handlers = all.map((plugin) => plugin(ctx.produce()));
  const ready = Promise.all([ctx.wait(SerializerReady), ctx.wait(ParserReady)]);
  for (const handler of handlers) {
    // Handlers of plugins that wait for slices the headless context never fills (commands, keymaps) stay pending, and some reject for that reason: not awaited,
    // their errors are not the build's.
    if (typeof handler === 'function') void Promise.resolve(handler()).catch(() => undefined);
  }
  await ready; // the ready signals come from the three core plugins always included above, so a failing extra plugin cannot leave them pending
  return readHeadless(ctx);
}

let shared: Promise<Headless> | undefined;

/** One headless context per module instance, built on first use (a cache, not shared state between calls). */
export function getHeadless(): Promise<Headless> {
  shared ??= createHeadless().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
