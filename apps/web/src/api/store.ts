/**
 * `fetch` for the one request to the file store: the browser PUTs an upload straight to the address the server signed, with exactly the headers it returned, no bearer token
 * and no cookies (the caller says so). It is not a call to the API, so it does not go through the API client; it lives here so that network calls stay in this folder.
 */
export const storeFetch: typeof fetch = (input, init) => fetch(input, init);
