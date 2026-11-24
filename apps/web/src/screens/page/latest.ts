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
