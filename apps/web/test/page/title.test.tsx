import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageTitle, TITLE_MAX } from '../../src/screens/page/PageTitle';
import { type PageResult, titled } from '../../src/screens/page/usePage';
import '../support/dom';

afterEach(cleanup);

const setup = (props: { title?: string; editable?: boolean; startEditing?: boolean; save?: (title: string) => Promise<boolean> } = {}) => {
  const onSave = vi.fn(props.save ?? (async () => true));
  render(<PageTitle title={props.title ?? 'Welcome'} editable={props.editable ?? true} startEditing={props.startEditing ?? false} onSave={onSave} />);
  return onSave;
};
const field = () => screen.getByRole('textbox', { name: 'Page title' }) as HTMLInputElement;

describe('the title of a page, in place', () => {
  it('is the main heading, and for a person who may edit it a button with the title as its name', () => {
    setup();
    const heading = screen.getByRole('heading', { level: 1, name: 'Welcome' });
    expect(heading.id).toBe('screen-title');
    expect(screen.getByRole('button', { name: 'Welcome' }).getAttribute('title')).toBe('Rename this page');
  });

  it('is plain text for a person who may not edit the page', () => {
    setup({ editable: false });
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows "Untitled" for a page nobody has named', () => {
    setup({ title: '' });
    expect(screen.getByRole('button', { name: 'Untitled' }).getAttribute('data-untitled')).toBe('true');
  });

  it('becomes a field on a click, with the title in it selected and the length limit of R3.21', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    expect(field().value).toBe('Welcome');
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe('Welcome'.length);
    expect(field().maxLength).toBe(TITLE_MAX);
    expect(TITLE_MAX).toBe(255);
    expect(screen.getByRole('heading', { level: 1, name: 'Page title' })).toBeTruthy();
  });

  it('is opened from the keyboard: Enter on the button', async () => {
    setup();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('{Enter}');
    expect(field()).toBeTruthy();
  });

  it('saves the trimmed title on Enter, closes the field and puts the focus back on the button', async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('  Handbook  {Enter}');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Handbook');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button')));
  });

  it('keeps the title on Escape and saves nothing', async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('Something else{Escape}');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Welcome' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button'));
  });

  it('saves what is in the field when the person leaves it', async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('Left alone');
    await userEvent.click(document.body);
    expect(onSave).toHaveBeenCalledWith('Left alone');
  });

  it.each([
    ['an empty field', '{Backspace}{Enter}'],
    ['a field of spaces', '   {Enter}'],
    ['the same title', '{Enter}'],
  ])('saves nothing for %s, and closes the field', async (_name, keys) => {
    const onSave = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard(keys);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('saves once when Enter is followed by the blur of the closing field', async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('Once{Enter}');
    await userEvent.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps the old title when the server refuses the new one', async () => {
    const onSave = setup({ save: async () => false });
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('Refused{Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(onSave).toHaveBeenCalledWith('Refused');
    expect(screen.getByRole('button', { name: 'Welcome' })).toBeTruthy();
  });

  it('opens with the empty field focused for a new page, and the page stays untitled when it is left empty', async () => {
    const onSave = setup({ title: '', startEditing: true });
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('Untitled');
    expect(document.activeElement).toBe(field());
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Untitled' })).toBeTruthy();
  });

  it('names a new page with what is typed in the field it opens with', async () => {
    const onSave = setup({ title: '', startEditing: true });
    await userEvent.keyboard('Roadmap{Enter}');
    expect(onSave).toHaveBeenCalledWith('Roadmap');
  });

  it('does not open a field for a person who may not edit, even for a new page', () => {
    setup({ title: '', editable: false, startEditing: true });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Untitled' })).toBeTruthy();
  });

  it('does not take the focus back when the person leaves the field for somewhere else (it saves, and the focus stays where they went)', async () => {
    const onSave = vi.fn(async () => true);
    render(
      <>
        <PageTitle title="Welcome" editable startEditing={false} onSave={onSave} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    await userEvent.keyboard('Moved on');
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Moved on'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
  });

  it('does not take the focus back for a new page whose empty field is left by a click elsewhere', async () => {
    render(
      <>
        <PageTitle title="" editable startEditing onSave={async () => true} />
        <button type="button">Into the text</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Into the text' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Into the text' }));
  });

  it('saves nothing for a stored title that has spaces around it and is left unchanged', async () => {
    const onSave = setup({ title: '  Padded  ' });
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('the cached page after a rename', () => {
  const found = (over: object = {}): PageResult => ({ kind: 'found', page: { id: 'p', title: 'Old', urlId: 'u', myPermission: 'read-write', markdownStale: false, ...over } as never });

  it('changes only the title of the answer the cache has now, whatever a re-read brought in meanwhile', () => {
    const now = found({ myPermission: 'read-only', markdownStale: true });
    expect(titled(now, 'New')).toEqual(found({ title: 'New', myPermission: 'read-only', markdownStale: true }));
  });

  it('leaves a missing page and an empty cache as they are', () => {
    expect(titled({ kind: 'missing' }, 'New')).toEqual({ kind: 'missing' });
    expect(titled(undefined, 'New')).toBeUndefined();
  });
});
