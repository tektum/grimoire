import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cursorBuilders } from '../../src/editor/core/cursor';
import { createDirectory, DISPLAY_NAME_MAX, UNKNOWN_NAME } from '../../src/editor/core/directory';
import '../support/dom';

// A collaborator's name comes from the server's directory and can be anything a person typed (security review F10): it is shown as text, never as markup, cut to 40
// characters, with control characters removed.
const ID = '00000000-0000-4000-8000-000000000001';

/** A directory that has been told this name for ID by the server. */
async function directoryWith(name: string) {
  const directory = createDirectory({ fetchNames: async (ids) => ids.map((id) => ({ id, name })), setTimeout: (fn) => { fn(); return 0; } });
  const arrived = new Promise<void>((resolve) => directory.subscribe(resolve));
  directory.request([ID]);
  await arrived;
  return directory;
}

describe('a collaborator name is untrusted', () => {
  it('is shown as that text, with no element made from it and no script run, in the label of the cursor and in a plain element', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    const name = '<img src=x onerror=alert(1)>';
    const directory = await directoryWith(name);
    const label = cursorBuilders(directory).cursorBuilder({ id: ID }).querySelector('.cursor-label')!;
    expect(label.textContent).toBe(name);
    expect(label.children).toHaveLength(0);
    const view = render(<span data-testid="who">{directory.nameOf(ID)}</span>);
    expect(view.getByTestId('who').textContent).toBe(name);
    expect(view.getByTestId('who').querySelector('img')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it(`is cut to ${DISPLAY_NAME_MAX} characters when it is 10,000 long`, async () => {
    const directory = await directoryWith('A'.repeat(10_000));
    expect(directory.nameOf(ID)).toBe('A'.repeat(DISPLAY_NAME_MAX));
    expect(cursorBuilders(directory).cursorBuilder({ id: ID }).querySelector('.cursor-label')!.textContent).toHaveLength(DISPLAY_NAME_MAX);
  });

  it('is cut by characters, not in the middle of one (a letter outside the basic plane is two code units)', async () => {
    const directory = await directoryWith('😀'.repeat(60));
    expect([...directory.nameOf(ID)]).toHaveLength(DISPLAY_NAME_MAX);
    expect(directory.nameOf(ID)).toBe('😀'.repeat(DISPLAY_NAME_MAX));
  });

  it.each([
    ['a line break and a tab', 'Ada\nLovelace\tCountess', 'Ada Lovelace Countess'],
    ['a NUL and an escape', 'Ada\u0000Love\u001Blace', 'AdaLovelace'],
    ['a right-to-left override', 'Ada\u202Eecalevol', 'Adaecalevol'],
    ['an isolate and a zero-width space', '\u2066Ada\u200BLovelace\u2069', 'AdaLovelace'],
    ['a delete character and a C1 control', 'Ada\u007F\u0085Lovelace', 'AdaLovelace'],
  ])('has %s taken out', async (_label, raw, shown) => {
    expect((await directoryWith(raw)).nameOf(ID)).toBe(shown);
  });

  it('keeps ordinary names as they are, with their spaces, accents and scripts', async () => {
    for (const name of ['Ada Lovelace', 'Zoë Müller-Åkesson', 'محمد علي', '李小龍', "O'Brien, Pat"]) expect((await directoryWith(name)).nameOf(ID)).toBe(name);
  });

  it(`falls back to "${UNKNOWN_NAME}" for a name that is nothing once cleaned`, async () => {
    for (const name of ['', '   ', '\u0000\u200B\u202E', '\n\t']) expect((await directoryWith(name)).nameOf(ID)).toBe(UNKNOWN_NAME);
  });
});
