---
name: small-pull-request
description: Use when you cut, check, push and open a pull request for Grimoire, including a stacked pull request, or when you rebase a branch after its base was squash-merged. Covers the local gate, the body, auto-merge and the rebase.
---

# Small pull request

One concern per pull request. If the diff needs two titles, split it.

## Cut

1. `git fetch origin && git switch -c <type>/<short-name> origin/main`
2. Make the change. Tests first.
3. Commit with a Conventional Commit message (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Check locally (all must exit 0)

```bash
mise exec -- npm run lint
mise exec -- npm run typecheck
mise exec -- npm run build
mise exec -- npm test
mise exec -- npm run test:tools
mise exec -- gitleaks git --config .gitleaks.toml --redact .
mise exec -- gitleaks dir --config .gitleaks.toml --redact .
```

`gitleaks` is not in `mise.toml` yet (CI installs its own copy). Until it is, install it through mise in your own set-up, for example `mise use -g gitleaks`; this is the one tool allowed outside the project file, and only until the file lists it. If you touched `.github/workflows`, also run `actionlint` and `zizmor` (both from `mise.toml` once listed there; otherwise ask).

Check the added lines before pushing: `git diff origin/main...HEAD`. Look for local paths, private names, other products' names and secrets. Check that every relative link in changed Markdown resolves.

## Push and open

```bash
git push -u origin HEAD
timeout 60 gh pr create --base main --title "<type>: <summary>" --body-file body.md
timeout 60 gh pr merge --auto --squash
```

The body uses the repository template: What changed, Why, How it was verified, Visuals, Checklist. Put what you did NOT verify first under "How it was verified". For images, see the `pull-request-visuals` skill.

Auto-merge waits for `CI Required`, one approval and resolved threads. Keep CI green and answer review comments (`answer-review` skill).

## Stacked pull requests

Use a stack only when the second change needs the first.

1. Branch the second from the first: `git switch -c <second> <first>`.
2. Open it with `--base <first>`, not `main`.
3. Do not enable auto-merge on the second until its base is on `main`.

After the first is squash-merged, its commits are not on `main`, so a plain rebase replays them. Cut them off instead:

```bash
git fetch origin
git rebase --onto origin/main <old-first-tip> <second>
git push --force-with-lease origin <second>
timeout 60 gh pr edit <number> --base main
```

`<old-first-tip>` is the last commit of the first branch before it was squashed (`git log` or `git reflog`). Check the diff is only the second change: `git diff --stat origin/main...HEAD`.

If `main` moves while you wait, rebase on it and push with `--force-with-lease`. Never push to `main`.
