import { markdownProfile } from '../markdown-profile.js';
import type { ImportProfile } from '../profile.js';
import { resolveNotionLink } from './links.js';
import { titleOf } from './names.js';

/** A path without `.` and empty segments, as the engine and `resolveLinkPath` read it. */
const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment !== '' && segment !== '.');

/**
 * The `notion_md_csv` profile (M7 contracts section 4, Notion rules; M7-T06): an export of Notion, read with the rules of `notion/`. Every rule is marked `constructed: [F§6]` until
 * M7-T08 confirms it against a real export.
 */
export const notionProfile: ImportProfile = {
  source: 'notion_md_csv',
  classify: markdownProfile.classify,
  titleOf,
  /** A page goes under the folder it sits in; which page stands for that folder is `folderPathOf`'s answer. */
  parentPathOf(path) {
    const folder = segmentsOf(path).slice(0, -1);
    return folder.length === 0 ? null : folder.join('/');
  },
  /** constructed: [F§6] a page `X <id>.md` stands for the folder `X <id>/` beside it: the pages in that folder are its children. */
  folderPathOf: (path) => segmentsOf(path).join('/').replace(/\.(md|markdown)$/i, ''),
  preprocess: markdownProfile.preprocess,
  resolveLink: resolveNotionLink,
};
