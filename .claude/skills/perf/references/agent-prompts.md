# 委任テンプレート

`.claude/skills/codex/SKILL.md` の手順で `codex exec` に渡すプロンプトの型。いずれも**このファイルの文面をそのまま埋めて渡せば足りる**設計。sonnetのAgent toolにフォールバックする場合も同じ文面を使う。

## 共通で必ず伝えること

- 対象ファイル(担当範囲)と、それ以外を編集しないこと
- `git commit` / `git push` は行わないこと(Coordinatorが行う)
- `.claude/skills/perf/references/safety-rules.md` を読むこと(データを変更する検証操作をする場合は必須)
- 完了報告に含めるもの(各テンプレート末尾を参照)

---

## 調査担当テンプレート(原因調査、`codex exec --sandbox read-only`)

```
あなたはこのリポジトリ(poke-guide)のパフォーマンス問題の調査担当です。ファイルの編集・git操作は一切行わず、調査結果の報告のみを行ってください。

## 対象
`docs/perf/dashboard.md` の以下のシナリオが目標タイムを超過しています。原因を特定してください。

- シナリオ: <label>(id: <id>)
- 対象URL/操作: <url or 操作内容>
- 目標: <targetMs>ms / 実測(中央値): <actualMs>ms(超過率 <ratio>x)
- シナリオの定義: tests/perf/scenarios/<file>.perf.spec.ts の該当test

## やること
1. シナリオが計測している範囲(ページ遷移なら該当.astro、インタラクションならクリック対象のイベントハンドラ)を読む
2. そのページ/操作が発火するAPI呼び出し・DBクエリ・外部リクエスト・重い同期処理を洗い出す
3. 実測値が目標を超えている原因を特定する(N+1クエリ、不要な同期待ち、外部APIの遅延、Pyodide初期化、バンドルサイズ等)
4. 原因が特定できたら、修正の方向性(どのファイルの何を変えるべきか)を提案する
5. 原因が計測対象の外部要因(devサーバー・外部API側の問題)で、アプリのコード修正では直せないと判断した場合はその旨を明記する

## 完了報告に含めること
- 特定した原因(コードの根拠付き。ファイルパス・行番号)
- 推奨する対応方針
- アプリ側で直せない外部要因だった場合はその判断根拠
```

---

## 実装者テンプレート(修正実装)

```
あなたはこのリポジトリ(poke-guide)のパフォーマンス改善の実装担当です。

## 背景
`docs/perf/dashboard.md` の以下のシナリオが目標タイムを超過しています。

- シナリオ: <label>(id: <id>)
- 目標: <targetMs>ms / 実測(中央値): <actualMs>ms(超過率 <ratio>x)
- 原因調査の結果: <P3の調査結果を貼る>

## あなたの担当
<修正対象ファイルを具体的に列挙>。**このファイル以外は編集しないこと。**

## やること
<原因に応じた具体的な修正指示。例:
- 「N+1クエリになっている◯◯を1回のJOINにまとめる」
- 「不要なawaitの直列待ちを Promise.all に変える」
- 「初回のみ必要な◯◯の初期化を遅延させる」>

## 制約
- git commit / git push は行わない
- `.claude/skills/perf/references/safety-rules.md` を守ること(既存データを変更する検証は行わない。使い捨てデータを使う場合は必ず後始末する)
- `.claude/skills/ui/references/pitfalls.md` の既知の罠を踏まないこと
- UIの見た目・情報構造・操作フローを変更する場合は `.claude/skills/ui/SKILL.md` の「デザイン方針」を踏襲すること(パフォーマンス改善が目的で、見た目の改修が目的ではないことに注意。見た目を変えずに直せるなら変えない)

## 検証方法
```bash
npx playwright test --config=playwright.perf.config.ts tests/perf/scenarios/<file>.perf.spec.ts --reporter=list
```
修正対象のシナリオが目標タイムに近づいた(または達成した)ことを確認する。共有のdashboard.md/latest.jsonは書き込まないこと(Coordinatorが後でまとめて再計測する)。

## 完了報告に含めること
- 変更したファイルと変更内容の要約
- 検証結果(修正前後の実測値)
- 既存データを変更する操作を行った場合、後始末の確認結果(一覧GETでの件数確認)
```

---

## シナリオ整備テンプレート(未カバーの画面/操作にシナリオを追加)

```
あなたはこのリポジトリ(poke-guide, Astro + Playwright)にパフォーマンス計測シナリオを追加する実装担当です。

## 背景
共通契約は `tests/perf/lib/perf.ts`(`perfScenario`/`timeNav`/`timeAction`/型`PerfMeta`)。まずこのファイルと `docs/perf/dashboard.md`(目標タイムの目安・運用方針)を読むこと。**このプロジェクトには自動保存で既存データを書き換える画面があるため、`.claude/skills/perf/references/safety-rules.md` を必ず読んでから実装すること。**

## あなたの担当
`tests/perf/scenarios/<file>.perf.spec.ts` に追記する(既存シナリオは変更しない)。**このファイル以外は一切編集しないこと。**

## 対象ページ・操作
<列挙。ページ遷移(page-load)/ クリック等の反応(interaction)/ モーダル等を閉じる(close) のどれを計測したいか明記>

## やること
1. 対象ページの実ソースを読み、読み込み完了判定に使える確実なセレクタを特定する(存在しないクラス名を推測しない)
2. 各対象について `perfScenario` + `timeNav`/`timeAction` を書く。`category`/`targetMs` は `docs/perf/dashboard.md` の目安に従う
3. 既存データを変更する操作(interaction)は、`safety-rules.md` の「使い捨てデータのライフサイクル」に従う

## 検証方法(共有ファイルを壊さないこと)
他の担当者が並行して別ファイルを編集している可能性があります。`docs/perf/dashboard.md` と `docs/perf/results/latest.json` への書き込みが起きないよう、必ず `--reporter=list` を付けて実行すること:
```bash
npx playwright test --config=playwright.perf.config.ts tests/perf/scenarios/<file>.perf.spec.ts --reporter=list
```

## 制約
- git commit / git push は行わない
- `tests/perf/scenarios/<file>.perf.spec.ts` 以外は編集しない(`tests/perf/lib/*`・`playwright.perf.config.ts`・`docs/perf/dashboard.md` も含む)

## 完了報告に含めること
- 追加したシナリオ一覧(id, label, targetMs, category)
- 実行結果(全pass したか)
- 使い捨てデータを作った場合、作成→削除まで確実に完了したことの確認結果
- 安全性の理由で見送ったシナリオがあれば、その理由
```
