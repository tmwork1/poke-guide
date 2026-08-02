# docs/ranker/derived — 上位入賞チームの派生データ

このディレクトリのファイルは `docs/ranker/` の元データから機械的に生成されたもので、
`ranked_teams` / `ranked_team_members`(`migrations/010_ranked_teams.sql`)への投入元になる。
**手で編集しない。** 作り直す手順は下の「再生成」を参照。

## 元データ

| ファイル | 中身 |
| --- | --- |
| `docs/ranker/s{1,2,3}_single_ranked_teams.json` | 公式ランキング。シーズンM-1/M-2/M-3の上位チーム(計1042件、うち`M-1 rank 533`が重複1件)。種族・フォルム・タイプ・持ち物・レートを持つが、**技/努力値/性格/特性は入っていない** |
| `docs/ranker/season_M{1,2,3}_1.html` | 構築記事検索の1ページ目(各100件=計300件)。記事URL・タイトル・プレイヤー名を持つ |

チームと記事は `(season, rank)` で 300/300 完全に結合する(レート値も一致することを確認済み)。

## 生成物

| ファイル | 中身 |
| --- | --- |
| `articles-index.json` | HTMLから抜いた構築記事300件の索引 |
| `ranked-teams.json` | 投入用の統合データ(全1041チーム)。`scripts/db/seed-ranked-teams.mjs` が読む |
| `extraction-report.json` | どの経路で何件取れたか、検証で何を弾いたかの記録 |

## カバー範囲

| | 件数 |
| --- | --- |
| チーム | 1041(M-1 527 / M-2 223 / M-3 291) |
| メンバー | 6241 |
| 構築記事があるチーム | 300 |
| 記事から個体情報が取れたチーム | 255 |
| 記事があるのに何も取れなかったチーム | 45(x.com 29 / YouTube 3 / 本文が画像のみ 等) |
| 個体情報が入ったメンバー | 1435(pokesol 513 / LLM 922) |
| 技が入ったメンバー | 1380 |
| 努力値が入ったメンバー | 883 |
| 性格 / 特性が入ったメンバー | 1089 / 1099 |

「記事があるのに取れなかった45件」は**抽出の失敗ではない**。構築記事の多くは個体情報を
画像(スクリーンショット)で貼っており、本文テキストには数値が存在しない。
x.com 29件とYouTube 3件がその代表で、残りも本文が画像だけの記事。

一度「本文に無い」と判定した20件を読み直したところ12件は実際には拾えた。内訳は
(a) 韓国語記事(blog.naver.com)の翻訳漏れ、(b) 技だけ書かれている記事を
「努力値が無いから」と落としていた取りこぼし、(c) **yakkun.com 4件の文字化け**。
(c) は EUC-JP のページをUTF-8として読んでいた `html2text.py` 側のバグで、
charset宣言を見るように直した(この4件は表形式で努力値まで完全に取れた)。
非UTF-8のサイトを追加するときは同じ罠に注意すること。

努力値が883件しか無いのは、記事が数値ではなく「HB:特化リザードンのニトロチャージ耐え」
「S:準速マスカーニャ抜き」という**調整意図**で書く慣習によるもの。数値に復元できないものは
入れていない(推測で埋めない)。

## 個体情報(技/努力値/性格/特性)の出どころ

記事のホストによって取得方法と精度が違うため、`ranked_team_members.extraction_source` に必ず残している。

