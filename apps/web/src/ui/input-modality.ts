/**
 * Says how the person last reached for the page, on the root element (`data-input`): `keyboard` after a Tab, `pointer` after a press. A text field takes `:focus-visible`
 * whatever put the focus there, so the ring of the editor asks for this as well: it shows when the focus came by Tab, and a click keeps the plain look.
 */
export function trackInputModality(doc: Document = document): () => void {
  const set = (value: 'keyboard' | 'pointer'): void => {
    doc.documentElement.dataset['input'] = value;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') set('keyboard');
  };
  const onPointer = (): void => set('pointer');
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('mousedown', onPointer, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPointer, true);
    doc.removeEventListener('mousedown', onPointer, true);
    delete doc.documentElement.dataset['input'];
  };
}
