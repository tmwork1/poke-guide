# jpoke ゲームルール・育成ルール仕様

**検証時点**: jpoke v0.2.0 (`vendor/jpoke`) / 2026-07-27
**上流リポジトリの参照コミット**: d51e9c96b (`../jpoke`、補助参照のみ)

> このファイルは `vendor/jpoke` のコードを読んで書いた要約です。**すべての事実に出典(ファイル:行)を付けること。**
> 出典の無い記述は次に読むエージェントが信用できないため、書かないでください。

## 1. チャンピオンズルール(このプロジェクト固有の運用)

**最重要: 以下はすべて仕様であり、バグではありません。** 過去に何度もAIエージェントが
「努力値が0〜32しかない」「個体値が常に31固定」を見て「バグでは?」と誤指摘しています。
実際には元々のポケモン本編の個体値0〜31・努力値0〜252スケールを、jpokeが
「Champions形式」という別スケールで表現しているだけです。

- **個体値**: `Pokemon` はコンストラクタ内で `self._ivs = [31]*6` として初期化される(全ステータス31固定がデフォルト)。`set_ivs()` で変更は技術的には可能(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:100`, `:742-758`)。
- **努力値(Champions形式)**: `Pokemon.evs` は **0〜32のスケール**で保持される。本編の0〜252スケールとは別物であり、docstringで明示的に「poke-envの`evs`(各値0〜252)とは名前は同じだがスケールが異なる」と注意書きされている(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:762-793`)。
- **0〜32スケール → 素の努力値(0〜252)への変換式**(最重要・最誤解ポイント):
  ```python
  def chmp_to_legacy_effort(effort_chmp: int) -> int:
      return 0 if effort_chmp == 0 else 8*effort_chmp - 4
  ```
  (出典: `vendor/jpoke/src/jpoke/model/stats.py:42-51`)
  つまり Champions値 `n`(1〜32)は 素の努力値 `8n-4` に対応する(1→4, 2→12, 3→20, …, 32→252)。
  `n=0` のときだけ特例で `0`(通常の式なら`-4`になってしまうため)。
  実数値計算では常にこの変換を経由してから `calc_hp`/`calc_stat` に渡される(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:896-904`)。
  - 端数処理: 素の努力値はステータス計算式内で `effort//4`(切り捨て除算)として使われる(出典: `vendor/jpoke/src/jpoke/model/stats.py:23,39`)。`8n-4` は4の倍数から4引いた値なので `//4` すると常に `2n-1` になり、努力値1刻みの増分が実数値に単調に反映される設計になっている。
- **レベル**: `Pokemon.__init__` の `level` 引数はデフォルト `50`(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:60,71,87`)。`set_level()` で変更は技術的に可能。
- **努力値合計上限66**: **jpoke自身はこの上限を一切検証・強制していない**(`vendor/jpoke` 全体を `grep 66` しても該当箇所なし。`set_evs()` も単に代入するだけで合計チェックは存在しない、出典: `vendor/jpoke/src/jpoke/model/pokemon.py:774-793`)。この「合計66」という数値はポケモンチャンピオンズという対戦フォーマット自体のルールであり、jpokeは個々のステータスが0〜32の範囲であること自体も検証しない(範囲外の値を渡してもそのまま計算する)。アプリ側(poke-commons)でも表示上の残りポイント表示のみで入力を制限していない(出典: `src/pages/box/[id].astro:2985-2988` のコメント「表示のみで、入力の制限は一切しない」)。**「jpokeが66を超える努力値を拒否しない」のは仕様であり、上限のチェックをしたいならアプリ側で実装する必要がある。**
- 上記4点(IV31・EV0〜32スケール・Lv50・合計66)はすべて**デフォルト値または運用上の慣習であり、jpoke内部でハード制約として強制されているのはIV31とLv50がコンストラクタのデフォルト引数である点のみ**。EVスケールの0〜32という「型」自体はコード上のプロパティ名・docstringで明示されているが、範囲外の値をエンジンが拒否するわけではない。

## 2. 実数値の計算式

```python
# HP (base=1のヌケニンは常に1固定。個体値・努力値・レベルによらない)
def calc_hp(level, base, indiv, effort):
    if base == 1:
        return 1
    return ((base*2 + indiv + effort//4) * level) // 100 + level + 10

# HP以外 (性格補正nc: 1.1/0.9/1.0)
def calc_stat(level, base, indiv, effort, nc):
    return int((((base*2 + indiv + effort//4) * level) // 100 + 5) * nc)
```
(出典: `vendor/jpoke/src/jpoke/model/stats.py:7-39`)

- `effort` は必ず素の努力値(0〜252)。Champions形式(0〜32)から渡す場合は `chmp_to_legacy_effort()` を経由する(§1参照)。
- HPと他ステータスの違い: HPは `+level+10`、他は `+5` してから性格補正 `nc` を掛ける(掛け算は性格補正のみに掛かり、HPには性格補正が存在しない)。
- 性格補正が掛かる箇所は「`(種族値*2+個体値+努力値/4)*レベル/100 の切り捨て + 5` を計算した**あと**」であり、種族値や努力値そのものに掛けるわけではない。
- 端数処理: `int(...)` はPythonの通常の切り捨て(0方向への切り捨て)。正の値のみが入るため実質「小数点以下切り捨て」。
- ヌケニン特例: 種族値HP=1のポケモンはHP実数値が常に1固定(個体値・努力値・レベルによらない)。fuzzテストで発見された特例挙動(出典: `vendor/jpoke/src/jpoke/model/stats.py:19-22`)。

## 3. 性格補正

- `NATURE_MODIFIER` は性格名→`[hp係数(常に1.0), atk, def, spa, spd, spe]` の6要素リスト(出典: `vendor/jpoke/src/jpoke/data/nature.py:1-27`)。
- 上昇補正: **1.1倍**。下降補正: **0.9倍**。補正なし(まじめ・てれや・がんばりや・すなお・きまぐれ等の性格): **全ステータス1.0倍**。
- 性格ごとに上昇/下降は1ステータスずつのみ(補正なし性格を除く)。HPは性格補正の対象外(リスト先頭要素は常に1.0で未使用)。

## 4. タイプ相性

- 倍率テーブルは `TYPE_MODIFIER[攻撃技タイプ][防御側タイプ]` の辞書(値は `0.0`/`0.5`/`1.0`/`2.0`)(出典: `vendor/jpoke/src/jpoke/data/type_chart.py`)。
- 複数タイプを持つ防御側には、各タイプの倍率を**順に掛け合わせる**(4096基準の固定小数点で `base = int(base * rate)` を防御側タイプ数だけ繰り返す)(出典: `vendor/jpoke/src/jpoke/core/damage.py:248-253`)。
- **無効(0倍)の扱い**: じめん技は「浮いている」相手(飛行タイプ、ふゆう特性、浮遊系の状態等。`battle.query.is_floating()`で判定)に対して無効。逆に浮いていないひこうタイプにはじめん技は等倍として扱う特例がある(出典: `vendor/jpoke/src/jpoke/core/damage.py:237-246`, `vendor/jpoke/src/jpoke/core/query.py:70`)。
- **ステラ技**: 相手がテラスタル済みなら、タイプ相性表を無視して常に効果抜群(8192 = 2.0倍)固定になる(出典: `vendor/jpoke/src/jpoke/core/damage.py:227-232`)。
- **テラスタル時の防御側タイプ判定**: `Pokemon.types` プロパティがテラスタル状態を自動的に反映するため、タイプ相性計算(`calc_def_type_modifier`)は常にテラス後の実効タイプに対して行われる。テラスタイプが「ステラ」の場合のみ元の複合タイプを維持し、それ以外のテラスタイプは単一タイプに置き換わる(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:537-560`)。
- 内部的にはすべて4096を1.0倍とする固定小数点整数で表現される(出典: `vendor/jpoke/src/jpoke/core/damage.py:222,234-253`)。
- **タイプ無し技(`type: None`、例: わるあがき)の扱い**: `calc_def_type_modifier()` は `TYPE_MODIFIER.get(move_type, {})` で相性表を引く。`move_type` が `None` のとき `TYPE_MODIFIER` に `None` というキーは存在しないため(存在するのは空文字列 `""` キーで、`None` とは別物)、`.get()` は既定値の空dict `{}` を返す。以降 `type_chart.get(def_type, 1.0)` で各防御タイプを引いても該当キーが無いため常に既定値 `1.0` になり、結果としてタイプ無し技は防御側のタイプに関わらず常に等倍(4096のまま)になる(出典: `vendor/jpoke/src/jpoke/core/damage.py:225,235,249-251`)。**`TYPE_MODIFIER[""]` キー自体(全防御タイプに対し1.0)は、この経路では一度も参照されない実質未使用のデータ**(出典: `vendor/jpoke/src/jpoke/data/type_chart.py:2-22`)。UI側でタイプ無し技の相性を扱う場合は「該当キーが無いので1.0」という空dictフォールバックの結果を再現すればよく、`""` キーを直接引く必要はない(結果は同じ1.0だが経路が違う)。
- **テラスタイプ未指定時のデフォルト(誤解の常連)**: `Pokemon.__init__` は `tera_type` 引数が `None`(未指定)のとき `self.tera_type = tera_type or self.base_types[0]` によって**そのポケモンの第1タイプを自動的にテラスタイプとして設定する**(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:89`)。`terastallize()` は `is_terastallized` フラグを立てるだけの薄いメソッドで、テラスタイプが「呼び出し側から明示的に渡されたのか、未指定でフォールバックしたのか」を一切区別しない(出典: 同ファイル `:675`)。つまり poke-commons 側が「テラスタイプ未設定(UI上『テラスなし』)」のつもりで `teraType: undefined` を渡しても、そのポケモンをテラスタル発動させた瞬間に**静かに第1タイプへ確定する**。STAB計算(`_calc_atk_type_modifier`)は「テラスタイプ・元タイプ両方が技タイプと一致 → 2.0倍」の分岐を持つため(`damage-calc.md` 参照)、第1タイプと一致する技を使うと通常の1.5倍ではなく2.0倍の自己タイプ一致補正が意図せず発生しうる。

## 5. ステータスランク補正

- 段階は **-6〜+6**(`STAT_RANK_MIN=-6`, `STAT_RANK_MAX=6`)(出典: `vendor/jpoke/src/jpoke/utils/constants.py:9-11`)。
- 攻撃・防御・特攻・特防・素早さのランク補正倍率(`Pokemon.rank_modifier`):
  ```python
  def rank_modifier(self, stat):
      v = self.boosts[stat]
      return (2 + v) / 2 if v >= 0 else 2 / (2 - v)
  ```
  (出典: `vendor/jpoke/src/jpoke/model/pokemon.py:847-857` の `rank_modifier` 定義)
  つまり +1〜+6 は `(2+n)/2` 倍(+1=1.5倍, +6=4倍)、-1〜-6 は `2/(2-n)` 倍(-1=0.667倍, -6=0.25倍)。
- **命中率・回避率のランク補正は別式**(`accuracy`ランク−`evasion`ランクの差分`diff`を使う):
  ```python
  def hit_rank_modifier(rank_acc, rank_eva):
      diff = clamp_stats(rank_acc - rank_eva)
      return (3+diff)/3 if diff > 0 else 3/(3-diff)
  ```
  (出典: `vendor/jpoke/src/jpoke/core/move_executor.py:30-36`)
- **急所時の適用条件**: 急所ヒット時は「攻撃側の能力**下降**は無視(ランク補正を最低でも1倍として扱う, `r_rank = max(r_rank, 1)`)」「防御側の能力**上昇**は無視(ランク補正を最大でも1倍として扱う, `r_rank = min(r_rank, 1)`)」(出典: `vendor/jpoke/src/jpoke/core/damage.py:335-336,381-382`)。
- ランク補正を実数値に適用する際の端数処理は `round_half_down` ではなく**単純な `int()` 切り捨て**(`final_attack = int(final_attack * r_rank)` / `final_defense = int(final_defense * r_rank)`)。ランク補正の**後**に来る「その他の補正」(アイテム・特性等)は `round_half_down` で丸められる、という**2種類の丸め方が混在**している点に注意(出典: `vendor/jpoke/src/jpoke/core/damage.py:339-345,385-390`。詳細は `damage-calc.md` の丸め順序節を参照)。

## 6. 急所(クリティカル)

- ランクは **0〜3**(`CRITICAL_RANK_MIN=0`, `CRITICAL_RANK_MAX=3`)(出典: `vendor/jpoke/src/jpoke/utils/constants.py:13-15`)。
- 確率テーブル: `CRIT_RATES = [1/24, 1/8, 1/2, 1]`(ランク0=1/24, 1=1/8, 2=1/2, 3以上=確定)(出典: `vendor/jpoke/src/jpoke/core/move_executor.py:21`)。
- ダメージ倍率は1.5倍。急所判定と急所ダメージ計算(`critical: bool`引数)は別処理であり、`DamageCalculator.calc_damages()` 自体は急所になるかどうかを判定しない(呼び出し側が`critical`を渡す)(出典: `vendor/jpoke/src/jpoke/core/damage.py:73-99,116-119`。判定ロジックは `vendor/jpoke/src/jpoke/core/move_executor.py:213-248` の `_check_critical`)。

## 7. その他、対戦の数値判断に直結する仕様

- **やけど補正**: 物理技のダメージを**0.5倍**(4096基準で2048)。ただし技名が `"_こんらん"`(こんらんの自傷ダメージの内部技名)の場合は第5世代以降の仕様通り半減の対象外(出典: `vendor/jpoke/src/jpoke/handlers/ailment.py:186-195`)。からげんき等はこの半減を無視する専用ハンドラで対応(出典: `vendor/jpoke/src/jpoke/handlers/move_attack.py:755-758`)。
- **能力ランクの内部保持**: `boosts` は `STAT_RANK_MIN`〜`STAT_RANK_MAX` にクランプされた整数として `Pokemon.boosts` 辞書に保持される。`accuracy`/`evasion` も同じ辞書のキーとして扱われる(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:112`, `vendor/jpoke/src/jpoke/utils/constants.py:6-11`)。
- **交代・退場時のステータスリセット**: `boosts` は退場時に全て0にリセットされる。実数値(ガードシェア等で書き換わっている場合)も種族値ベースへ再計算される(出典: `vendor/jpoke/src/jpoke/model/pokemon.py:139-160`)。

## 上流との差分(v0.2.0時点)

- 今回の検証時点で `vendor/jpoke/src` と `../jpoke/src` を `diff -rq` で比較したところ、`__pycache__`・`jpoke.egg-info` などのビルド生成物を除き**ソースコードは一致**していた。唯一の差分は上流にだけ存在する**空ディレクトリ `src/jpoke/utils/type_defs/`**(中身0件、どこからも参照されていない)で、実質的な差分ではない。`pyproject.toml` も両方 `version = "0.2.0"`。すなわち本ドキュメント執筆時点では「上流が先に進んでいる」状態ではない(上流のgit HEAD `d51e9c96b` はドキュメントのみの変更)。
- 上流の `docs/quick_reference.md` には本ファイルが扱う低レベル計算式(EV変換式・性格補正の適用順序・急所率テーブル等)についての記載が見当たらず(`grep` で該当なし)、記述内容自体の突き合わせはできなかった。差分の有無は不明。

## 未確認(コードで確認できなかった項目)

- (未確認) 個体値0〜32スケールへの変換有無(努力値と異なり、個体値はChampionsルールでも「素の値そのまま(0〜31)」として扱われているように見えるが、個体値専用の変換関数は見つからなかった。`set_ivs()` は素通しで代入するのみ)。
- (未確認) 努力値合計66という数値自体の一次情報(ポケモンチャンピオンズという対戦フォーマットの公式ルール文書)。jpoke/poke-commonsのコード上には66という定数そのものは存在せず、`src/pages/box/[id].astro` のUIコメントにのみ数値として現れる。
