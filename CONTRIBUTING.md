# Contributing

Grimoire is developed in the open, through small pull requests into `main`.

- Keep each pull request focused on one change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  and pull request titles (for example `feat: add page export`). Pull requests
  are squash-merged, so the title becomes the commit message on `main`.
- Every change needs passing CI (the `CI Required` check) and one approval,
  and all review threads must be resolved.
- Pull requests from outside the project are welcome, but reviews may take a
  while.
- Workflow runs for pull requests from forks need a maintainer's approval and
  run only the cheap checks on GitHub-hosted runners; the heavy jobs (on the
  project's own runners) run only for branches in this repository, so
  `CI Required` stays red for a fork pull request.
- To merge a contribution from a fork, a maintainer who has reviewed its
  commit pushes it to a branch in this repository and opens a pull request
  from that branch, so that every job runs before the merge.
- Show the change: a feature pull request includes screenshots or a short
  recording of the new behaviour (and a diagram or terminal capture where it
  helps), and a bug-fix pull request includes before and after shots. If a
  visual makes no sense, say "not applicable" in the description and why.
  Attach files with the GitHub CLI: for a feature, `gh pr create --attach './login.png#The new login page'`;
  for a bug fix, `gh pr edit 12 --attach ./before.png --attach ./after.png`.
- Never commit secrets or credentials.
- Contributions are accepted under the same licence as the project, the
  Apache License 2.0 (inbound equals outbound); there is no contributor
  agreement.

## Set-up

Install [mise](https://mise.jdx.dev) and run `mise install`: `mise.toml` and `mise.lock` pin Node and the checking tools (gitleaks, actionlint, zizmor) for local work and for CI. Then run `npm ci`.

To report a security issue, do not open a public issue: follow
[SECURITY.md](SECURITY.md).

## For maintainers

Workflow runs from outside contributors are held until a maintainer approves them, and that approval is the security boundary. Before approving workflow runs for an outside pull request, read every change under `.github/` and to any script the workflows run (`Makefile`, `package.json` scripts, `tools/`); if such a pull request needs the heavy jobs, a maintainer pushes the reviewed commit to a branch in this repository.
