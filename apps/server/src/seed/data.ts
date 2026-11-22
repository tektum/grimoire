// Fixed development data (contracts section 4). Ids are fixed so that a second run finds its rows and inserts nothing.
export const ALICE = '00000000-0000-4000-8000-0000000000a1';
export const BOB = '00000000-0000-4000-8000-0000000000b1';
export const CAROL = '00000000-0000-4000-8000-0000000000c1';
export const DEV = '00000000-0000-4000-8000-0000000000d1';
export const PRIVATE = '00000000-0000-4000-8000-0000000000d2';
export const BOB_PRIVATE_ACCESS = '00000000-0000-4000-8000-0000000000f1';
export const WELCOME = '00000000-0000-4000-8000-0000000000e1';
export const NESTED = '00000000-0000-4000-8000-0000000000e2';

export const SEED_USERS = [
  { id: ALICE, name: 'alice', role: 'admin' },
  { id: BOB, name: 'bob', role: 'member' },
  { id: CAROL, name: 'carol', role: 'viewer' },
] as const;

export const SEED_COLLECTIONS = [
  { id: DEV, name: 'Dev', position: 'a0', defaultPermission: 'read_write' },
  { id: PRIVATE, name: 'Private', position: 'a1', defaultPermission: null },
] as const;

export const SEED_PAGES = [
  { id: WELCOME, parentId: null, position: 'a0', title: 'Welcome', markdown: '# Welcome\n\nThis is the seeded development page.\n' },
  { id: NESTED, parentId: WELCOME, position: 'a0', title: 'Nested', markdown: '# Nested\n\nA page below Welcome.\n' },
] as const;
