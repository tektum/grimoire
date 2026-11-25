-- Local development only. Run once by the database image's init step (after 02-extensions.sql), as the container superuser, against database grimoire.
-- pgvector (R2.46): the semantic search stores page embeddings in `vector` columns. grimoire_migrator has only CONNECT and cannot create extensions, and `vector` is not a trusted
-- extension; on a managed database install it there with a role that may create extensions before the first `grimoire migrate`.
CREATE EXTENSION IF NOT EXISTS vector;
-- Every database made later from template1 gets it too: the integration tests create a database for each file and migrate it, and the embedding migration (0011) needs the
-- extension, which the migration role cannot create. On a managed service `grimoire db-setup` makes it in the one database instead.
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
