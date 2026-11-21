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
- Never commit secrets or credentials.
- Contributions are accepted under the same licence as the project, the
  Apache License 2.0 (inbound equals outbound); there is no contributor
  agreement.

To report a security issue, do not open a public issue: follow
[SECURITY.md](SECURITY.md).
