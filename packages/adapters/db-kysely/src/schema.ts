import type { Generated, Selectable } from 'kysely';

/**
 * Hand-written shape of the tables of migrations 0001 to 0009. `test/schema.int.test.ts` compares it with the migrated database:
 * a declared table or column that is missing, a different nullability, or a database column that is not declared fails the test.
 */
export interface PagesTable {
  tenant_id: Generated<string>;
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
  tsv: Generated<string>;
  search_partial: Generated<boolean>;
}

/** The workspaces (docs/tenancy.md): the provider's tenant id, its name, and the domain it admits. */
export interface TenantsTable {
  id: string;
  name: string;
  domain: string | null;
  created_at: Generated<Date>;
}

export interface UsersTable {
  tenant_id: Generated<string>;
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
  tenant_id: Generated<string>;
  id: Generated<string>;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupMembersTable {
  tenant_id: Generated<string>;
  group_id: string;
  user_id: string;
  created_at: Generated<Date>;
}

export interface CollectionsTable {
  tenant_id: Generated<string>;
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
  tenant_id: Generated<string>;
  id: Generated<string>;
  collection_id: string;
  user_id: string | null;
  group_id: string | null;
  permission: 'read' | 'read_write';
  created_at: Generated<Date>;
}

export interface RevisionsTable {
  tenant_id: Generated<string>;
  id: Generated<string>;
  page_id: string;
  title: string;
  markdown: string;
  markdown_hash: Buffer;
  author_ids: Generated<string[]>;
  last_author_id: string | null;
  reason: 'idle' | 'last_editor_left' | 'before_restore' | 'manual' | 'import';
  created_at: Date;
}

export interface AttachmentsTable {
  tenant_id: Generated<string>;
  id: Generated<string>;
  page_id: string;
  uploader_id: string | null;
  file_name: string;
  content_type: string;
  size: string;
  s3_key: string;
  status: 'pending' | 'ready';
  expires_at: Date | null;
  created_at: Generated<Date>;
  ready_at: Date | null;
  deleted_at: Date | null;
}

export interface ImportsTable {
  tenant_id: Generated<string>;
  id: Generated<string>;
  created_by: string | null;
  target_collection_id: string;
  source: 'notion_md_csv' | 'markdown_zip';
  status: Generated<'created' | 'uploaded' | 'running' | 'done' | 'failed' | 'cancelled'>;
  s3_key: string | null;
  bytes: string | null;
  counts: unknown;
  error: string | null;
  created_at: Generated<Date>;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ImportItemsTable {
  tenant_id: Generated<string>;
  id: Generated<string>;
  import_id: string;
  path: string;
  kind: 'page' | 'attachment' | 'database_csv' | 'other';
  page_id: string | null;
  url_id: string | null;
  status: Generated<'pending' | 'ok' | 'skipped' | 'failed'>;
  message: string | null;
  markdown_bytes: number | null;
  state_bytes: number | null;
  attempts: Generated<number>;
  detail: unknown;
}

export interface AuditEventsTable {
  tenant_id: Generated<string>;
  id: Generated<string>;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  created_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  tenant_id: Generated<string>;
  user_id: string;
  key: string;
  request_hash: Buffer;
  status: number | null;
  response: unknown;
  created_at: Generated<Date>;
}

export interface GrimoireTables {
  tenants: TenantsTable;
  pages: PagesTable;
  users: UsersTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  collections: CollectionsTable;
  collection_access: CollectionAccessTable;
  revisions: RevisionsTable;
  attachments: AttachmentsTable;
  imports: ImportsTable;
  import_items: ImportItemsTable;
  audit_events: AuditEventsTable;
  idempotency_keys: IdempotencyKeysTable;
}

type Nullability<T> = { [K in keyof Selectable<T>]-?: null extends Selectable<T>[K] ? 'nullable' : 'required' };

/**
 * The same declaration at run time, for the schema test. The compiler checks it against the interfaces above, so a column cannot be
 * added to one and forgotten in the other, and a column typed `| null` cannot be listed as required.
 */
export const declaredColumns = {
  tenants: { id: 'required', name: 'required', domain: 'nullable', created_at: 'required' },
  pages: { tenant_id: 'required',
    id: 'required', ydoc: 'nullable', ydoc_size: 'nullable', state_epoch: 'required', created_at: 'required', updated_at: 'required',
    markdown: 'nullable', text_content: 'nullable', markdown_hash: 'nullable', last_edited_by: 'nullable', last_edited_at: 'nullable',
    markdown_stale_since: 'nullable', url_id: 'required', collection_id: 'required', parent_id: 'nullable', position: 'required',
    title: 'required', icon: 'nullable', created_by: 'required', deleted_at: 'nullable', deleted_by: 'nullable', deleted_batch: 'nullable',
    tsv: 'required', search_partial: 'required',
  },
  users: { tenant_id: 'required',
    id: 'required', descope_user_id: 'required', email: 'required', name: 'required', avatar_url: 'nullable', role: 'required',
    suspended_at: 'nullable', last_seen_at: 'nullable', created_at: 'required', updated_at: 'required',
  },
  groups: { tenant_id: 'required', id: 'required', name: 'required', created_at: 'required', updated_at: 'required' },
  group_members: { tenant_id: 'required', group_id: 'required', user_id: 'required', created_at: 'required' },
  collections: { tenant_id: 'required',
    id: 'required', name: 'required', description: 'nullable', icon: 'nullable', color: 'nullable', position: 'required',
    default_permission: 'nullable', created_by: 'required', created_at: 'required', updated_at: 'required', deleted_at: 'nullable',
  },
  collection_access: { tenant_id: 'required',
    id: 'required', collection_id: 'required', user_id: 'nullable', group_id: 'nullable', permission: 'required', created_at: 'required',
  },
  revisions: { tenant_id: 'required',
    id: 'required', page_id: 'required', title: 'required', markdown: 'required', markdown_hash: 'required', author_ids: 'required',
    last_author_id: 'nullable', reason: 'required', created_at: 'required',
  },
  attachments: { tenant_id: 'required',
    id: 'required', page_id: 'required', uploader_id: 'nullable', file_name: 'required', content_type: 'required', size: 'required',
    s3_key: 'required', status: 'required', expires_at: 'nullable', created_at: 'required', ready_at: 'nullable', deleted_at: 'nullable',
  },
  imports: { tenant_id: 'required',
    id: 'required', created_by: 'nullable', target_collection_id: 'required', source: 'required', status: 'required', s3_key: 'nullable',
    bytes: 'nullable', counts: 'nullable', error: 'nullable', created_at: 'required', started_at: 'nullable', finished_at: 'nullable',
  },
  import_items: { tenant_id: 'required',
    id: 'required', import_id: 'required', path: 'required', kind: 'required', page_id: 'nullable', url_id: 'nullable', status: 'required',
    message: 'nullable', markdown_bytes: 'nullable', state_bytes: 'nullable', attempts: 'required', detail: 'nullable',
  },
  audit_events: { tenant_id: 'required',
    id: 'required', actor_id: 'nullable', action: 'required', target_type: 'nullable', target_id: 'nullable', detail: 'nullable',
    created_at: 'required',
  },
  idempotency_keys: { tenant_id: 'required',
    user_id: 'required', key: 'required', request_hash: 'required', status: 'nullable', response: 'nullable', created_at: 'required',
  },
} as const satisfies { [T in keyof GrimoireTables]: Nullability<GrimoireTables[T]> };
