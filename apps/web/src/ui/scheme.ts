import { useSyncExternalStore } from 'react';

export type Scheme = 'light' | 'dark';

/** The scheme the tokens are showing: `data-theme` on the page when it says one, else the system's (the same order as `tokens.css`). */
function currentScheme(): Scheme {
  const set = document.documentElement.dataset['theme'];
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribeToScheme(notify: () => void): () => void {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  system.addEventListener('change', notify);
  const attribute = new MutationObserver(notify);
  attribute.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    system.removeEventListener('change', notify);
    attribute.disconnect();
  };
}

/** The scheme the page is showing, kept up to date: a hook for whatever draws itself with the tokens' scheme in mind (the notices, the sign-in flow). */
export const useScheme = (): Scheme => useSyncExternalStore(subscribeToScheme, currentScheme);
