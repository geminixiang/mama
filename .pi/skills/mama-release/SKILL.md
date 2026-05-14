---
name: mama-release
description: Prepare and publish a new mama release. Use when bumping the version, committing and pushing it, and creating a GitHub release in the style of earlier mama releases.
---

# Mama Release

Repo defaults:

- branch: `main`
- remote: `origin`
- repo: `geminixiang/mama`
- use `package.json` version as the git tag and GitHub release title
- versions with `-alpha.`, `-beta.`, or `-rc.` are prereleases by default

## Version rules

Examples:

- stable: `0.2.1`, `0.3.0`, `1.0.0`
- prerelease: `0.2.0-beta.8`, `0.3.0-rc.1`, `1.0.0-alpha.2`

Guidance:

- `patch` = bugfix / small maintenance
- `minor` = backward-compatible features
- `major` = breaking changes
- prerelease numbers increase within the same line, e.g. `beta.8 -> beta.9`
- promote prerelease to stable by dropping the suffix, e.g. `0.2.0-beta.8 -> 0.2.0`

## Flow

### 1. Check state

```bash
git status --short
git branch --show-current
git remote -v
git tag --list | tail -20
```

Read `package.json` and `package-lock.json`. If unrelated files are modified, ask before committing.

### 2. Sync version files

Preferred:

```bash
npm version <version> --no-git-tag-version
```

Use this to sync `package.json` and `package-lock.json` without creating an automatic commit or tag. If the user already edited `package.json`, just verify `package-lock.json` matches.

### 3. Commit and push

Stage only version files unless the user asked for more.

```bash
git commit -m "chore: bump version to <version>"
git push origin main
```

### 4. Draft release notes

Use the previous GitHub release as the style reference.

```bash
gh release list --repo geminixiang/mama --limit 10
gh release view <previous-tag> --repo geminixiang/mama --json tagName,name,body,url,publishedAt
git log --pretty=format:'%h %s' <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
```

Write concise notes focused on user-visible changes, usually with:

- `## What's changed`
- `### Highlights`
- `### Notable changes`
- `### Docs and maintenance`
- `### Verification`

Write notes to `/tmp/mama-release-<version>.md`.

### 5. Create or update release

Prerelease:

```bash
gh release create <version> \
  --repo geminixiang/mama \
  --target main \
  --title <version> \
  --notes-file /tmp/mama-release-<version>.md \
  --prerelease
```

Stable:

```bash
gh release create <version> \
  --repo geminixiang/mama \
  --target main \
  --title <version> \
  --notes-file /tmp/mama-release-<version>.md
```

If it already exists, use `gh release edit <version> ...` and keep prerelease/stable intent consistent.

## Report back

Return:

- released version
- stable or prerelease
- version-bump commit hash
- push status
- release URL

## Guardrails

- Always use `geminixiang/mama`.
- Infer stable vs prerelease from the version, or ask.
- Do not include raw commit hashes in release notes unless requested.
- If hooks fail during commit, fix or report before retrying.
