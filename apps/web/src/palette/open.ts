const OPEN_PALETTE = 'grimoire:open-palette';

/** Opens the command palette from a button (the same as its key). The palette listens for it while there is a session. */
export const openPalette = (): void => { window.dispatchEvent(new Event(OPEN_PALETTE)); };

/** The palette's side: calls `open` whenever {@link openPalette} is called, until the returned function is called. */
export function onOpenPalette(open: () => void): () => void {
  window.addEventListener(OPEN_PALETTE, open);
  return () => { window.removeEventListener(OPEN_PALETTE, open); };
}

/** The palette's key as it is written on this machine: Cmd K on a Mac or an iPad, Ctrl K elsewhere. */
export const shortcutHint = (platform: string = navigator.platform): string => (/Mac|iPhone|iPad/.test(platform) ? 'Cmd K' : 'Ctrl K');
