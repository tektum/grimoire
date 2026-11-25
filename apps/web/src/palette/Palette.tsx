import { Command } from 'cmdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useApi } from '../api/context';
import { useApiQuery } from '../api/query';
import { useSession } from '../auth/session';
import { Snippet } from '../search/Snippet';
import { searchable, useSearchPreview } from '../search/useSearch';
import { QUERY_MAX } from '../search/types';
import { useCollections } from '../screens/collections/useCollections';
import { useTreeActions } from '../tree/actions';
import { useOpenCollection } from '../tree/ContentsPanel';
import { pagePath, type FlatPage } from '../tree/model';
import { useCollectionTree } from '../tree/useTree';
import { VisuallyHiddenText } from './hidden';
import { commandsFor, filterCommands } from './commands';
import './palette.css';

/** How long the typing has to stop before the search is asked (the palette searches as you type, and the server limits a person to 30 searches a minute). */
const TYPING_PAUSE_MS = 250;
/** The palette shows the best few; the search screen has the rest. */
const PREVIEW_LIMIT = 5;

/** Mod-K (Ctrl-K, or Cmd-K on a Mac) opens the palette from anywhere in the app, and closes it. A key that something took first (the link editor of the editor takes Mod-K on a selection) is left to it. */
function useShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [toggle]);
}

/** The command palette (R11.10): search, navigation and actions behind one shortcut. Nothing without a session. */
export function Palette() {
  const session = useSession();
  return session === null ? null : <PaletteDialog />;
}

function PaletteDialog() {
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const [selected, setSelected] = useState('');
  // What had the focus when the palette opened gets it back when it closes: the dialog has no trigger button for the library to return it to.
  const returnTo = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const toggle = useCallback(() => {
    // Noted when the key is pressed, before the dialog takes the focus.
    if (!opened.current) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen((was) => !was);
  }, []);
  useShortcut(toggle);
  // While the dialog is open the rest of the app is `inert` (not focusable, not clickable, not read): the library only marks it `aria-hidden`, and a hidden region that still holds focusable elements is an
  // accessibility violation (axe: aria-hidden-focus). The dialog is in a portal, outside the shell, so it is not made inert with it.
  useEffect(() => {
    const shell = document.querySelector('.shell');
    if (!open || shell === null) return;
    shell.setAttribute('inert', '');
    return () => {
      shell.removeAttribute('inert');
    };
  }, [open]);
  useEffect(() => {
    if (!open && opened.current) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected === true) back.focus();
      // Closed by any way (Escape, a choice, the shortcut): the text and the selection are put away with it.
      setText('');
      setAsked('');
      setSelected('');
    }
    opened.current = open;
  }, [open]);

  // The typing has to pause before the server is asked; what is asked is the text of then.
  useEffect(() => {
    const timer = setTimeout(() => {
      setAsked(text);
    }, TYPING_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  const { collectionId } = useOpenCollection(api);
  const me = useApiQuery<{ role?: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const writable = collections.data?.find((c) => c.id === collectionId)?.myPermission === 'read-write';
  const actions = useTreeActions(api, collectionId ?? '');
  const search = useSearchPreview(api, asked, PREVIEW_LIMIT);

  const here = useRef(location.key);
  here.current = location.key;

  // The pages of a collection the person cannot read now (the tree answers 403 or 404: access removed, collection deleted) are not offered, the rule of the contents panel; a failed re-read keeps the last
  // data, which is why the answer is looked at and not only the data.
  const unreadable = tree.error?.status === 404 || tree.error?.status === 403;
  const commands = useMemo(
    () => commandsFor({ role: me.data?.role, collections: collections.data ?? [], pages: unreadable ? [] : (tree.data ?? []), canMakePage: writable && collectionId !== undefined && !unreadable }),
    [me.data?.role, collections.data, tree.data, unreadable, writable, collectionId],
  );
  const shown = useMemo(() => filterCommands(commands, text), [commands, text]);

  const waiting = searchable(text) !== null && (searchable(text) !== searchable(asked) || search.isFetching);
  const results = searchable(text) !== null && searchable(text) === searchable(asked) && search.data !== undefined ? search.data.items : [];
  const failed = searchable(text) !== null && searchable(text) === searchable(asked) && search.isError;

  // Enter takes the first result when there is one: the selection follows the results as they arrive, not the first command that was there before them.
  const first = results[0];
  useEffect(() => {
    if (first !== undefined) setSelected(`result:${first.pageId}`);
  }, [first]);

  const close = (): void => {
    setOpen(false);
  };
  const go = (path: string): void => {
    close();
    void navigate(path);
  };
  const newPage = (): void => {
    close();
    const pressedAt = here.current;
    void actions.create(null).then((outcome) => {
      // The page that was made is opened only if the person is still where they chose the command.
      if (outcome.ok && here.current === pressedAt) {
        const page = outcome.data as FlatPage;
        void navigate(pagePath(page.title, page.urlId), { state: { newPage: true } });
      }
    });
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="modal palette"
      shouldFilter={false}
      vimBindings={false} // Ctrl-K is the shortcut of the palette itself, not "up" in its list
      value={selected}
      onValueChange={setSelected}
    >
      <VisuallyHiddenText>Search pages, go somewhere, or do something</VisuallyHiddenText>
      <Command.Input value={text} onValueChange={setText} placeholder="Search, go to, or do" maxLength={QUERY_MAX} aria-label="Search, go to, or do" />
      <Command.List>
        {results.length > 0 && (
          <Command.Group heading="Search results">
            {results.map((item) => (
              <Command.Item
                key={item.pageId}
                value={`result:${item.pageId}`}
                onSelect={() => {
                  go(pagePath(item.title, item.urlId));
                }}
              >
                <span className="palette-result-title">{item.title === '' ? 'Untitled' : item.title}</span>
                <span className="palette-snippet">
                  <Snippet snippet={item.snippet} />
                </span>
              </Command.Item>
            ))}
            <Command.Item
              value="see-all"
              onSelect={() => {
                go(`/search?q=${encodeURIComponent(text.trim())}`);
              }}
            >
              See all results for “{text.trim()}”
            </Command.Item>
          </Command.Group>
        )}
        {(['Pages', 'Collections', 'Go to', 'Actions'] as const).map((group) => {
          const items = shown.filter((c) => c.group === group);
          return items.length === 0 ? null : (
            <Command.Group key={group} heading={group}>
              {items.map((c) => (
                <Command.Item
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    c.run(go, newPage);
                  }}
                >
                  {c.label}
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
        {waiting && (
          <p className="palette-note" role="status">
            Searching…
          </p>
        )}
        {failed && (
          <p className="palette-note" role="alert">
            Search is not available right now.
          </p>
        )}
        {!waiting && !failed && results.length === 0 && shown.length === 0 && (
          <p className="palette-note" role="status">
            No results
          </p>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
