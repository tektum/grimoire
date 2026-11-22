import type * as Y from 'yjs';

/** The parts of a ProseMirror node, transaction and view that the scenarios use. */
export interface PmNode { readonly isTextblock: boolean; readonly textContent: string; readonly type: { readonly name: string }; readonly content: { readonly size: number } }
export interface PmTransaction {
  insertText(text: string, from: number): PmTransaction;
  delete(from: number, to: number): PmTransaction;
  split(pos: number): PmTransaction;
}
export interface PmView {
  readonly state: { readonly tr: PmTransaction; readonly doc: { descendants(visit: (node: PmNode, pos: number) => boolean | undefined): void } };
  dispatch(tr: PmTransaction): void;
}
export interface ReferenceEditor { view(): PmView; markdown(): string; destroy(): unknown }
export function installDom(): object;
export function createReferenceEditor(ydoc: Y.Doc): Promise<ReferenceEditor>;
