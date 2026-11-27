import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type MoveHandler, type NodeApi, type NodeRendererProps, type TreeApi, Tree as Arborist } from 'react-arborist';
import { focusWhenReady } from '../ui/focus';
import { Button, Confirm, Modal, notify } from '../ui/primitives';
import { RowMenu } from './RowMenu';
import type { TreeActions } from './actions';
import { dropPage } from './drop';
import { type FlatPage, pagePath, type TreeItem } from './model';
import { moveTargets } from './moves';
import './tree.css';

/** Rows are drawn for the visible window only: the DOM holds a screenful, however many pages there are. */
export const TREE_HEIGHT = 560;
export const ROW_HEIGHT = 28;
/** Under a coarse pointer every target is 44px, so a row is too. */
export const ROW_HEIGHT_COARSE = 44;
const rowHeight = (): number => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches ? ROW_HEIGHT_COARSE : ROW_HEIGHT);
const INDENT = 20;

/** The first level is open at the start (a page with children shows them); deeper levels start closed. */
const initialOpen = (items: readonly TreeItem[]): Record<string, boolean> => Object.fromEntries(items.filter((i) => i.children !== undefined).map((i) => [i.id, true]));

/** What a person may do to the pages: the changes, and the flat list they are planned against. Absent in a collection the caller can only read (no menu, no drag, no rename). */
export interface Editing {
  readonly actions: TreeActions;
  readonly pages: readonly FlatPage[];
}

export interface TreeProps {
  readonly items: readonly TreeItem[];
  readonly editing?: Editing | undefined;
  /** The `urlId` of the page being read, marked as the current page. */
  readonly currentUrlId?: string | undefined;
}

/** What every row needs besides its node, passed through a context so the row component is defined once (a new component type per render would remount every row). */
interface RowContext {
  readonly currentUrlId: string | undefined;
  readonly actions: TreeActions | undefined;
  readonly askMove: (item: TreeItem) => void;
  readonly askDelete: (item: TreeItem) => void;
  readonly open: (id: string) => void;
}
const Rows = createContext<RowContext>({ currentUrlId: undefined, actions: undefined, askMove: () => undefined, askDelete: () => undefined, open: () => undefined });

function RenameInput({ node }: { node: NodeApi<TreeItem> }) {
  return (
    <input
      className="tree-rename"
      aria-label={`New title for ${node.data.name}`}
      defaultValue={node.data.title}
      maxLength={255}
      ref={focusWhenReady}
      onFocus={(e) => { e.currentTarget.select(); }}
      onBlur={() => { node.reset(); }}
      onKeyDown={(e) => {
        e.stopPropagation(); // Enter here saves the title; it is not the tree's Enter, which opens the page
        if (e.key === 'Escape') node.reset();
        if (e.key === 'Enter') {
          const title = e.currentTarget.value.trim();
          if (title === '') node.reset();
          else node.submit(title);
        }
      }}
    />
  );
}

