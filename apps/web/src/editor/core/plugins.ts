import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { listener } from '@milkdown/plugin-listener';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { rawHtmlPlugin } from '../../safety/raw-html';
import { codeLanguage } from '../code';
import { blockHandle, selectionBubble, slashMenu, trailingNode } from '../menus';
import { tableToolbar } from '../tables';

/**
 * The editor plugins the screen adds on top of the shared schema plugins. An allow-list: anything not named here
 * (history, a bundled preset, local persistence) is never added, because undo comes from the collaboration plugin
 * and the server is the only store.
 */
export const uiPlugins: MilkdownPlugin[] = [listener, clipboard, ...cursor, rawHtmlPlugin, tableToolbar, codeLanguage, slashMenu, selectionBubble, blockHandle, trailingNode].flat();
