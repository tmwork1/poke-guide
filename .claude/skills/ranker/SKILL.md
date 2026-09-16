---
name: ranker
description: 新シーズンの公式ランキングJSON(docs/ranker/s{n}_single_ranked_teams.json)が増えたときに、対応する構築記事をダウンロード→機械抽出(pokesol)/LLM抽出(その他)→統合→DB投入(migrate/seed/refresh-suggestions)まで一気通貫で行う。手順の全体像と各生成物の意味は docs/ranker/derived/README.md に詳しい。「新シーズンの上位チームデータを取り込んで」「構築記事を解析してランキングDBを更新して」「rankerを回して」「上位チームの個体情報を最新化して」といった依頼に使う。
---

# 上位入賞チーム データ更新パイプライン

`docs/ranker/derived/README.md`「再生成」節の手順2〜6(記事ダウンロード〜サジェスト再集計)を、新シーズン追加のたびに一気通貫で回す。手順0-1(公式ランキングJSON・記事検索HTMLの取得)は `.github/workflows/ranker-fetch.yml` が毎日自動実行しているので、通常はこのskillの対象外(P0で未取得と分かった場合のみ手動で叩く)。

**特に指示のない限り `main` で直接作業する**(→ルートの `CLAUDE.md`「作業方針」)。**作業が一区切りついたら Coordinator が `git commit` する**(`git push` はしない)。

**READMEの「カバー範囲」表の数値は更新が追いつかないことがある。** 対象シーズンの判定は表の記載を鵜呑みにせず、`docs/ranker/s*_single_ranked_teams.json` の実ファイルと `docs/ranker/derived/ranked-teams.json` の `sources.ranking` を突き合わせて判定する。

## 役割分担

| 役 | 担当 | やること | やってはいけないこと |
|---|---|---|---|
| Coordinator(メイン) | — | 対象シーズン判定、決定的スクリプトの実行、バッチ結果の検収、DB投入、commit | 大量の記事解釈を自分で丸抱えする |
| 記事抽出者 | **Haiku subagent**(`model: "haiku"`, `subagent_type: "general-purpose"`) | `tasks/<KEY>.md` を読み `scripts/ranker/EXTRACTION_SPEC.md` の仕様で `llm/<KEY>.json` を書く | git操作全般、`members` リストの水増し・推測補完 |
| 表記ゆれ辞書作成者 | Haiku subagent 1体 | `extraction-report.json` の `rejected_by_validation` を見て `name-aliases.json` の追記候補を作る | 語彙リストに実在しない技/特性名を右辺に置く |

**この工程だけは `codex` skillの「委任は常にcodex優先」の対象外。** `EXTRACTION_SPEC.md` が元々Haiku subagent向けに設計されており(大量記事を安価に並列処理する前提)、既存の実測結果(README「個体情報の出どころ」節)もこの構成で出ている。変更する積極的理由が無い限りHaikuのまま踏襲する。

## 手順

### P0. 対象シーズンを判定する

1. `docs/ranker/derived/README.md` を読む(生成物の意味・既知の罠を把握)。
2. `docs/ranker/s*_single_ranked_teams.json` の一覧と `docs/ranker/derived/ranked-teams.json` の `sources.ranking` を比較し、未取り込みのシーズンを特定する。
3. 未取り込みシーズンが無ければ、ユーザーに「新シーズンなし」と報告して終了する。
4. `docs/ranker/derived/articles-index.json` の該当シーズン件数が、対象の `s{n}_single_ranked_teams.json` のチーム数と一致するか確認する(一致しなければP1から手動で回す必要がある)。
5. 記事HTMLキャッシュ用の `$CACHE` ディレクトリ(リポジトリ外)をユーザーに確認する。過去の実行例は `C:\Users\tmtmp\ranker-cache`。

### P1. 記事索引・記事本文を取得する

`.github/workflows/ranker-fetch.yml` が既に対象シーズンのランキングJSON/記事索引を作っているのが通常。P0-4で不一致が見つかった場合のみ:

