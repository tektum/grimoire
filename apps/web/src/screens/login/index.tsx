import { useEffect } from 'react';

/** The sign-in screen is its own document (`login.html`, so the third-party scripts of the provider never load in the app); the route sends the browser there. */
export default function Screen() {
  useEffect(() => {
    window.location.replace(`login.html${window.location.search}`);
  }, []);
  return <p>Opening the sign-in page</p>;
}
