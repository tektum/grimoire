import { isSafeHref } from '../../safety';

/**
 * Keeps an unsafe address from ever being a link in the page. Every link of the editor (live or read-only) goes through `isSafeHref`: one whose
 * address is not allowed (a `javascript:` or `data:` address in any spelling, whether it came from the saved text, from another person's edit or from
 * a change of the attribute) loses its `href`, so it is plain text that cannot be followed. What the allow-list accepts stays a link.
 */
export function guardLinks(root: HTMLElement): () => void {
  const check = (link: Element): void => {
    const href = link.getAttribute('href');
    if (href !== null && !isSafeHref(href)) {
      link.removeAttribute('href');
      link.setAttribute('data-unsafe-link', 'true');
    }
  };
  const sweep = (node: ParentNode): void => node.querySelectorAll('a[href]').forEach(check);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') check(record.target as Element);
      else
        record.addedNodes.forEach((added) => {
          if (added.nodeType !== 1) return;
          const element = added as Element;
          if (element.matches('a[href]')) check(element);
          sweep(element);
        });
    }
  });
  sweep(root);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
  return () => observer.disconnect();
}
