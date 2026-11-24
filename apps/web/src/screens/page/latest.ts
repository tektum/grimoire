/**
 * For calls that can overlap and whose results must not overwrite each other out of order: `begin()` starts one and gives back a function that says whether it is still the latest to have begun when its
 * result arrives. The latest to begin wins, whatever the order they finish in.
 */
export function latestOnly(): () => () => boolean {
  let count = 0;
  return () => {
    const mine = ++count;
    return () => mine === count;
  };
}

/** What the end of one of several overlapping renames means for the page: only the latest to have begun decides the title (`applied`, or `refused` when the server said no); an older one, whatever its answer, is `superseded`. */
export const verdictOf = (isLatest: () => boolean, ok: boolean): 'applied' | 'refused' | 'superseded' => (!isLatest() ? 'superseded' : ok ? 'applied' : 'refused');
