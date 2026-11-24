/** What a person sees when another person's cursor is in the block they tried to convert: the name is the directory's. */
export const lockMessage = (name: string): string => `${name} is editing this block`;

/** R3.15 in plain words (the requirement has no mandated text): what the lock does and where it stops. The limit text below is mandated and word for word. */
export const SOFT_LOCK_HELP =
  "While someone else's cursor is in a block, turning that block into a list, a quote or a code block waits until they leave it, so that what they are typing is not lost. This works only while you are both connected: if you edit offline, or two people act within a fraction of a second, text can still be lost.";

/** The first-version limit text (R3.26 and R3.27), exactly as the contracts give it. */
export const LIMIT_TEXT =
  "Two people changing the structure of the same paragraph at the same moment (splitting it, joining it with the one above, or turning it into a list) can still lose or repeat a few words, because one person's change reaches the other after a short delay. If you worked offline and the document was restructured meanwhile, keep a separate copy of your edits before reconnecting. Separately, if two people type several letters at exactly the same spot at the same moment, their letters can end up mixed together; nothing is lost, but the words may need retyping, and seeing the other person's cursor on the same spot is the sign to wait. Holding back Enter, Backspace and list changes while someone else is in the paragraph, and offering to keep a copy automatically, are planned after the first version.";
