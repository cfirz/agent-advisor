---
description: Stage, commit, and push local changes with a conventional commit message. Run docs-agent first if documentation needs updating.
---

## Commit and Push

### Pre-flight
- If this commit includes feature/fix/breaking changes, consider running `docs-agent` first to update CHANGELOG.md and README.md.
- Stage commit and push ALL local changes.

### Tasks

1. **Review changes**
   - Run `git status` and `git diff --stat` to see what's changed.
   - Summarize the changes for the commit message.

2. **Stage files**
   - Stage relevant files by name (avoid `git add -A` to prevent accidental includes).
   - Never stage `.env`, credentials, or secrets.

3. **Commit with conventional format**
   ```
   feat(client): add double jump mechanic
   chore(ci): update GameCI action version
   docs: update API contracts for /api/me endpoint
   ```
   - Scope: `client`, `server`, `ci`, `docs`, or omit for cross-cutting changes.
   - Keep the subject line under 72 characters.
   - Add a body paragraph if the change needs explanation.

4. **Push to origin**
   - Push to the current branch: `git push -u origin HEAD`
   - If on `main`/`master`, warn the user and suggest creating a feature branch first.

### Final result
- All local changes committed and pushed to the correct origin branch with a clear conventional commit message.
