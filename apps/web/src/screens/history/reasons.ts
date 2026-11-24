/** Why a version was kept, in words (R9.1 to R9.3). */
export const REASONS: Readonly<Record<string, string>> = {
  idle: 'Saved after editing stopped',
  last_editor_left: 'The last editor left',
  before_restore: 'Kept before a restore',
  manual: 'Saved by a person',
  import: 'Imported',
};
export const reasonText = (reason: string): string => REASONS[reason] ?? 'Saved';
