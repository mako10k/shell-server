# Copilot Release Instructions

このリポジトリでのリリース作業は、以下の順序を **固定手順** とする。

## 1. コミット前のコード品質チェック
必ずローカルで以下を実行し、失敗がないことを確認する。

```bash
npm install
npm run build
npm audit
npm run test:e2e
```

- `npm audit` で問題がある場合は、依存更新またはコード修正を行い、`0 vulnerabilities` になるまで再実行する。
- テストが不安定な場合でも、`build` と `audit` の成功は必須。

## 2. Version バンプルール
- バージョンは `package.json` と `package-lock.json` を必ず同期する。
- バンプ判定は SemVer に従う。
  - `patch`: バグ修正、依存更新、後方互換ありの内部修正
  - `minor`: 後方互換ありの機能追加
  - `major`: 破壊的変更
- コマンド例:

```bash
npm version patch --no-git-tag-version
# または npm version minor --no-git-tag-version
# または npm version major --no-git-tag-version
```

## 3. Git コミット
リリースに必要な変更のみをコミットする。

```bash
git add package.json package-lock.json CHANGELOG.md .github/copilot-instruction.md
git add <リリース対象の修正ファイル>
git commit -m "chore(release): <version>"
```

## 4. Git タグ作成
コミットと一致する注釈付きタグを作成する。

```bash
git tag -a v<version> -m "Release v<version>"
```

## 5. Git Push（ブランチ＋タグ）
`main` とタグを両方 push する。

```bash
git push origin main
git push origin v<version>
```

## 6. npm publish
公開前に `prepublishOnly`（build）が通ることを確認して publish する。

```bash
npm publish
```

## 7. GitHub Release 更新
タグに対応する Release を作成または更新する。

```bash
gh release create v<version> --title "v<version>" --generate-notes
# 既存がある場合
gh release edit v<version> --title "v<version>" --notes-file <release-note-file>
```

## Release Notes ポリシー
- `CHANGELOG.md` の該当バージョン節と整合させる。
- 最低限、`Fixed` / `Security` / `Dependencies` の変更点を明記する。
- 互換性影響がある場合は `Notes` に移行手順を必ず記載する。
