-- Local development only. Run once by the database image's init step (after 02-extensions.sql), as the container superuser, against database grimoire.
-- pgvector (R2.46): the semantic search stores page embeddings in `vector` columns. grimoire_migrator has only CONNECT and cannot create extensions, and `vector` is not a trusted
-- extension; on a managed database install it there with a role that may create extensions before the first `grimoire migrate`.
CREATE EXTENSION IF NOT EXISTS vector;
