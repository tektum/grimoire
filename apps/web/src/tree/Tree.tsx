import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useContext } from 'react';
import { Link, useNavigate } from 'react-router';
import { type NodeRendererProps, Tree as Arborist } from 'react-arborist';
import { pagePath, type TreeItem } from './model';
import './tree.css';

/** Rows are drawn for the visible window only: the DOM holds a screenful, however many pages there are. */
export const TREE_HEIGHT = 560;
export const ROW_HEIGHT = 32;
const INDENT = 20;

/** The first level is open at the start (a page with children shows them); deeper levels start closed. */
const initialOpen = (items: readonly TreeItem[]): Record<string, boolean> => Object.fromEntries(items.filter((i) => i.children !== undefined).map((i) => [i.id, true]));

export interface TreeProps {
  readonly items: readonly TreeItem[];
  /** The `urlId` of the page being read, marked as the current page. */
  readonly currentUrlId?: string | undefined;
}

/** What every row needs besides its node, passed through a context so the row component is defined once (a new component type per render would remount every row). */
const CurrentPage = createContext<string | undefined>(undefined);

function Row({ node, style, dragHandle }: NodeRendererProps<TreeItem>) {
  const currentUrlId = useContext(CurrentPage);
  const item = node.data;
  return (
    <div ref={dragHandle} style={style} className="tree-row" data-focused={node.isFocused || undefined}>
      {node.isInternal ? (
        <button type="button" className="tree-toggle" aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${item.name}`} onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
          {node.isOpen ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
        </button>
      ) : (
        <span className="tree-toggle" aria-hidden />
      )}
      <Link to={pagePath(item.name, item.urlId)} className="tree-link" tabIndex={-1} {...(item.urlId === currentUrlId ? { 'aria-current': 'page' as const } : {})}>
        {item.icon !== null && <span aria-hidden className="tree-icon">{item.icon}</span>}
        {item.name}
      </Link>
    </div>
  );
}

export function Tree({ items, currentUrlId }: TreeProps) {
  const navigate = useNavigate();
  if (items.length === 0) return <p className="tree-empty">No pages yet</p>;
  return (
    <CurrentPage.Provider value={currentUrlId}>
      <Arborist<TreeItem>
        data={items as TreeItem[]}
        width="100%"
        height={TREE_HEIGHT}
        rowHeight={ROW_HEIGHT}
        indent={INDENT}
        rowClassName="tree-item"
        openByDefault={false}
        initialOpenState={initialOpen(items)}
        // Enter on the focused row opens its page: the links are not in the tab order (the tree is one stop; the arrow keys move inside it).
        onActivate={(node) => { if (node.isLeaf || node.isInternal) navigate(pagePath(node.data.name, node.data.urlId)); }}
        disableDrag
        disableDrop
        disableEdit
        disableMultiSelection
      >
        {Row}
      </Arborist>
    </CurrentPage.Provider>
  );
}
