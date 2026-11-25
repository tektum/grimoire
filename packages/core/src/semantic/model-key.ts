import type { EmbedderModel } from '../ports/embedder.js';

/**
 * The `model` column of the stored chunks and of the embedding state: the model's name and its version, for example `multilingual-e5-base-int8@3fa9c0d1` (the version is the start of the SHA-256
 * of the weights). The jobs that embed pages and the search that reads them build it here and nowhere else, so that new weights re-embed every page and the search never reads another model's vectors.
 */
export const modelKey = (model: Pick<EmbedderModel, 'name' | 'version'>): string => `${model.name}-${model.version}`;
