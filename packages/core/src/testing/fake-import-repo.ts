import type { ImportRecord, ImportRepo } from '../ports/import-repo.js';

/** In-memory imports for tests. */
export class FakeImportRepo implements ImportRepo {
  private readonly rows: ImportRecord[] = [];

  seed(row: ImportRecord): void {
    this.rows.push(row);
  }

  get(tenantId: string, id: string): Promise<ImportRecord | undefined> {
    return Promise.resolve(this.rows.find((r) => r.tenantId === tenantId && r.id === id));
  }
}
