---
name: verify-claim
description: Use when you must check that work is really done, or check another agent's report. Reproduce, break the code on purpose to prove the test can fail, count from finished runs, and write findings before conclusions.
---

# Verify a claim

A report is a claim. Check the thing itself.

## Steps

1. **Start clean.** Use a fresh clone or a clean worktree of the exact commit: `git clone <url> <dir> && cd <dir> && git checkout <sha>`. Then `mise install` and `mise exec -- npm ci --ignore-scripts`. Uncommitted files hide breakage.
2. **Run the whole gate** and keep the output: lint, typecheck, build, unit tests, tool tests, both secret scans (`small-pull-request` lists them, and says how to get gitleaks).
3. **Count from the finished run.** Read the summary line (for example "29 passed"). Never count from memory or from a partial log. A run still going is not a result.
4. **Reproduce the claim.** Run the exact command or scenario the claim names. If it says "fails before, passes after", run both.
5. **Prove the test can fail.** Break the code on purpose (a mutation: flip a condition, remove a check). The test must go red for the right reason. Restore the code and confirm green. A test that cannot fail proves nothing.
6. **Check what the diff did not say.** Look at `git diff --stat origin/main...<sha>` for files outside the stated scope, and for new sleeps, allow-list entries or skipped tests.
7. **Use the real stack** when it exists (the Compose stack through `make`), not only fakes. Until then, say that you could not.

## Write findings first

Write the findings to a file as you go, before you form a conclusion. Put what you did NOT verify at the top. Then each finding with the command, the output line, and the verdict: confirmed, refuted, or not checked.

## Keep it small

Do at most a few heavy checks per pass. Split by resource (Docker checks apart from read-only checks) so a long brief is not abandoned halfway.