- **`pokesol`** — pokesol.app の記事は本文に `<div data-type="pokemon-card" data-nature-id=... data-move-ids=... data-evs=...>` として個体情報が構造化されて埋まっている。さらに `<記事URL>.data`(React Routerのturbo-streamペイロード)を取ると ID→日本語名のマスタも同梱されている。**LLMを介さず決定的に読める**ので `confidence` は常に `high`。95件中85件がこの経路。
- **`llm`** — それ以外(はてなブログ/note/blog.naver.com 等)は散文なので、Haiku subagentに `scripts/ranker/EXTRACTION_SPEC.md` の仕様で読ませている。LLMの出力はそのまま信じず、`build_ranked_teams.py` で次の4段階の検算にかけてから採用する。

  1. **表記ゆれの解決** — 記事は「地震」「剣舞」「ステロ」「適応力」のように漢字・略称で書くので、`scripts/ranker/name-aliases.json` で正式名に寄せる。解決できない名前は採用しない(捏造を通さないため)。
  2. **語彙の照合** — 技名/特性名が実在するかを確認する。`public/master-data/autocomplete/{moves,abilities}.json` **だけでは足りない**(パラパラチャージ・ひけんちえなみ・ルミナコリドー・わざわいのかぎ 等のチャンピオンズ追加技が入っていない)ため、`scripts/ranker/champions-vocab.json` と和集合を取る。
  3. **努力値の検証** — 各項目0〜32・合計66以下で検証する(合計65や64の振り残しは実データにも存在する正当な配分なので、66ちょうどは要求しない)。一部の項目しか書かれていない出力は、残りを0とみなした合計が**ちょうど66**になるときだけ0で埋める。届かなければ復元できないので不採用。
  4. **スロットの割り当て直し** — LLMは個体を**記事に出てくる順**で番号付けしがちで、公式ランキングの並び順とずれる(実際にM-1 2位でアーマーガアとハラバリーの技が入れ替わっていた)。`vendor/jpoke` のlearnsetsと特性表を使い、「その種族が覚えられる技か」で総当たり的に割り当て直す。**922体中109体がこれで直っている。** 直してもなお半分以上の技が非整合な個体は値を残したまま `confidence` を `low` に落とす。

  落ちた値は `extraction-report.json` の `rejected_by_validation` に残る。
  検算後の技の整合率は LLM由来 3012/3069 (98.1%)、pokesol由来 1991/2025 (98.3%) で、
  **LLM由来の不整合率は「learnsetデータ自体の欠け」と同水準**に収まっている。
- **`NULL`** — 構築記事が無いチーム、または記事に個体情報が無かった場合。
  x.com(29件)とYouTube(3件)は本文が画像/動画で、テキストからは何も取れない。

補足: このデータセットには**テラスタルが1件も存在しない**(HTMLのテラスアイコン1800枠すべてが空、
pokesolのカードも `data-tera-type` を持たない)。チャンピオンズはメガシンカ主体のルールのため。
`tera_type` 列は将来のシーズン用に残してあるが、現状は全てNULLになる。
LLMが「テラスタイプ」として返してきた値は記事の読み違いでしかないので採用しない
(実測でも6件すべてが根拠の無い「ノーマル」だった)。落とした値は
`extraction-report.json` の `rejected_by_validation.tera` に残る。

## species_key — アプリ側の語彙への対応づけ

各メンバーには、公式ランキングの表記(`species_name` / `form_name`)とは別に
**`species_key`**(アプリ内の正式な種族名 = `public/master-data/autocomplete/pokemon.json` の
`name` = `owned_pokemon.species_name` と同じ語彙)を付けている。表記が2通りあるのは、

- 公式ランキングはフォルムを別列で持つ(`species_name`='ロトム' + `form_name`='ウォッシュロトム')が、
  アプリは名前に畳み込む('ウォッシュロトム')
- 公式ランキングはメガシンカを**進化前+メガストーン**で表す(ギャラドス@ギャラドスナイト)が、
  アプリは種族名そのものを'メガギャラドス'にして持ち物欄をメガストーンに固定する
  (`src/lib/box-id/shared-core.ts` の `resolveMegaStoneItem`)

ため。`species_name` のまま集計するとフォルム違いが1種族に潰れ、メガ個体のデータが
ユーザーの編集画面に一生届かない。変換は `build_ranked_teams.py` の `species_key_of()` が行い、
機械的な規則では導けないフォルム(「ばけたすがた」→アプリ側に区別無し、
「パルデアのすがた・ブレイズしゅ」→'ケンタロス(パルデア炎)')は明示表 `FORM_SPECIES_KEYS` に置く。
**表に無いフォルムが出てきたらエラーで止まる**(新シーズンでサジェストから静かに漏れるより落ちたほうがよい)。
実測 6241体すべて解決、うち2043体がメガストーン所持でメガ後の種族名になる。
ヒヤッキー@ゴルーグナイトのように**使えないメガストーンを持った個体が3件実在する**ため、
図鑑番号が一致するときだけメガ後の名前に寄せている。

