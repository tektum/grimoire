import { Link } from 'react-router';

/**
 * Shown for an address that leads nowhere, and for a page or collection the person cannot read: one text for both, so it does not tell which it was
 * (the API answers both with 404, R11.15).
 */
export default function NotFoundScreen() {
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title">Page not found</h1>
      <p>This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <p>
        <Link to="/">Go to your collections</Link>
      </p>
    </section>
  );
}