function Row({ node, style, dragHandle }: NodeRendererProps<TreeItem>) {
  const { currentUrlId, actions, askMove, askDelete, open } = useContext(Rows);
  const item = node.data;
  return (
    <div ref={dragHandle} style={style} className="tree-row" data-focused={node.isFocused || undefined}>
      {node.isInternal ? (
        <button type="button" className="tree-toggle" tabIndex={node.isFocused ? 0 : -1} aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${item.name}`} onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
          {node.isOpen ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
        </button>
      ) : (
        <span className="tree-toggle" aria-hidden />
      )}
      {node.isEditing ? (
        <RenameInput node={node} />
      ) : (
        <Link to={pagePath(item.title, item.urlId)} className="tree-link" title={item.name} tabIndex={-1} onClick={(e) => { e.stopPropagation(); }} {...(item.urlId === currentUrlId ? { 'aria-current': 'page' as const } : {})}>
          {item.icon !== null && <span aria-hidden className="tree-icon">{item.icon}</span>}
          {item.name}
        </Link>
      )}
      {actions !== undefined && !node.isEditing && (
        // A click in the menu (its button and, through the portal, its items) must not reach the row: a click on a row opens its page.
        <span onClick={(e) => { e.stopPropagation(); }}>
          <RowMenu
            tabIndex={node.isFocused ? 0 : -1}
            label={`Actions for ${item.name}`}
            items={[
              { label: 'Rename', onSelect: () => { void node.edit(); } },
              { label: 'New page inside', onSelect: () => { open(item.id); void actions.create(item.id); } },
              { label: 'Move to…', onSelect: () => { askMove(item); } },
              { label: 'Delete', onSelect: () => { askDelete(item); } },
            ]}
          />
        </span>
      )}
    </div>
  );
}

export function Tree({ items, editing, currentUrlId }: TreeProps) {
  const navigate = useNavigate();
  const tree = useRef<TreeApi<TreeItem> | undefined>(undefined);
  const [moving, setMoving] = useState<TreeItem | null>(null);
  const [deleting, setDeleting] = useState<TreeItem | null>(null);
  const actions = editing?.actions;
  // The page that is open is shown: the branches above it are opened, once for each page that is opened (not again on every read of the tree, which would undo
  // a branch the person has closed).
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (currentUrlId === undefined) {
      revealed.current = undefined; // no page is open: the next one opened is shown again
      return;
    }
    if (revealed.current === currentUrlId) return;
    const find = (list: readonly TreeItem[]): TreeItem | undefined => {
      for (const item of list) {
        if (item.urlId === currentUrlId) return item;
        const inside = item.children === undefined ? undefined : find(item.children);
        if (inside !== undefined) return inside;
      }
      return undefined;
    };
    const item = find(items);
    if (item === undefined) return; // not in the list (yet): try again when the list changes
    tree.current?.openParents(item.id);
    revealed.current = currentUrlId;
  }, [currentUrlId, items]);
  const context = useMemo<RowContext>(() => ({ currentUrlId, actions, askMove: setMoving, askDelete: setDeleting, open: (id) => { tree.current?.open(id); } }), [currentUrlId, actions]);
  if (items.length === 0) return <p className="tree-empty">No pages yet</p>;

  const onMove: MoveHandler<TreeItem> = ({ dragIds, parentId, index }) => {
    const dragId = dragIds[0];
    if (editing !== undefined && dragId !== undefined) dropPage(editing.pages, editing.actions, notify, { dragId, parentId, index });
  };

  return (
    <Rows.Provider value={context}>
      {/* Enter on a focused row opens its page. The tree itself uses Enter only to rename, which is off here, and Space opens a leaf and toggles a branch; a button inside the row keeps its own Enter. */}
      <div
        // Tab walks the tab order as the page has it: arborist's own Tab handling would skip the buttons of the row.
        onKeyDownCapture={(e) => { if (e.key === 'Tab') e.stopPropagation(); }}
        onKeyDown={(e) => {
          const node = tree.current?.focusedNode;
          if (e.key !== 'Enter' || node === null || node === undefined || (e.target as HTMLElement).getAttribute('role') !== 'treeitem') return;
          e.preventDefault();
          navigate(pagePath(node.data.title, node.data.urlId));
        }}
      >
      <Arborist<TreeItem>
        ref={tree}
        data={items as TreeItem[]}
        width="100%"
        height={TREE_HEIGHT}
        rowHeight={rowHeight()}
        indent={INDENT}
        className="tree"
        rowClassName="tree-item"
        openByDefault={false}
        initialOpenState={initialOpen(items)}
        // Enter on the focused row opens its page: the links are not in the tab order (the tree is one stop; the arrow keys move inside it).
        onActivate={(node) => { navigate(pagePath(node.data.title, node.data.urlId)); }}
        disableDrag={editing === undefined}
        disableDrop={editing === undefined}
        disableEdit // arborist's own Enter would start a rename; the menu starts it (node.edit), Enter opens the page
        disableMultiSelection
        onMove={onMove}
        onRename={({ id, name }) => { void actions?.rename(id, name); }}
      >
        {Row}
      </Arborist>
      </div>
      {moving !== null && editing !== undefined && (
        <Modal title={`Move ${moving.name} to…`} open onOpenChange={(open) => { if (!open) setMoving(null); }}>
          <ul className="tree-targets">
            {moveTargets(editing.pages, moving.id).map((target) => (
              <li key={target.parentId ?? 'top'} style={{ paddingInlineStart: `${String(target.depth * 16)}px` }}>
                <Button
                  onClick={() => {
                    const id = moving.id;
                    setMoving(null);
                    if (target.parentId !== null) tree.current?.open(target.parentId); // the page shows where it went
                    void editing.actions.move(id, { parentId: target.parentId, afterId: null, beforeId: null });
                  }}
                >
                  {target.label}
                </Button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {deleting !== null && editing !== undefined && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          description="The page and the pages inside it go to the trash. You can restore them from there."
          confirmLabel="Delete"
          open
          onOpenChange={(open) => { if (!open) setDeleting(null); }}
          onConfirm={() => { const id = deleting.id; setDeleting(null); void editing.actions.remove(id); }}
        />
      )}
    </Rows.Provider>
  );
}
