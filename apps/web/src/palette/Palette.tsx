import { Command } from 'cmdk';
import { CornerDownLeft, FileText, Folder, Plus, Search as SearchIcon, SquareArrowOutUpRight, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { onOpenPalette } from './open';
import { commandsFor, filterCommands, type Command as CommandItem } from './commands';
import { readRecent, type RecentPage } from '../storage/recent';
import './palette.css';

/** How long the typing has to stop before the search is asked (the palette searches as you type, and the server limits a person to 30 searches a minute). */
const TYPING_PAUSE_MS = 250;
/** The palette shows the best few; the search screen has the rest. */
const PREVIEW_LIMIT = 5;


const GROUP_ICON: Readonly<Record<CommandItem['group'], LucideIcon>> = { Recent: FileText, Pages: FileText, Collections: Folder, 'Go to': SquareArrowOutUpRight, Actions: Plus };
const escapeRe = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words of the typed text that matched, in weight 600 (no colour): the label of a row is text, split at the typed words. */
function Matched({ text, words }: { text: string; words: readonly string[] }) {
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.map(escapeRe).join('|')})`, 'i'));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <b key={i} className="palette-hit">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** What every row has: an icon (decoration), its label, what it is under (quietly), and the return glyph that shows on the selected row. */
function Row({ icon: Icon, children, path }: { icon: LucideIcon; children: ReactNode; path?: string | undefined }) {
  return (
    <>
      <Icon className="palette-icon" aria-hidden size={16} strokeWidth={1.5} />
      <span className="palette-row-text">
        <span className="palette-label">{children}</span>
        {/* Beside the label for the eye: the accessible name of the row stays its label. */}
        {path === undefined || path === '' ? null : (
          <span className="palette-path" aria-hidden="true">
            {path}
          </span>
        )}
      </span>
      <CornerDownLeft className="palette-return" aria-hidden size={14} strokeWidth={1.5} />
    </>
  );
}


function CommandGroup({ group, items, words, go, newPage }: { group: string; items: readonly CommandItem[]; words: readonly string[]; go: (path: string) => void; newPage: () => void }) {
  if (items.length === 0) return null;
  return (
    <Command.Group heading={group}>
      {items.map((c) => (
        <Command.Item
          key={c.id}
          value={c.id}
          onSelect={() => {
            c.run(go, newPage);
          }}
        >
          <Row icon={GROUP_ICON[c.group]} path={c.path}>
            <Matched text={c.label} words={words} />
          </Row>
        </Command.Item>
      ))}
    </Command.Group>
  );
}

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
  const [recent, setRecent] = useState<readonly RecentPage[]>([]);
  // What had the focus when the palette opened gets it back when it closes: the dialog has no trigger button for the library to return it to.
  const returnTo = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const toggle = useCallback(() => {
    // Noted when the key is pressed, before the dialog takes the focus.
    if (!opened.current) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen((was) => !was);
  }, []);
  useShortcut(toggle);
  // A button opens it, and does not close it: only a closed palette is toggled.
  useEffect(() => onOpenPalette(() => { if (!opened.current) toggle(); }), [toggle]);
  useEffect(() => {
    if (!open && opened.current) {
      const back = returnTo.current;
      returnTo.current = null;
      // A moment later: the rest of the app is inert while the library hides it, and is let go of just after the dialog closes (`ui/inert-layers.ts`); an inert element cannot take the focus.
      if (back?.isConnected === true)
        setTimeout(() => {
          back.focus();
        }, 0);
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
  const me = useApiQuery<{ id?: string; role?: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  const collections = useCollections(api);
  // What was opened last is read when the palette opens: another tab may have added to it since.
  const meId = me.data?.id;
  useEffect(() => {
    if (open) setRecent(meId === undefined ? [] : readRecent(meId));
  }, [open, meId]);
  const tree = useCollectionTree(api, collectionId);
  const writable = collections.data?.find((c) => c.id === collectionId)?.myPermission === 'read-write';
  const collectionName = collections.data?.find((c) => c.id === collectionId)?.name;
  const actions = useTreeActions(api, collectionId ?? '');
  const search = useSearchPreview(api, asked, PREVIEW_LIMIT);

  const here = useRef(location.key);
  here.current = location.key;

  // The pages of a collection the person cannot read now (the tree answers 403 or 404: access removed, collection deleted) are not offered, the rule of the contents panel; a failed re-read keeps the last
  // data, which is why the answer is looked at and not only the data.
  const unreadable = tree.error?.status === 404 || tree.error?.status === 403;
  const commands = useMemo(
    () => commandsFor({ role: me.data?.role, collections: collections.data ?? [], pages: unreadable ? [] : (tree.data ?? []), collectionName, recent, canMakePage: writable && collectionId !== undefined && !unreadable }),
    [me.data?.role, collections.data, tree.data, unreadable, writable, collectionId, collectionName, recent],
  );
  const words = useMemo(() => text.toLowerCase().split(/\s+/).filter((w) => w !== ''), [text]);
  // Before anything is typed what was opened last comes first, and the first pages of the collection only when nothing was opened yet.
  const shown = useMemo(() => {
    const all = filterCommands(commands, text);
    return words.length === 0 && recent.length > 0 ? all.filter((c) => c.group !== 'Pages') : all;
  }, [commands, text, words, recent]);

  const waiting = searchable(text) !== null && (searchable(text) !== searchable(asked) || search.isFetching);
  const current = searchable(text) !== null && searchable(text) === searchable(asked) && search.data !== undefined ? search.data.items : null;
  // While a search runs the previous results stay, at full contrast: the list does not flash empty between two letters.
  const kept = useRef<typeof current>(null);
  if (current !== null) kept.current = current;
  if (searchable(text) === null) kept.current = null;
  const results = current ?? (waiting ? (kept.current ?? []) : []);
  const failed = searchable(text) !== null && searchable(text) === searchable(asked) && search.isError;

  // Enter takes the first result when there is one: the selection follows the results as they arrive, not the first command that was there before them.
  const first = results[0];
  useEffect(() => {
    if (first !== undefined) setSelected(`result:${first.pageId}`);
  }, [first]);

  // Nothing matches: the one thing offered, New page with the text as its title, is the row Enter takes.
  const offersTitled = !waiting && !failed && results.length === 0 && shown.length === 0 && writable && collectionId !== undefined && !unreadable && text.trim() !== '';
  useEffect(() => {
    if (offersTitled) setSelected('action:new-page-titled');
  }, [offersTitled]);

  const close = (): void => {
    setOpen(false);
  };
  const go = (path: string): void => {
    close();
    void navigate(path);
  };
  const newPage = (title?: string): void => {
    close();
    const pressedAt = here.current;
    void actions.create(null, undefined, title).then((outcome) => {
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
      overlayClassName="overlay"
      shouldFilter={false}
      vimBindings={false} // Ctrl-K is the shortcut of the palette itself, not "up" in its list
      value={selected}
      onValueChange={setSelected}
    >
      <VisuallyHiddenText>Search pages, go somewhere, or do something</VisuallyHiddenText>
      <div className="palette-input">
        <SearchIcon aria-hidden size={18} strokeWidth={1.5} />
        <Command.Input value={text} onValueChange={setText} placeholder="Search, go to, or do" maxLength={QUERY_MAX} aria-label="Search, go to, or do" />
      </div>
      {/* A thin line under the input while a search runs (decoration: "Searching…" below is what is announced). */}
      <div className="palette-progress" data-active={waiting ? 'true' : 'false'} aria-hidden="true" />
      <Command.List>
        {(['Recent', 'Pages'] as const).map((group) => (
          <CommandGroup key={group} group={group} items={shown.filter((c) => c.group === group)} words={words} go={go} newPage={newPage} />
        ))}
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
                <Row icon={FileText} path={collections.data?.find((c) => c.id === item.collectionId)?.name}>
                  <Matched text={item.title === '' ? 'Untitled' : item.title} words={words} />
                  <span className="palette-snippet">
                    <Snippet snippet={item.snippet} />
                  </span>
                </Row>
              </Command.Item>
            ))}
            <Command.Item
              value="see-all"
              onSelect={() => {
                go(`/search?q=${encodeURIComponent(text.trim())}`);
              }}
            >
              <Row icon={SearchIcon}>See all results for “{text.trim()}”</Row>
            </Command.Item>
          </Command.Group>
        )}
        {(['Collections', 'Go to', 'Actions'] as const).map((group) => (
          <CommandGroup key={group} group={group} items={shown.filter((c) => c.group === group)} words={words} go={go} newPage={newPage} />
        ))}
        {waiting && (
          <p className="palette-note palette-searching" role="status">
            Searching…
          </p>
        )}
        {failed && (
          <p className="palette-note" role="alert">
            Search is not available right now.
          </p>
        )}
        {!waiting && !failed && results.length === 0 && shown.length === 0 && (
          <>
            <p className="palette-note" role="status">
              No pages match “{text.trim()}”
            </p>
            {offersTitled && (
              <Command.Group>
                <Command.Item
                  value="action:new-page-titled"
                  onSelect={() => {
                    newPage(text.trim());
                  }}
                >
                  <Row icon={Plus} path={`titled “${text.trim()}”`}>
                    New page
                  </Row>
                </Command.Item>
              </Command.Group>
            )}
          </>
        )}
      </Command.List>
      {/* The keys, as keycaps: the arrows and return are glyphs, and the words are their accessible text. */}
      <p className="palette-foot">
        <span>
          <kbd aria-label="Up">↑</kbd>
          <kbd aria-label="Down">↓</kbd> Move
        </span>
        <span>
          <kbd aria-label="Enter">
            <CornerDownLeft aria-hidden size={12} strokeWidth={1.5} />
          </kbd>{' '}
          Open
        </span>
        <span>
          <kbd aria-label="Escape">Esc</kbd> Close
        </span>
      </p>
    </Command.Dialog>
  );
}