この `species_key` を使って、上位入賞チームの個体は匿名集計サジェスト
(`refresh_popular_builds()`、`migrations/011_ranked_teams_in_suggestions.sql`)の母集団にも入る。
ウェイトはユーザー登録個体と同じ1個体1票。

## 英数字の半角統一

技名/持ち物名/フォルム名などの固有名詞に含まれる英数字は、**必ず半角**で記録する
(jpoke = `vendor/jpoke` の語彙、および `public/master-data` の語彙と同じ表記に揃えるため)。

公式ランキングJSON(メガストーン名の「リザードナイトＹ」等)にも pokesol.app のマスタ
(技名の「１０まんボルト」等)にも全角英数字が混ざって来る。`build_ranked_teams.py` の
`norm()`(`unicodedata.normalize('NFKC', ...)`)が出力に載せる直前に必ず通すことで統一している。
**新しく文字列を出力に足す処理を書くときは、必ず `norm()` を通してから `members` / `out_teams` に入れること。**

これは表記の見た目だけの問題ではない: 全角のまま `item_name` を持たせていた時期は、
`mega_by_stone`(`public/master-data/autocomplete/mega-stones.json`、半角キー)と
一致せず、メガストーン所持個体が `species_key` 上ただの進化前種族として扱われてしまう
実害があった(2026-08-02 修正。148体が正しく `メガ〇〇` に付け替わった)。

`scripts/ranker/champions-vocab.json`(語彙補完)も同じ理由で半角に揃えてある。
ここに全角の技名/特性名を追加すると、`norm()` で半角化された記事由来の値と
一致しなくなり、実在する技が「未知の技」として黙って捨てられる。

## 再生成

```bash
CACHE=C:\Users\tmtmp\ranker-cache   # 記事HTMLのキャッシュ置き場(リポジトリ外)

# 0. 公式ランキングJSONと記事検索HTMLを取得する(以前は手動でcurl/ブラウザ保存していた)
npm run ranker:fetch-teams -- --seasons 1,2,3 --rule single
npm run ranker:fetch-articles -- --seasons 1,2,3 --rule single

# 1. HTMLから記事索引を作る
python scripts/ranker/extract_articles.py docs/ranker/derived/articles-index.json

# 2. 記事本体を落とす(pokesol.app は .data、それ以外は素のHTML)
python scripts/ranker/download_articles.py docs/ranker/derived/articles-index.json $CACHE
python scripts/ranker/refetch_naver.py docs/ranker/derived/articles-index.json $CACHE  # naverは本文がiframe

# 3. pokesol.app を機械抽出 / 残りをテキスト化してLLM用タスクに割る
python scripts/ranker/build_pokesol.py $CACHE $CACHE/pokesol.json
python scripts/ranker/html2text.py $CACHE $CACHE/text
python scripts/ranker/make_tasks.py $CACHE docs/ranker $CACHE/tasks --target-per-batch 20

# 4. $CACHE/tasks/*.md を Haiku subagent に配って $CACHE/llm/<KEY>.json を書かせる
#    (仕様は scripts/ranker/EXTRACTION_SPEC.md。バッチ割りは $CACHE/tasks/_batches.json)
#    表記ゆれ辞書 scripts/ranker/name-aliases.json も、build_ranked_teams.py が出す
#    extraction-report.json の rejected_by_validation を入力にして同様にLLMで作る。
#    値は必ず語彙リストに実在する文字列でなければ採用されないので、誤りは通り抜けない。

# 5. 統合してDBへ
python scripts/ranker/build_ranked_teams.py --cache $CACHE
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/db/seed-ranked-teams.mjs

# 6. サジェストの再集計(母集団に上位チームが入るため、投入後に回す)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run refresh-suggestions
```

手順4だけがLLMを挟む。0〜3と5は決定的なので、記事キャッシュさえあれば何度でも同じ結果になる。
`ranked-teams.json` をそのままコミットしてあるのは、**手順4を再実行しなくてもDBを再現できるようにするため**。
