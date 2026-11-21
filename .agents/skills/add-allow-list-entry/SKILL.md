---
name: add-allow-list-entry
description: Use when a Grimoire check blocks you and the finding is a false positive or a justified exception - the test sleep check or the gitleaks secret scan. Add one narrow entry with a reason. Never a blanket entry.
---

# Add an allow-list entry

First try to remove the cause. An entry is the last resort.

## Test sleep check (`tools/ci/test-sleep-allow.json`)

Prefer waiting for a condition (`vi.waitFor`, a polling helper). If a fixed delay is truly needed (for example, proving that nothing happens in a short window), add one object to the JSON array:

```json
{
  "file": "packages/example/test/thing.test.ts",
  "line": "await new Promise((r) => setTimeout(r, 300));",
  "reason": "Proves no event arrives in the window; there is nothing to wait for."
}
```

- `file` is the path from the repository root. `line` is the exact line text (surrounding whitespace is ignored). `reason` is not empty.
- One entry per line. Never a whole file or a pattern.
- The check scans test files under `apps/` and `packages/` only. An entry is needed for a fixed sleep above 250 ms, for every `setInterval`, and for a delay that is not a number literal (a plain number or a product of literals is read as a number). An entry that matches no reported line is stale and fails the check, so do not add one for anything else.
- Stale entries (file gone, line no longer a sleep) fail the check, so remove an entry when you remove the sleep.
- Check: `node tools/ci/check-test-sleeps.mjs`, then `bun run test:tools`.

## Secret scan (`.gitleaks.toml`)

First confirm the match is not a real secret. If it might be real, stop: treat it as a leak and ask. Rotating a leaked secret is not something you do alone.

For a fake value in a test fixture, add an allowlist scoped by rule AND path, with a comment saying why. Pattern (see the gitleaks documentation for the full syntax):

```toml
[[allowlists]]
description = "Fake token in the auth test fixture; not a real credential."
condition = "AND"
targetRules = ["generic-api-key"]
paths = ['''packages/example/test/fixtures/token\.txt''']
```

- Name the rule (the id printed in the finding) and the narrowest path.
- Never allow a whole directory for all rules, and never allow a real value.
- Run both scans: `gitleaks git --config .gitleaks.toml --redact .` and `gitleaks dir --config .gitleaks.toml --redact .`.
- A security allow-list entry is a security decision: say so in the pull request, and expect a reviewer to check it.
