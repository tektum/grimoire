---
name: pull-request-visuals
description: Use when you open or update a Grimoire pull request that needs visuals - screenshots for a feature, before and after shots for a bug fix, or a terminal capture for tooling. Uses the built-in --attach flag of the GitHub CLI.
---

# Pull request visuals

- Feature: attach screenshots or a short recording of the new behaviour.
- Bug fix: attach a BEFORE and an AFTER shot.
- A change that adds or changes a screen's screenshots under `docs/screenshots/` also updates the "What it looks like" section of README.md (relative image paths, alt text, one-line caption).
- Tooling-only or server-only change with nothing to see: write "not applicable" and the reason, or attach a terminal capture.

## Capture

Works today:

- Terminal output: paste it as a fenced code block in the body, or save it as an image with any terminal-to-image tool you have in `mise.toml`.
- A diagram: a Mermaid block in the body renders on GitHub.

Applies when the web client arrives: take screenshots with a headless browser through the project's own test tooling (the end-to-end tests), at a fixed window size, and save them as PNG files. Take the before shot on `main` and the after shot on your branch, with the same data.

## Attach

`gh pr create`, `gh pr edit` and `gh pr comment` have `--attach <file>#<alt text>`. Up to 50 files per command. If the body refers to the file as `![alt](./file.png)`, that reference is rewritten to the uploaded asset. Paths in a `--body-file` are relative to the body file's directory, then to the working directory.

Feature:

```bash
timeout 60 gh pr create --base main --title "feat: add page export" \
  --body-file body.md \
  --attach './export-menu.png#The export menu' \
  --attach './export-done.png#The finished export message'
```

Bug fix, with the images placed in the body (for example under a "Visuals" heading):

```markdown
Before: ![before](./before.png)

After: ![after](./after.png)
```

```bash
timeout 60 gh pr create --base main --title "fix: keep cursor after reload" \
  --body-file body.md \
  --attach ./before.png --attach ./after.png
```

Add shots to an existing pull request:

```bash
timeout 60 gh pr edit <number> --body-file body.md --attach ./after.png
timeout 60 gh pr comment <number> --body "New shot after the fix." --attach ./after.png
```

If some files upload and others fail, the pull request is still created and the command exits non-zero. The URL is still printed. Check the body on GitHub and attach the failed files again.

Never put secrets, tokens, real names or private data in a screenshot.