```bash
npm run ranker:fetch-teams -- --seasons <n> --rule single
npm run ranker:fetch-articles -- --seasons <n> --rule single
npm run ranker:index -- docs/ranker/derived/articles-index.json
```

続いて記事本体を落とす(常に実行):

```bash
npm run ranker:download -- docs/ranker/derived/articles-index.json $CACHE
npm run ranker:refetch-naver -- docs/ranker/derived/articles-index.json $CACHE
```

### P2. 決定的抽出とタスク分割

```bash
npm run ranker:pokesol -- $CACHE $CACHE/pokesol.json
npm run ranker:text -- $CACHE $CACHE/text
npm run ranker:tasks -- $CACHE docs/ranker $CACHE/tasks --target-per-batch 20
```

出力される `N tasks -> M batches` を記録する。`$CACHE/tasks/_batches.json` にバッチ内訳(KEY一覧)が入る。

### P3. LLM抽出(Haiku並列)

`$CACHE/tasks/_batches.json` の各バッチを1エージェントに割り当て、**バッチ数だけ並列で** Agent tool(`references/agent-prompts.md`「記事抽出者テンプレート」)を起動する。

- 各エージェントには `scripts/ranker/EXTRACTION_SPEC.md` をそのまま読ませる。要約や言い換えをして渡さない。
- 全バッチ完了後、`$CACHE/llm/*.json` の件数が P2で報告されたタスク総数と一致するか確認する。欠けているKEYがあれば、そのKEYだけを再度1エージェントに割り当てて回収する。

### P4. 統合・検算

```bash
npm run ranker:build -- --cache $CACHE
```

- 標準出力の `rejected_by_validation` を確認する。表記ゆれ(語彙に無い技名/特性名)が原因の却下が目立つ場合、`references/agent-prompts.md`「表記ゆれ辞書テンプレート」でHaiku 1体に `name-aliases.json` への追記候補を作らせ、追記後に build を再実行する。**2〜3回で収束すれば十分**(0件にする必要はない。実在しない/読み取れない技もある)。
- `docs/ranker/derived/extraction-report.json` の件数(取得できたメンバー数・技/努力値/性格/特性の充足数)を、直近コミット時点の値と比較する。大きく劣化していれば抽出のどこかが壊れている疑いがあるので原因を特定してから先に進む。

### P5. DB投入

ローカルSupabaseが起動していることを確認してから:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run ranker:seed
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run refresh-suggestions
```

(`DATABASE_URL` は `.env.local` と同じ値。ローカル開発環境の詳細はルートの `CLAUDE.md`「ローカル開発環境」参照)

### P6. 検証してcommitする

- `git status` で `docs/ranker/derived/*.json` / `scripts/ranker/name-aliases.json` 以外に差分が無いか確認する(他セッションの未コミット変更を巻き込まない)。
- `docs/ranker/derived/README.md` の「カバー範囲」表を新しい数値に更新する。
- `.tmp-*` の消し忘れが無いか確認する。
- Coordinatorが `git commit` する(`git push` はしない)。

## 参照

- `docs/ranker/derived/README.md` — 生成物・データの意味の記録(手順ではなくこちらが正)。特に以下はP4の検算やトラブル時に読む
  - 「個体情報(技/努力値/性格/特性)の出どころ」— `build_ranked_teams.py` が行う4段階検算(表記ゆれ解決・語彙照合・努力値検証・スロット割り当て直し)の詳細
  - 「species_key — アプリ側の語彙への対応づけ」— `FORM_SPECIES_KEYS` に無いフォルムが出るとエラーで止まる理由
  - 「英数字の半角統一」— `norm()` を通し忘れるとメガストーン所持個体の判定が壊れた過去の実害
- `scripts/ranker/EXTRACTION_SPEC.md` — LLM抽出の出力スキーマと厳守ルール。agentへの指示に必ずそのまま渡す
- `references/agent-prompts.md` — 記事抽出者・表記ゆれ辞書作成者への委任テンプレート
- `.claude/skills/codex/SKILL.md` — 一般的な委任基準(このパイプラインのLLM抽出はcodexでなくHaiku指定。理由は上の「役割分担」参照)
