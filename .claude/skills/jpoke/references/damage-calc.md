# jpoke ダメージ計算の契約

**検証時点**: jpoke v0.2.0 (`vendor/jpoke`) / 2026-07-27
**上流リポジトリの参照コミット**: d51e9c96b (`../jpoke`、補助参照のみ)

> このファイルは `vendor/jpoke` のコードを読んで書いた要約です。**すべての事実に出典(ファイル:行)を付けること。**
> 出典の無い記述は次に読むエージェントが信用できないため、書かないでください。

## 1. API・入出力データ構造

- **`Battle.calc_damages(attacker, defender, move, critical=False) -> list[int]`**: 攻撃側・防御側の `Pokemon`、`Move`(または技名文字列)、急所かどうかの`bool`を受け取り、**16要素の`list[int]`**(乱数85%〜100%それぞれのダメージ確定値)を返す。急所になるかどうか自体はこの関数の内部では判定しない(呼び出し側が`critical`引数で指定する)(出典: `vendor/jpoke/src/jpoke/core/battle.py:1378-1398`、実装本体は `vendor/jpoke/src/jpoke/core/damage.py:73-164` の `DamageCalculator.calc_damages`)。
- **`Battle.roll_damage(attacker, defender, move, critical=False) -> int`**: `calc_damages()` の16要素から `battle.option.damage_roll` モード(`"normal"`=ランダム1つ / `"average"`=平均を`round_half_down`/`"max"`/`"min"`)に従って1値を選ぶ。実戦(ターン進行シミュレーション)で使われる経路(出典: `vendor/jpoke/src/jpoke/core/battle.py:1344-1370`)。
- **`Battle.calc_lethal(attacker, moves, critical=False, move_secondary=False, max_attack=10) -> list[LethalHitResult]`**: 致死率(HP分布)計算のエントリーポイント。§6参照(出典: `vendor/jpoke/src/jpoke/core/battle.py:470-499`)。

## 2. 乱数の扱い(16通り)

- `calc_damages()` は **16通り全てを列挙した`list[int]`を返す**(最小値・最大値だけを返す関数は存在しない)。呼び出し側が `min()`/`max()`/`sum()/16` などを取って使う設計(出典: `vendor/jpoke/src/jpoke/core/damage.py:142-164`)。
- 各要素は乱数インデックス `i`(0〜15)に対し **85%〜100%を1%刻み**で丸めたもの:
  ```python
  damages[i] = int(max_damage * (0.85 + 0.01*i))   # i=0→85%, i=15→100%
  ```
  (出典: `vendor/jpoke/src/jpoke/core/damage.py:142-145`)。したがって `damages[15]` が最大乱数、`damages[0]` が最小乱数(=いわゆる「乱数1」)に対応する。
- 確率: どの目も**均等に1/16**(ゲーム本編と同じ、テーブルに重み付けはない)。「確定/乱数n発」のような**ヒット回数の確率**は`calc_damages()`ではなく`calc_lethal()`が別途計算する(§6)。

## 3. 急所・命中・多段ヒットの扱い

