# Runbook: database failover

> **Page the on-call first.** Do not start before someone else is watching the dashboards.

## Before you begin

* You have `kubectl` access to the `prod` cluster.
* The replica lag is under 5 seconds:

  ```sql
  SELECT now() - pg_last_xact_replay_timestamp() AS lag;
  ```

## Steps

1. Stop writes:

   ```sh
   kubectl -n app scale deploy/api --replicas=0
   ```

2. Promote the replica:
   * connect to the replica host
   * run:

     ```sh
     pg_ctl promote -D "$PGDATA"
     ```

   * check `pg_is_in_recovery()` returns `f`
3. Point the service at the new primary:

   ```yaml
   database:
     host: db-2.internal
     port: 5432
   ```

4. Start writes again and watch the error rate.

## Rollback

If the error rate is above 1% after ten minutes:

1. scale the API to zero
2. repeat the steps with the hosts swapped

---

*Last reviewed 2026-10-02 by the platform team.*
