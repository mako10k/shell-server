# Copilot Release Instructions

This repository uses the following fixed sequence of steps for release work.

## 1. Pre-commit code quality checks
Run the following locally and make sure they complete without failures.

```bash
npm install
npm run build
npm audit
npm run test:e2e
```

- If `npm audit` reports issues, update dependencies or fix code and re-run until it reports `0 vulnerabilities`.
- Even if tests are flaky, `build` and `audit` must succeed.

## 2. Version bump rules
- Always keep the versions in `package.json` and `package-lock.json` in sync.
- Follow SemVer for bump decisions.
  - `patch`: bug fixes, dependency updates, internal non-breaking fixes
  - `minor`: backward-compatible feature additions
  - `major`: breaking changes
- Example commands:

```bash
npm version patch --no-git-tag-version
# or npm version minor --no-git-tag-version
# or npm version major --no-git-tag-version
```

## 3. Git commit
Commit only the changes required for the release.

```bash
git add package.json package-lock.json CHANGELOG.md .github/copilot-instruction.md
git add <release-files>
git commit -m "chore(release): <version>"
```

## 4. Create Git tag
Create an annotated tag that matches the commit.

```bash
git tag -a v<version> -m "Release v<version>"
```

## 5. Git push (branch + tag)
Push both the `main` branch and the tag.

```bash
git push origin main
git push origin v<version>
```

## 6. npm publish
Ensure `prepublishOnly` (build) passes before publishing.

```bash
npm publish
```

## 7. Update GitHub Release
Create or update the Release corresponding to the tag.

```bash
gh release create v<version> --title "v<version>" --generate-notes
# If a release already exists:
gh release edit v<version> --title "v<version>" --notes-file <release-note-file>
```

## Release notes policy
- Align the release notes with the relevant section in `CHANGELOG.md`.
- At minimum, list changes in `Fixed` / `Security` / `Dependencies`.
- If there are compatibility impacts, include migration steps under `Notes`.