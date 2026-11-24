import '@descope/web-component';
import { createElement, type ReactElement, useEffect, useRef } from 'react';

/**
 * The identity provider's sign-in flow as a custom element. Imported with `import()` only, by the sign-in screen: it loads scripts from the provider's
 * domains at run time (contracts section 4), which is why it lives in the separate sign-in document. The component keeps the session in local storage by
 * itself; on success the screen goes on to the return path.
 */
export default function DescopeSignIn({ projectId, flowId = 'sign-up-or-in', onSuccess, onError }: { projectId: string; flowId?: string; onSuccess: () => void; onError: () => void }): ReactElement {
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    node.addEventListener('success', onSuccess);
    node.addEventListener('error', onError);
    return () => {
      node.removeEventListener('success', onSuccess);
      node.removeEventListener('error', onError);
    };
  }, [onSuccess, onError]);
  return createElement('descope-wc', { ref: element, 'project-id': projectId, 'flow-id': flowId });
}
