/** What the end of one of several overlapping renames means for the page: only the latest to have begun decides the title (`applied`, or `refused` when the server said no); an older one, whatever its answer, is `superseded`. */
export const verdictOf = (isLatest: () => boolean, ok: boolean): 'applied' | 'refused' | 'superseded' => (!isLatest() ? 'superseded' : ok ? 'applied' : 'refused');