- **急所**: `calc_damages()`/`roll_damage()` は`critical: bool`を引数として受け取るだけで、急所になるかどうかの抽選はしない。実際の抽選は技実行フロー側の `MoveExecutor._check_critical()` が行う。ランク0〜3に対応する確率は `CRIT_RATES = [1/24, 1/8, 1/2, 1]`(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:21,213-248`)。急所時はダメージ算出の**最初期**(乱数展開より前)に `max_damage` へ1.5倍(`round_half_down`で丸め)がかかる(出典: `vendor/jpoke/src/jpoke/core/damage.py:116-119`)。急所時のランク補正の特殊扱いは `ruleset.md` §5・§6参照。
- **命中**: `calc_damages()`の管轄外。`MoveExecutor._check_hit()` が別途 `100 * random() < accuracy` で判定する。技の命中率(`move.accuracy`)が`None`なら必中。命中ランク補正は `hit_rank_modifier(rank_acc, rank_eva)` で `(3+diff)/3`(上昇側)または `3/(3-diff)`(下降側)(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:164-206`、式定義は `:30-36`)。`battle.option.accuracy_fix_threshold` が設定されていて実効命中率がそれ以上なら強制必中になるテスト用オプションもある(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:203-205`)。
- **多段ヒット技**: ヒット回数の決定は `MoveExecutor._resolve_hit_count()` が行い、`calc_damages()`自体はダメージ計算そのものはノータッチ(=1回分のダメージ計算のみを担当し、複数ヒットのループは呼び出し側の責務)。
  - `min_hits == max_hits` なら固定回数。
  - `(min_hits, max_hits) == (2, 5)` の技(2〜5回技)は特別なテーブルで抽選:
    ```python
    MULTI_HIT_DISTRIBUTION_2_TO_5 = ((0.375, 2), (0.75, 3), (0.875, 4), (1.0, 5))
    # 2回=37.5%, 3回=37.5%, 4回=12.5%, 5回=12.5%
    ```
    (出典: `vendor/jpoke/src/jpoke/core/move_executor.py:22-27,129-138`)
  - それ以外の範囲(例: 2〜3回固定の技)は `random.randint(min_hits, max_hits)` の一様抽選(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:139-141`)。
  - 各ヒットの威力は技ごとの `power_sequence`(トリプルアクセル等、ヒットごとに威力が変わる技用)があればそれを参照し、なければ技の基礎威力を毎ヒット使う(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:141-156`)。
  - (未確認) UI側(poke-commons)が多段技の合計ダメージ幅を`calc_damages()`を複数回呼んで自前で合成しているか、専用APIがあるかは本ファイル執筆時点で未調査。

## 4. 補正のかかる順序と端数処理(最重要・最誤解ポイント)

`DamageCalculator.calc_damages()` 内の実際の計算順序(出典: `vendor/jpoke/src/jpoke/core/damage.py:100-164`):

```
1. 最終威力 final_power = round_half_down(base_power * power_modifier/4096)  [ただしテラス60底上げは補正後に適用]
2. 最終攻撃 final_attack = int(base_atk_stat * rank_modifier)               ← intで切り捨て(round_half_downではない)
                          → round_half_down(that * atk_modifier/4096)       ← その他補正はround_half_down
3. 最終防御 final_defense = int(base_def_stat * rank_modifier)              ← 同上、intで切り捨て
                           → round_half_down(that * def_modifier/4096)
4. base_damage = int(level_factor * final_power * final_attack / final_defense)   ← Pythonのintで切り捨て
5. max_damage = int(base_damage/50 + 2)                                     ← intで切り捨て
6. 急所なら max_damage = round_half_down(max_damage * 1.5)
--- ここまでは乱数非依存。以降は16通りそれぞれに対して個別に丸める ---
7. damages[i] = int(max_damage * (0.85+0.01*i))                             ← intで切り捨て
8. damages[i] = round_half_down(damages[i] * タイプ一致補正)
9. damages[i] = round_half_down(damages[i] * タイプ相性補正)
10. damages[i] = round_half_down(damages[i] * やけど補正)
11. damages[i] = round_half_down(damages[i] * その他ダメージ補正)
12. damages[i] = round_half_down(damages[i] * まもる貫通系補正)
13. タイプ相性が無効(0)でなく、かつダメージ補正が0でなければ damages[i] = max(1, damages[i])  ← 最低保証1
```

- **`round_half_down`(五捨五超入)** は「ちょうど0.5は切り捨て、0.5を超えたら切り上げ」という丸め方で、Pythonの`decimal.ROUND_HALF_DOWN`を使う独自実装(出典: `vendor/jpoke/src/jpoke/utils/math.py:27-29`)。**Pythonの組み込み`round()`(銀行丸め)とは異なる**ため、電卓で再現する際は要注意。
- **2種類の丸めが混在する**: ランク補正の適用(手順2・3)は`round_half_down`を使わず**単なる`int()`切り捨て**。その直後に来る「その他の補正」(アイテム・特性等)は`round_half_down`。この非対称性はコードを読まないと分からず、電卓側が全部同じ丸め方だと誤って実装すると1違いが頻発する。
- 威力・攻撃・防御はそれぞれ独立に丸めてから掛け算する(先に掛けてから1回だけ丸める、ではない)。手順4の`base_damage`計算自体は追加の丸めなしで`int()`のみ。
- **最低ダメージ1の保証条件**(手順13)は「タイプ相性補正0倍(無効)でなく、かつダメージ補正が0でない」場合のみ。無効タイプや特性等でダメージ0になる場合は保証されず0のままになる(出典: `vendor/jpoke/src/jpoke/core/damage.py:160-163`)。
- テラスタル威力60底上げ補正は「テラスタイプが技タイプと一致・連続攻撃技(`max_hits>1`)でない・優先度+1未満」の条件を満たすときのみ、`power_modifier`適用**後**に`max(power, 60)`として適用される(出典: `vendor/jpoke/src/jpoke/core/damage.py:271-300`)。

### 3補: タイプ一致補正(STAB)の内訳(2026-07-27、UI改善ラウンド17プレイヤー視点レビュー時に追記)

`_calc_atk_type_modifier()`(出典: `vendor/jpoke/src/jpoke/core/damage.py:166-210`)は手順8の「タイプ一致補正」の実体。`attacker.active_tera_type`(テラスタル**していなければ空文字列**、していれば実際のテラスタイプを返すプロパティ)を基準に分岐する:

- **テラスタルしていない**(`active_tera_type`が空): 技タイプが元のいずれかのタイプ(`attacker.data.types`)と一致すれば **1.5倍(6144)**、しなければ等倍(4096)。ここは本編と同じ通常のSTAB。
- **テラスタイプが「ステラ」**: 技タイプごとに1回だけ管理される`stellar_boosted_types`を見て、元タイプ一致技は初回2.0倍/2回目以降1.5倍、不一致技は初回1.2倍/2回目以降1.0倍。
- **テラスタイプが通常タイプ(ステラ以外)**: **テラスタイプと元タイプの両方が技タイプと一致すれば2.0倍(8192)**、どちらか一方のみ一致なら1.5倍(6144)、どちらも不一致なら等倍(4096)。
- **「テラスタイプ不明だから等倍のまま」という中間状態は存在しない**: `ruleset.md`の「テラスタイプ未指定時のデフォルト」の通り、`Pokemon`はテラスタイプ未指定でも第1タイプへ自動フォールバックするため、テラスタルを発動させた瞬間に必ず上記いずれかの分岐へ倒れる(第1タイプ一致の技なら8192側に倒れやすい)。呼び出し側(poke-commons)が「テラスタイプ未設定」の個体をテラスタル発動チェックにかけると、画面表示(「テラスなし」)と実際の計算(元タイプへの自己一致、2.0倍もあり得る)が乖離する経路になる。

## 5. 持ち物・特性・天候・フィールド補正が効く場所

ダメージ計算は4096を基準値(1.0倍)とする固定小数点のイベント発火で拡張される。補正が入るタイミングは決まったイベント名で固定されており、持ち物・特性・天候・フィールド・技の効果はすべて同じイベントに登録して割り込む(出典イベント一覧: `vendor/jpoke/src/jpoke/enums/event.py:405-441`、発火箇所: `vendor/jpoke/src/jpoke/core/damage.py`各所):

| イベント | 発火箇所 | 実例 |
|---|---|---|
| `ON_CALC_POWER_MODIFIER` | damage.py:268 | ちからずく(1.3倍, `handlers/ability.py:2563`)、あめ/はれ天候補正(`handlers/field.py:72,466`) |
| `ON_CALC_ATK_RANK_MODIFIER` | damage.py:333 | ランク補正そのものの上書き系効果 |
| `ON_CALC_ATK_MODIFIER` | damage.py:342 | こだわり系アイテム、攻撃force特性等 |
| `ON_CALC_DEF_RANK_MODIFIER` | damage.py:379 | 同上・防御側 |
| `ON_CALC_DEF_MODIFIER` | damage.py:388 | ワンダールーム(防御/特防の実数値参照を入れ替え, `handlers/field.py:673-685`) |
| `ON_CALC_ATK_TYPE_MODIFIER` | damage.py:210 | STAB(タイプ一致)補正の増減 |
| `ON_CALC_DEF_TYPE_MODIFIER` | damage.py:253 | 半減きのみ等の相性補正上書き(`handlers/item.py:130`) |
| `ON_CALC_BURN_MODIFIER` | damage.py:131 | やけど0.5倍(`handlers/ailment.py:186`) |
| `ON_CALC_DAMAGE_MODIFIER` | damage.py:135 | 効果抜群/半減きのみ、天候いわなだれ等の総合ダメージ補正 |
| `ON_CALC_PROTECT_MODIFIER` | damage.py:139 | まもる貫通系(Z技・ダイマックス技相当。本フォーマットでの実使用は要確認) |

すべて `battle.events.emit(Event.XXX, ctx, 4096)` の形で「基準値4096を渡し、登録済みハンドラが加工して返す」というパイプライン方式(出典: `vendor/jpoke/src/jpoke/core/damage.py:123-140`)。

## 6. 「確定n発」「乱数n発」はエンジン側かアプリ側か

**エンジン側(jpoke)が確率計算そのものを行う。アプリ側はその確率を見て日本語ラベルに変換しているだけ。**

- `Battle.calc_lethal(attacker, moves, critical, move_secondary, max_attack)` は、指定した技(列)を`max_attack`回撃ち込んだ場合の**各攻撃後のHP分布**を`LethalHitResult`のリストとして返す(確定数が出た時点で打ち切り)。ターン終了時効果(やけど・どく・食べ残し等)も分布計算に含まれる(出典: `vendor/jpoke/src/jpoke/core/battle.py:470-499`、実装: `vendor/jpoke/src/jpoke/core/lethal.py:217-253`)。
- `LethalHitResult.lethal_probability` プロパティが「HPが0になる確率(0.0〜1.0)」を返す(出典: `vendor/jpoke/src/jpoke/core/lethal.py:157-165`)。「確定n発」はこの値が1.0(またはUI側の閾値以上)、「乱数n発」は0より大きく1未満、を意味する。
- ダメージそのものの分布(`damage_dist`)・HP分布(`hp_dist`)は内部的に`StateDist`(`{State: 出現頻度}`の辞書)で表現され、複数回攻撃・複数の分岐(急所/追加効果/特性発動有無等)を畳み込み演算で合成する(出典: `vendor/jpoke/src/jpoke/utils/lethal_dist.py`全体、特に`_convolve`:94-121)。
- (poke-commons側の実装を参照した限り、jpokeのコードそのものではないため参考情報)アプリ側 `src/lib/pyodide-engine.ts` は `battle.calc_lethal()` の結果を `{attackCount, probability}` の配列に変換して返すのみで、確率計算自体は行っていない。`src/pages/box/[id].astro` の `formatVerdict()`/`describeSeriesVerdict()` が `probability >= 0.9999` を「確N」、それ未満を「乱N (xx.x%)」という文字列に整形しているだけで、統計計算はしていない。したがって**「この画面の確定/乱数表示がおかしい」と疑う場合、まず疑うべきはjpokeの`calc_lethal`ではなく、アプリ側のラベル整形・閾値・入力(技構成/急所有無等の指定)の方が高い**。

## 3補: 多段ヒット技23件の内訳(2026-07-27、UI改善ラウンド14 B-3実装時に追記)

**背景**: `public/master-data/autocomplete/moves.json` の `hits` フィールドを持つのは716技中23技のみ(`scripts/build-master-data/extract_autocomplete.py` の `build_moves()` が `data.multi_hit` から抽出)。`/moves/[name].astro` にこれを表示するにあたり、§3の記述だけでは「固定回数の技は技が命中すれば必ずその回数ヒットする」という前提が一部の技で成り立たないことが分かったため、`vendor/jpoke` を読んで確認し追記する。

- **23技の内訳**(`(min,max)`の分布): `(2,5)`が11技/`(2,2)`が5技/`(3,3)`が4技/`(10,10)`が1技(ネズミざん)/`(1,6)`が1技(ふくろだたき)。実測は `node` で `public/master-data/autocomplete/moves.json` を走査して確認済み(出典: `scripts/build-master-data/extract_autocomplete.py:178-207` のロジックが生成したデータそのもの)。
- **`check_hit_each_time` フラグ(§3で未記載だった論点)**: `move_executor.py` のヒットループは「命中判定を毎ヒット行うか、最初の1回だけ行うか」を技ごとのフラグで切り替えている(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:560-581`、`need_hit_check = accuracy is not None and (hit_index == 1 or check_hit_each_time)`)。`False`(既定)の技は**最初の1回だけ命中判定し、当たれば残りは自動で全ヒット確定**(=「命中すれば必ずN回」という説明が成立する)。`True`の技は**ヒットごとに毎回命中判定し、1回でも外れた時点でそこまでの回数で打ち切る**(break)。
- **`check_hit_each_time: True` は23技中3技のみ**: ネズミざん(`multi_hit: {min:10, max:10}`, 出典: `vendor/jpoke/src/jpoke/data/moves/move_na.py:288-293`)、トリプルキック(`multi_hit: {min:3, max:3}`, 出典: `vendor/jpoke/src/jpoke/data/moves/move_ta.py:986-996`)、トリプルアクセル(`multi_hit: {min:3, max:3}`, 出典: `vendor/jpoke/src/jpoke/data/moves/move_ta.py:976-985`)。3技とも `accuracy: 90`(`public/master-data/detail/moves.json` で実測確認)。他の固定回数技(すいりゅうれんだ/タキオンカッター/ダブルアタック/ダブルウイング/ツインビーム/ドラゴンアロー/にどげり/トリプルダイブ)は全て `check_hit_each_time: False` で、「命中すれば必ずN回」が成立する。
  - この3技の**期待ヒット回数**は幾何分布の打ち切り版として `E[hits] = p*(1-p^N)/(1-p)`(p=命中率, N=固定回数)で計算できる(1ヒット目の判定に外れれば技自体が「外れ」ログになる点は他の技と同じ。2ヒット目以降で外れると、そこまでの成功ヒット数で打ち切り)。p=0.9として: ネズミざん(N=10)は約5.9回、トリプルキック/トリプルアクセル(N=3)は約2.4回。`/moves/[name].astro` はこの式をそのままフロントマターで計算して表示している(新規データ生成不要、既存の`accuracy`と`hits`から導出可能)。
