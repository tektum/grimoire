/** The page screen's answer for a page that is not there (or that the person may not read): the same words whether it never existed or was removed while it was open. */
export function PageNotFound() {
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title">Page not found</h1>
      <p>This page does not exist, or you do not have access to it.</p>
    </section>
  );
}
