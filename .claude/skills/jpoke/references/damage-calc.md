# jpoke ダメージ計算の契約

**検証時点**: jpoke v0.2.0 (`vendor/jpoke`) / 2026-07-27(§7追記時点でvendor更新済み)
**上流リポジトリの参照コミット**: 3dd183ee5 (`../jpoke`、PR#355 `fix/lethal-fixed-damage-moves` マージ後。vendor/jpokeもこの時点のsrcと完全一致)

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

## 7. calc_lethal が「通常のダメージ計算に従わない技」を計算する仕組み(2026-07-27、jpoke PR#355取り込み時に追記)

**背景**: `Battle.calc_lethal()` は `battle.calc_damages()` のみを呼び、実戦の技実行フロー(`MoveExecutor`が発火する`Event.ON_MODIFY_MOVE_DAMAGE`等)を一切通らない(§3参照)。固定ダメージ技・割合ダメージ技・一撃必殺技・反射技は、威力そのものが`Event.ON_MODIFY_MOVE_DAMAGE`ハンドラで実戦時に動的に決まる(`MoveData.power`は`None`)ため、この経路では**威力None→ダメージ0**になっていた(`core/damage.py`の`if not move.base_power: return [0]`)。jpoke PR#355(`fix/lethal-fixed-damage-moves`)がこれを修正した(出典: `vendor/jpoke/src/jpoke/core/lethal.py`・`handlers/lethal.py`)。

- **仕組み**: `MoveData.lethal_handlers`という技専用の`LethalEvent.ON_BEFORE_HIT`ハンドラで、`LethalContext.damage_from_hp`(防御側HP→ダメージを返すクロージャ)または`ctx.damage_dist`を直接設定する。`damage_from_hp`が設定されている間は、`_apply_damage`が通常の`damage_dist`一括適用ではなく`_apply_damage_by_branch`(HP分布の枝ごとに`damage_from_hp(state.value)`を呼ぶ)に分岐する(出典: `core/lethal.py`の`_apply_damage`/`_apply_damage_by_branch`)。がんじょう・きあいのタスキ等のHP1耐えは、HP満タン枝でだけ`ON_APPLY_DAMAGE`ハンドラを通す既存の仕組みがそのまま使われるため、一撃必殺技をがんじょうが防ぐ挙動も自然に再現される。
- **対応した技(15件、`LethalHandler`を新規登録)**: いかりのまえば・カタストロフィ(`half_damage`=現在HP1/2)/いのちがけ(使用者の現在HP固定・技後に使用者HP0)/ハサミギロチン・じわれ・ぜったいれいど・つのドリル(`ohko_damage`=命中すれば必ず現在HPそのもの。**命中率は考慮しない**。ぜったいれいど→こおりタイプのみ別途無効化)/ほうふく・メタルバースト(直近被ダメージ×1.5)/カウンター(直近の物理被ダメージ×2)/ミラーコート(直近の特殊被ダメージ×2)/がむしゃら(相手HP−自分HP、最低0)/みねうち(通常ダメージをHP-1でキャップ。**唯一base_powerを持つ通常攻撃技**で、`_calc_damage_dist`の`damage_dist`をそのまま枝ごとキャップ関数に閉じ込める)/ナイトヘッド・ちきゅうなげ(`level_fixed_damage`=使用者レベル固定)。全て`_is_immune()`(タイプ相性0倍・ふしぎなまもり)でダメージ0に倒す。
- **対応していない技**: **はきだす**は`power: null`かつ変化技でない14件の1つだが、この修正の対象外のまま。理由: 威力が「ためこむ」の使用回数で決まり、その回数を威力へ反映する`ha.はきだす_set_power`は実戦の`Event.ON_TRY_MOVE_1`でのみ発火するため、`calc_lethal`のフロー(ON_BEFORE_HITベース)では拾えない。既存の`lethal_handlers`には`ON_HIT`で使用後のたくわえるランクを巻き戻す`はきだす_reset_stockpile`だけがあり、ダメージ自体を設定するハンドラは無い(出典: `handlers/lethal.py`の`はきだす_reset_stockpile`、`data/moves/move_ha.py`の`"はきだす"`エントリ)。**calc_lethalでは`はきだす`は今も常にダメージ0になる。**
- **OHKO技はlethal計算上「命中すれば確定1発」になる**: `ohko_damage`は命中率を無視して常に致死ダメージを返す設計(他の技も含め、`calc_lethal`全体が命中判定自体をモデル化していないため、これはOHKO技特有の欠陥ではなく仕様通りの一貫した挙動)。実際の命中率(OHKO技は一律30%)は`calc_lethal`の確率には現れない。UI側で命中率を併記する場合は静的な`detail.accuracy`から読む必要がある(出典: `public/master-data/detail/moves.json`のOHKO技4件は全て`accuracy: 30`)。
- **poke-commons側の対応**: `src/pages/box/[id].astro`はラウンド19でこの14件全てに対し「ダメージ算出不能」と表示する抑止(`isVariablePowerMove`)を追加していたが、ラウンド20でこの修正の取り込みに合わせて`はきだす`のみに限定した(`isUnsupportedLethalMove`)。OHKO技には引き続き命中率30%の補足を追記するが、数値自体は隠さず表示するよう変更した。

## 8. 揮発状態(volatile)の付与APIと「片側性」(2026-07-27、UI改善ラウンド20 20-R3実装時に追記)

**背景**: `.claude/skills/jpoke/`にvolatile関連の記述が1件も無かった(grep 0件)ため、`vendor/jpoke`を実読・実行して確認した。

- **付与API**: `Battle.set_volatile(target, name, count=None, source=None) -> bool`(出典: `vendor/jpoke/src/jpoke/core/battle.py:1221-1239`)。`set_ailment`/`set_weather`と同じ「シナリオ構築・ダメージ計算検証用」の直接付与API。`volatile_manager.apply()`を呼ぶだけの薄いラッパーで、戻り値boolは**「既に同じ揮発性状態がある場合は失敗」**という契約(重複時のみFalse)。
- **定義**: `vendor/jpoke/src/jpoke/data/volatile.py`の`VOLATILES: dict[str, VolatileData]`(約70種)。各エントリは`handlers: dict[Event, VolatileHandler]`(実戦・`calc_damages`双方が通る通常のイベント系統)と、致死率計算専用の`lethal_handlers: dict[LethalEvent, LethalHandler]`を持つ。

### 8-1. `subject`/`subject_spec`による片側性(★誤解の常連になりうる最重要点)

`VolatileHandler`/`LethalHandler`はいずれも`subject`(`LethalHandler`)または`subject_spec`(`VolatileHandler`、例`"attacker:self"`/`"defender:self"`)を持ち、**「攻撃側/防御側のどちらの役割に付与されたときだけ効くか」が揮発状態ごとに固定**されている(出典: `vendor/jpoke/src/jpoke/core/lethal.py:554-565`の`_get_pokemon_handlers`が`h.subject in {subject, None}`でフィルタする箇所、`data/volatile.py`各エントリの`subject_spec`引数)。**逆側に付与しても`set_volatile()`自体は成功(True)するのに、計算結果(ダメージ・確定数)には一切反映されない**。

**実機検証(vendor/jpokeをネイティブPythonで実行して実測、2026-07-27)**:
```
のろい を防御側(HP追跡対象)に付与 → 2発必要だった相手が1発で確殺(乱数依存が消え確1化)
のろい を攻撃側に付与             → 変化なし(baseline と同一)
タールショット を防御側に付与     → かえんほうしゃ 91〜108 → 182〜216(2倍、ほのお技弱点化)
タールショット を攻撃側に付与     → 変化なし(baseline と同一)
じゅうでん を攻撃側に付与         → 10まんボルト 76〜91 → 153〜180(2倍、自分の技威力up)
じゅうでん を防御側に付与         → 変化なし(baseline と同一)
やどりぎのタネ を防御側に付与     → 4発必要だった相手が3発で確殺
```
(検証コード: `LethalHitResult`/`calc_damages`を直接呼ぶ最小スクリプト。attacker=ハバタクカミ/カイリュー/リザードン/サンダー、defender=ディンルー/カビゴンで確認)

- **A分類(ターン終了時HP増減)は全件`subject="defender"`固定**: のろい/やどりぎのタネ/しおづけ/バインド/アクアリング/ねをはるの`LethalHandler`はすべて`subject="defender"`(出典: `data/volatile.py:37,385,706,718,738,891`)。これは`Battle.calc_lethal()`が**防御側(=攻撃を受け続ける側)のHP分布だけを追跡する**設計(攻撃側のHPはそもそも管理されない)ため、defender側に付与したときしか意味を持たない。
- **B分類(1発分のダメージ補正)は項目ごとにattacker:self/defender:selfが分かれる**: `じゅうでん`(`ON_CALC_POWER_MODIFIER`)のみ`subject_spec="attacker:self"`(出典: `data/volatile.py:405-411`、自分の技威力を上げる効果のため)。`タールショット`(`ON_CALC_DEF_TYPE_MODIFIER`)・`ちいさくなる`(`ON_CALC_POWER_MODIFIER`ほか)・`きょけんとつげき`(`ON_CALC_DAMAGE_MODIFIER`ほか)はいずれも`subject_spec="defender:self"`(出典: `data/volatile.py:556-559,599-601,203-205`)。B分類はこの通常の`Event`系統がフックなので、`calc_lethal()`が内部で`battle.calc_damages()`をそのまま呼ぶ(`core/lethal.py:401-415`)経路を通り、`calc_damages()`単体でも同じ片側性が再現する。
- **UI設計への含意**: 「攻撃側/防御側どちらのセクションにも同じ10項目を並べる」実装は、9/10項目(じゅうでん以外)が攻撃側セクションでは無効、じゅうでんが防御側セクションでは無効という「設定できるのに数値が動かない」チェックボックスを生む。poke-commonsの`box/[id].astro`はこの実測に基づき、`DAMAGE_ATTACKER_VOLATILES`(じゅうでんのみ)と`DAMAGE_DEFENDER_VOLATILES`(残り9件)を別々の選択肢配列にして、効果のある側にしか出していない。

### 8-2. 実装しない揮発状態(効かないイベント)

みがわり・まもる系・こんらん・ちょうはつ・アンコール・きゅうしょアップ・めいちゅうアップ/ロックオンは、`ON_TRY_ACTION`/`ON_MODIFY_COMMAND_OPTIONS`/`ON_BEFORE_APPLY_MOVE`/`ON_MODIFY_MOVE_DAMAGE`/`ON_TRY_MOVE_1`/`ON_MODIFY_ACCURACY`(命中率)いずれかにのみ登録されており、`Battle.calc_damages()`/`calc_lethal()`はこれらを発火しない(コマンド選択・行動実行フェーズ・命中判定のフックで、単発のダメージ計算経路には無い)。詳細な対応表は`docs/plan/ui_rounds/round-20.md`の20-R3節(出典つき)を参照。

## 9. 接触判定・特性の発動条件(2026-07-29、UI改善ラウンド29プレイヤー視点レビューで追記)

- **接触判定のデフォルト**: `BattleQuery.is_contact()` は `ctx.move.has_flag("contact")` を既定値として `Event.ON_CHECK_CONTACT` を発火する(出典: `vendor/jpoke/src/jpoke/core/query.py:121-133`)。**技の`flags`に`"contact"`が無ければ非接触技として扱われ、かたいツメ/どくしゅ等の接触技依存の特性は発動しない**。スケイルショットは`MoveData`に`flags`自体が定義されておらず非接触技であり、かたいツメの1.3倍は乗らない(出典: `vendor/jpoke/src/jpoke/data/moves/move_sa.py:743-755`)。じしんも`flags={"spread"}`のみで接触技ではない(本編仕様と一致)。フレアドライブは`flags={"contact",...}`を持ち接触技(出典: `vendor/jpoke/src/jpoke/data/moves/move_ha.py:843-844`)。
- **マルチスケイル(`full_hp_damage_modifier`フラグ)と多段ヒットの相互作用**: `core/lethal.py`は防御側がこのフラグを持ち、かつHP分布に満タン枝が存在する場合のみ`calc_damages`を2回呼んで満タン枝用/非満タン枝用のダメージ分布を別々に計算する(出典: `vendor/jpoke/src/jpoke/core/lethal.py:382-394`)。**多段ヒット技(例: スケイルショット2ヒット)では1ヒット目だけがHP満タン(マルチスケイル発動、0.5倍)で、2ヒット目は1ヒット目で減ったHPを参照するため非発動(等倍)になる**。実機検証(ネイティブPython、2026-07-29): メガリザードンX(いじっぱり/かたいツメ/こだわりハチマキ/A32S16)のスケイルショット2ヒット vs カイリュー(マルチスケイル/あつぞこブーツ/A32S16)で、1ヒット目のダメージ分布`{37,39,40,42,43,45}`(16通り)、2ヒット目`{74,78,80,84,86,90}`(=1ヒット目のちょうど2倍、マルチスケイル不発)。合計(`add_dist`畳み込み)の最小・最大は111〜135となり、poke-commonsの`calc_lethal_sequence_json`が返す`perAttackDamages`(`/box/[id].astro`のカード表示値)と一致することを確認した。**これにより「(未確認)poke-commons UIが多段ヒット技の合計ダメージレンジをどう算出しているか」は解消**: `pyodide-engine.ts`の`compute_attack_result`が、その攻撃のn_hits全ヒット分の`LethalHitResult.damage_dist`を`add_dist`で畳み込んだ`attack_damage_dist`から求めている(出典: `src/lib/pyodide-engine.ts:826-833`)。
- **パラドックス特性(こだいかっせい/クォークチャージ)の発動条件**: こだいかっせいは**天候「はれ」**、クォークチャージは**フィールド「エレキフィールド」**で発動する(名前の響きに反して「こだいかっせい=でんき系」ではない。こだいかっせいは太古(化石)ポケモン用で天候はれ、クォークチャージは未来ポケモン用でフィールドエレキがトリガー。出典: `vendor/jpoke/src/jpoke/handlers/ability_paradox.py:89-93`)。**ブーストエナジー(`item_name`)を持たせている場合は天候・フィールドに関係なく常時発動**(`source="item"`分岐、出典: 同ファイル:71-72,100-101)。
- **パラドックス特性が上昇させる能力の決定式**: 「ランク補正込みの実数値が最も高い能力」を選ぶ(HP除く5能力、同値時はA>B>C>D>Sの順)。ワンダールーム下では防御/特防を入れ替えて比較する(出典: `vendor/jpoke/src/jpoke/handlers/ability_paradox.py:16-41`)。**この能力は物理/特殊いずれか、あるいは素早さになることもある**。素早さが最大値になる努力値配分では、パラドックス補正はダメージ計算に一切寄与しない(素早さの1.3倍はダメージにもHPにも影響しない)。実機検証: ハバタクカミ(こだいかっせい/ブーストエナジー、努力値C32S32、実数値187-155-205)は`paradox_boost_stat == "spe"`(素早さ)になり、フレアドライブ(物理)のダメージにも自身の特防にも影響しない。
- **メガランチャー(パルス技1.5倍)は`subject_spec="attacker:self"`固定**(出典: `vendor/jpoke/src/jpoke/data/ability.py:3415-3422`)。**特性の持ち主が攻撃側のときにしか発動しない**。防御側として登場する場面(例: メガカメックスが技を受ける側)では、あくのはどう等のパルス技を受けてもメガランチャーは一切関与しない。

## 上流との差分(2026-07-27、PR#355取り込み後)

- `vendor/jpoke/src` と `../jpoke/src` を `diff -rq` で比較した結果、ビルド生成物(`__pycache__`/`jpoke.egg-info`)を除き**一致**。両方とも `version = "0.2.0"`(バージョン番号は据え置きのまま機能追加された点に注意。`pyodide-engine.ts`のwheel URLハードコードは変更不要だった)。
- 上流 `docs/quick_reference.md` には丸め順序・`round_half_down`の定義・急所率テーブルなど本ファイルの核心部分の記載が見当たらず、突き合わせによる差分検出はできなかった。

## 未確認(コードで確認できなかった項目)

- (未確認) `ON_CALC_PROTECT_MODIFIER`(まもる貫通系)がこのプロジェクトの対戦フォーマット(ダイマックス・Z技なし想定)で実際に非4096の値を返すケースが存在するか。
- (未確認) `battle.option.damage_roll` のUI側デフォルト設定値(jpoke自体のデフォルトは`"normal"`)。