- **ふくろだたき(`multi_hit: {min:1, max:6}`)は上記のどちらの一般ルートも通らない**: `ON_MODIFY_HIT_COUNT` イベントに専用ハンドラ `ha.ふくろだたき_hit_count` が登録されており(出典: `vendor/jpoke/src/jpoke/data/moves/move_ha.py:690-704`)、ヒット回数は乱数ではなく「**選出中のポケモンのうち、ひんし・状態異常のいずれでもない数**」で決定的に決まる(出典: `vendor/jpoke/src/jpoke/handlers/move_attack.py:3049-3054`、`count = sum(1 for mon in state.selection if mon.alive and not mon.ailment.is_active)`、`max(1, count)`)。したがって「1〜6回の範囲でランダム」という説明は誤りで、UI側は確率分布ではなく「パーティ構成で決まる」という定性的な説明にする必要がある。
  - 同じ技のヒットごとの威力も基礎威力(`power: 1`)ではなく `ON_CALC_POWER_MODIFIER` の専用ハンドラ `ha.ふくろだたき_calc_power` が「使用者の基礎こうげき種族値 / 10 + 5」で毎ヒット上書きする(出典: `vendor/jpoke/src/jpoke/handlers/move_attack.py:3034-3046`)。`detail/moves.json` の `power: 1` は実戦の威力を表さない値である点に注意(ヨワシは「たんどくのすがた」の種族値を使う特例あり)。

