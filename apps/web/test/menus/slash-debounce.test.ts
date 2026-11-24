import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainEditor } from './support';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
let current: Editor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});

describe('the slash menu opens for what is typed, whatever else is dispatched in between', () => {
  it('the slash menu opens for a "/" even when a transaction that changes nothing follows it at once (the library keeps only the last update of a burst)', async () => {
    current = await plainEditor('Some words');
    const t = current;
    const view = t.view();
    t.cursorAtEnd();
    view.dispatch(view.state.tr.split(view.state.selection.from)); // an empty paragraph with the cursor in it
    view.dispatch(view.state.tr.insertText('/', view.state.selection.from));
    view.dispatch(view.state.tr); // the next update changes neither the document nor the selection: it is the one the library would act on
    await vi.waitFor(() => expect(t.element.querySelector('.slash-host')?.getAttribute('data-show')).toBe('true'), { timeout: 3000 });
  });
});
