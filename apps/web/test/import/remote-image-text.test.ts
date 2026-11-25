import { describe, expect, it } from 'vitest';
import { remoteImageText } from '../../src/screens/import/messages';

// What each reason code says, one by one, against what the engine and the fetcher mean by it (apps/server/src/import/remote-images/index.ts, engine.ts, attachments.ts). A sentence that names a case the
// code is never used for gives the person a false reason, so every code is pinned.
const one = (code: string, n = 1) => remoteImageText({ [code]: n });
const head = 'Pictures from the web that were not copied: ';

describe('the sentence for a reason a picture from the web was not copied', () => {
  it.each([
    ['blocked_address', 1, '1 was at an address this tool may not fetch from'],
    ['redirect', 2, '2 were redirected too many times, or in a circle'],
    ['too_large', 1, '1 was too large'],
    ['timeout', 3, '3 took too long to answer'],
    ['status', 1, '1 could not be fetched: the address did not return the picture'],
    ['type', 2, '2 were not a picture of a type that is accepted, or not the type their address said'],
    ['budget', 1, '1 was left out because the import had reached its limit for pictures from the web'],
    ['network', 4, '4 could not be reached'],
    ['scheme', 2, '2 were at an address this tool does not accept (only https on the standard port, with no password in it)'],
    ['not_fetched', 1, '1 was not fetched because fetching pictures from the web is switched off'],
    ['empty', 1, '1 was empty'],
    ['size_mismatch', 2, '2 could not be stored: a copy kept from an earlier attempt did not match'],
  ])('%s', (code, n, words) => {
    expect(one(code, n)).toBe(`${head}${words}.`);
  });

  it('has nothing to say for no failures, and drops what is not a reason code or a whole count', () => {
    expect(remoteImageText(undefined)).toBeNull();
    expect(remoteImageText({})).toBeNull();
    expect(remoteImageText({ 'http://10.0.0.1/x.png': 2, timeout: 0, network: -1, empty: 1.5 })).toBeNull();
  });
});
