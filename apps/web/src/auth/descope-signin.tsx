import '@descope/web-component';
import { createElement, type ReactElement, useEffect, useRef } from 'react';
import { useScheme } from '../ui/scheme';

/**
 * The identity provider's sign-in flow as a custom element. Imported with `import()` only, by the sign-in screen: it loads scripts from the provider's
 * domains at run time (contracts section 4), which is why it lives in the separate sign-in document. The component keeps the session in local storage by
 * itself; on success the screen goes on to the return path.
 *
 * The element is made by hand and given its attributes before it joins the page: the component reads the scheme, the project and the flow once, when it connects,
 * and has `theme` as a read-only property, which a framework prop would try to write. The scheme is the one the page shows (the project's styles have a light and a
 * dark set), so a dark page never holds a light card; a change of scheme makes a new element.
 */
export default function DescopeSignIn({
  projectId,
  baseUrl,
  flowId = 'sign-up-or-in',
  onSuccess,
  onError,
}: {
  projectId: string;
  baseUrl?: string;
  flowId?: string;
  onSuccess: () => void;
  onError: () => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const theme = useScheme();
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const node = document.createElement('descope-wc');
    node.setAttribute('project-id', projectId);
    node.setAttribute('flow-id', flowId);
    node.setAttribute('theme', theme);
    if (baseUrl !== undefined) node.setAttribute('base-url', baseUrl);
    node.addEventListener('success', onSuccess);
    node.addEventListener('error', onError);
    parent.append(node);
    return () => {
      node.removeEventListener('success', onSuccess);
      node.removeEventListener('error', onError);
      node.remove();
    };
  }, [projectId, baseUrl, flowId, theme, onSuccess, onError]);
  return createElement('div', { ref: host });
}
