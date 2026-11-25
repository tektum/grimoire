import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/context';
import { Snippet } from '../../search/Snippet';
import { QUERY_MAX, type SearchItem } from '../../search/types';
import { searchable, useSearchResults } from '../../search/useSearch';
import { pagePath } from '../../tree/model';
import { Button } from '../../ui/primitives';
import './search.css';

/** What a result says when only the beginning of the page is in the index (R9.7). */
export const PARTIAL_TEXT = 'Only the beginning of this page is searchable';

function Result({ item }: { item: SearchItem }) {
  return (
    <li className="search-result">
      <Link className="search-result-title" to={pagePath(item.title, item.urlId)}>
        {item.title === '' ? 'Untitled' : item.title}
      </Link>
      <p className="search-snippet">
        <Snippet snippet={item.snippet} />
      </p>
      {/* The passage that matched by meaning, as plain text (a text node, never markup), under the snippet; a result without one has no extra line. */}
      {item.matchedPassage === undefined ? null : <p className="search-passage">{item.matchedPassage.text}</p>}
      {item.partial === true ? <p className="search-partial">{PARTIAL_TEXT}</p> : null}
    </li>
  );
}

/** `/search?q=`: the results of a search, read a page at a time (R6.34). */
export default function SearchScreen() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  // The address is the truth (a link, the back button, "See all results" of the palette): the field follows it.
  useEffect(() => {
    setText(q);
  }, [q]);
  const search = useSearchResults(api, q);
  const items = search.data?.items ?? [];
  const wanted = searchable(q);

  return (
    <section aria-labelledby="screen-title" className="search-screen">
      <h1 id="screen-title">Search</h1>
      <form
        role="search"
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          setParams(text.trim() === '' ? {} : { q: text.trim() });
        }}
      >
        <label htmlFor="search-input">Search pages</label>
        <input
          id="search-input"
          type="search"
          value={text}
          maxLength={QUERY_MAX}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>
      {wanted === null ? (
        <p className="search-note">{q.trim().length > QUERY_MAX ? `Search takes at most ${String(QUERY_MAX)} characters.` : 'Type what to look for, and press Enter.'}</p>
      ) : search.isPending ? (
        <p className="search-note" role="status">
          Searching…
        </p>
      ) : search.isError && search.data === undefined ? (
        <p className="search-note" role="alert">
          Search is not available right now. <Button onClick={() => void search.refetch()}>Try again</Button>
        </p>
      ) : items.length === 0 ? (
        <p className="search-note" role="status">
          No results
        </p>
      ) : (
        <>
          <ul className="search-results" aria-label={`Results for ${wanted}`}>
            {items.map((item) => (
              <Result key={item.pageId} item={item} />
            ))}
          </ul>
          {search.isFetchNextPageError ? (
            <p className="search-note" role="alert">
              More results could not be loaded. <Button onClick={() => void search.fetchNextPage()}>Try again</Button>
            </p>
          ) : search.hasNextPage ? (
            <Button disabled={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>
              {search.isFetchingNextPage ? 'Loading…' : 'Show more results'}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
