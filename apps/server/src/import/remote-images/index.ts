import type { Config } from '@tektum/grimoire-core/ports/config';

/** What copies a remote image into the file store during an import (Q28 = C). Filled by M7-T09. */
export interface RemoteImageFetcher {
  fetch(url: string): Promise<never>;
}

/** None until M7-T09: the importer then leaves remote images as links. */
export function createRemoteImageFetcher(config: Config): RemoteImageFetcher | undefined {
  void config;
  return undefined;
}
