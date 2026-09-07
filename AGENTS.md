# Codex 作業ルール

実装・修正作業を完了し、必要な検証が通ったら、作業対象の変更を `git commit` する。

- コミット前に `git status` と差分を確認し、他者・ユーザーによる無関係な変更は含めない。
- `git push` は、ユーザーから明示的に依頼された場合のみ行う。
- 複数セッションが同じリポジトリを並行して変更する場合は、コミット前に競合や変更範囲を確認する。

# UIの確認・検証

ブラウザでの確認は既存のCLIを使い、検証用のPlaywrightスクリプト(`.tmp-*.mjs` 等)を毎回書き起こさない。

- `npm run shot -- --page <path> [--clip <sel>] [--size 390x844]` — スクリーンショット
- `npm run probe -- --page <path> [--rect <sel>] [--style "<sel>:<prop,...>"] [--overflow] [--click <sel>] [--fill "<sel>=<値>"] [--eval <js>]` — 実測・操作

いずれも `npm run dev` の起動が前提。足りない観点が出たら使い捨てスクリプトではなく `scripts/shot.mjs` / `scripts/probe.mjs`(共通処理は `scripts/lib/page-session.mjs`)にオプションを足す。
