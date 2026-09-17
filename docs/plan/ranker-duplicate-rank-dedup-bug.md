# rankerパイプライン: 同順位タイのチームが黙って1件消える不具合

**背景(2026-09-17のセッション)。** `/ranker` でM-5シーズン(シングル・185チーム)を取り込んだ際、
Opusによるダブルチェックで発覚。今回は対応せず、メモを残してセッションを終える。

## 問題

`scripts/ranker/build_ranked_teams.py` の統合処理(`build_ranked_teams()` 内、
`docs/ranker/*.json` を読むループ)で、チームの一意性を次のキーで判定している:

```python
ident = (season, rule, t['rank'])
if ident in seen:
    stats['duplicate_team_skipped'] += 1
    continue
```

公式ランキング(pokedb)はレートが同値のチームに**同じ順位を複数チームへ割り当てる**ことがあり、
この場合 `(season, rule, rank)` が重複するため後発のチームが黙って捨てられる。

M-5では実際に2組が確認されている(rank 767: ブリジュラス軸 vs メタグロス軸 / rank 835:
ビビヨン軸 vs ペリッパー軸)。`stats.duplicate_team_skipped` = 3 のうち2件がこれで、
`s5_single_ranked_teams.json` の185チームのうち183件しか `ranked-teams.json` に入っていない。
(残り1件はM-1〜M4時代からの既知の重複)。

`docs/ranker/derived/articles-index.json` のキー生成(`scripts/ranker/common.py` の
`key_of(season, rank)`)も同じ `(season, rank)` 方式なので、同順位タイのチームは
**記事も1本しか紐づけられない**構造になっている。どちらのチームの記事が採用されるかは
記事索引の生成順(HTML内の出現順)に依存し、決定的ではあるが意図した割り当てではない。

## 影響範囲

- `build_ranked_teams.py`: `ident` のキー生成、`seen` セット
- `scripts/ranker/common.py`: `key_of()`(記事キャッシュキー)
- `scripts/ranker/extract_articles.py`: 記事索引生成(`(season, rank)` で1エントリに畳み込んでいる箇所)
- `scripts/ranker/make_tasks.py` / タスクファイル命名(`<KEY>.md` が `M{n}_{rank:05d}` 形式)
- 既存の `docs/ranker/derived/ranked-teams.json` 内の `llm/*.json` キャッシュファイル名
  (`C:\Users\tmtmp\ranker-cache\llm\` 配下、リポジトリ外)も同キー方式

キーを `(season, rule, rank)` から `(season, rule, rank, 同順位内の連番)` のように拡張する場合、
articles-index・タスクファイル名・LLMキャッシュのキー生成をまとめて変更する必要があり、
過去に生成済みのキャッシュ(`M{n}_{rank:05d}.md` 形式のファイル名)との後方互換も考慮しないと、
既存のllmキャッシュがすべて再抽出対象になってしまう(コスト大)。

## 対応方針(未着手・要検討)

1. pokedbの生JSON側で同順位タイをどう区別できるか確認する(チーム内の並び順、レートの小数点以下、
   トレーナー名など、rank以外に安定した一意キーがあるか)。
2. 一意キーが取れるなら `(season, rule, rank)` に加えてそれを使う。取れないなら
   「同じrankの中でJSON内の出現順」を連番として使う(決定的だが、pokedb側の並び順が変わると
   キーが振り直しになりキャッシュが無効化される点に注意)。
3. 既存の `llm/*.json` キャッシュ(M1〜M5、900件超)の再抽出コストを避けるため、
   キー変更は「新たに重複が検出された場合のみ2件目以降に連番を振る」形にして、
   既存キーへの影響を最小化する設計が望ましい。

## 優先度

M-5時点での実害は185件中2件(約1%)。次シーズン以降も同程度の頻度で起こりうるが、
`/ranker` を回すたびに`stats.duplicate_team_skipped`をP6で確認すれば見逃しはしない。
緊急度は低いが、シーズンを重ねるごとに欠落チームが積み上がる点は留意。
