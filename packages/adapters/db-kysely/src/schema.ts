import type { Generated, Selectable } from 'kysely';

/**
 * Hand-written shape of the tables of migrations 0001 to 0004. `test/schema.int.test.ts` compares it with the migrated database:
 * a declared table or column that is missing, a different nullability, or a database column that is not declared fails the test.
 */
export interface PagesTable {
  id: Generated<string>;
  ydoc: Buffer | null;
  ydoc_size: number | null;
  state_epoch: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  markdown: string | null;
  text_content: string | null;
  markdown_hash: Buffer | null;
  last_edited_by: string | null;
  last_edited_at: Date | null;
  markdown_stale_since: Date | null;
  url_id: Generated<string>;
  collection_id: Generated<string>;
  parent_id: string | null;
  position: Generated<string>;
  title: Generated<string>;
  icon: string | null;
  created_by: Generated<string>;
  deleted_at: Date | null;
  deleted_by: string | null;
  deleted_batch: string | null;
}

export interface UsersTable {
  id: Generated<string>;
  descope_user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: Generated<'admin' | 'member' | 'viewer'>;
  suspended_at: Date | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupsTable {
  id: Generated<string>;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  created_at: Generated<Date>;
}

export interface CollectionsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  position: string;
  default_permission: 'read' | 'read_write' | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface CollectionAccessTable {
  id: Generated<string>;
  collection_id: string;
  user_id: string | null;
  group_id: string | null;
  permission: 'read' | 'read_write';
  created_at: Generated<Date>;
}

export interface GrimoireTables {
  pages: PagesTable;
  users: UsersTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  collections: CollectionsTable;
  collection_access: CollectionAccessTable;
}

type Nullability<T> = { [K in keyof Selectable<T>]-?: null extends Selectable<T>[K] ? 'nullable' : 'required' };

/**
 * The same declaration at run time, for the schema test. The compiler checks it against the interfaces above, so a column cannot be
 * added to one and forgotten in the other, and a column typed `| null` cannot be listed as required.
 */
export const declaredColumns = {
  pages: {
    id: 'required', ydoc: 'nullable', ydoc_size: 'nullable', state_epoch: 'required', created_at: 'required', updated_at: 'required',
    markdown: 'nullable', text_content: 'nullable', markdown_hash: 'nullable', last_edited_by: 'nullable', last_edited_at: 'nullable',
    markdown_stale_since: 'nullable', url_id: 'required', collection_id: 'required', parent_id: 'nullable', position: 'required',
    title: 'required', icon: 'nullable', created_by: 'required', deleted_at: 'nullable', deleted_by: 'nullable', deleted_batch: 'nullable',
  },
  users: {
    id: 'required', descope_user_id: 'required', email: 'required', name: 'required', avatar_url: 'nullable', role: 'required',
    suspended_at: 'nullable', last_seen_at: 'nullable', created_at: 'required', updated_at: 'required',
  },
  groups: { id: 'required', name: 'required', created_at: 'required', updated_at: 'required' },
  group_members: { group_id: 'required', user_id: 'required', created_at: 'required' },
  collections: {
    id: 'required', name: 'required', description: 'nullable', icon: 'nullable', color: 'nullable', position: 'required',
    default_permission: 'nullable', created_by: 'required', created_at: 'required', updated_at: 'required', deleted_at: 'nullable',
  },
  collection_access: {
    id: 'required', collection_id: 'required', user_id: 'nullable', group_id: 'nullable', permission: 'required', created_at: 'required',
  },
} as const satisfies { [T in keyof GrimoireTables]: Nullability<GrimoireTables[T]> };
