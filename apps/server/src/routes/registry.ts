import me from './me.js';
import config from './config.js';
import collections from './collections.js';
import collectionAccess from './collection-access.js';
import pages from './pages.js';
import pagesMarkdown from './pages-markdown.js';
import trash from './trash.js';
import revisions from './revisions.js';
import users from './users.js';
import groups from './groups.js';
import resetState from './reset-state.js';
import attachments from './attachments.js';
import search from './search.js';
import imports from './imports.js';

/** Every router of the product, created once, in this order. A task fills its own router file and never edits this list. */
export const routers = [me, config, collections, collectionAccess, pages, pagesMarkdown, trash, revisions, users, groups, resetState, attachments, search, imports] as const;