## 上流との差分(v0.2.0時点)

- `vendor/jpoke/src` と `../jpoke/src` を `diff -rq` で比較した結果、ビルド生成物(`__pycache__`/`jpoke.egg-info`)と上流にだけある空ディレクトリ `src/jpoke/utils/type_defs/`(中身0件・参照なし)を除き**一致**しており、`damage.py`・`move_executor.py`・`lethal.py` 等ダメージ計算関連ファイルに差分は無かった。両方とも `version = "0.2.0"`。
- 上流 `docs/quick_reference.md` には丸め順序・`round_half_down`の定義・急所率テーブルなど本ファイルの核心部分の記載が見当たらず、突き合わせによる差分検出はできなかった。

## 未確認(コードで確認できなかった項目)

- (未確認) poke-commons UIが多段ヒット技の合計ダメージレンジ(最小合計〜最大合計)をどう算出しているか(`calc_damages()`をヒット数分呼んで畳み込んでいるのか、`calc_lethal()`の`damage_dist`をそのまま使っているのか)。
- (未確認) `ON_CALC_PROTECT_MODIFIER`(まもる貫通系)がこのプロジェクトの対戦フォーマット(ダイマックス・Z技なし想定)で実際に非4096の値を返すケースが存在するか。
- (未確認) `battle.option.damage_roll` のUI側デフォルト設定値(jpoke自体のデフォルトは`"normal"`)。
