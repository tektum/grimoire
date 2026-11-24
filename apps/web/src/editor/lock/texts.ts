/** What a person sees when another person's cursor is in the block they tried to convert: the name is the directory's. */
export const lockMessage = (name: string): string => `${name} is editing this block`;

/** R3.15, as the "Why?" action and the help page say it. */
export const SOFT_LOCK_HELP = 'The soft lock protects only connected people. Two people editing offline, or a sub-second race between connected clients, can still lose typing.';

/** The first-version limit text (R3.26 and R3.27), exactly as the contracts give it. */
export const LIMIT_TEXT =
  "Two people changing the structure of the same paragraph at the same moment (splitting it, joining it with the one above, or turning it into a list) can still lose or repeat a few words, because one person's change reaches the other after a short delay. If you worked offline and the document was restructured meanwhile, keep a separate copy of your edits before reconnecting. Separately, if two people type several letters at exactly the same spot at the same moment, their letters can end up mixed together; nothing is lost, but the words may need retyping, and seeing the other person's cursor on the same spot is the sign to wait. The structure lock and the automatic copy offer are planned after the first version.";
