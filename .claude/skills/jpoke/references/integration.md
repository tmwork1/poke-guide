# poke-commons と jpoke の接続面

**検証時点**: jpoke v0.2.0 (`vendor/jpoke`、上流3dd183ee5相当) / poke-commons `160fb1b` / 2026-07-27(vendor更新は同日中に追加実施)

**2026-07-27追記**: 上流PR#355(`fix/lethal-fixed-damage-moves`)を`vendor/jpoke`に取り込み済み。`calc_lethal`が固定ダメージ技・OHKO技等を正しく計算するようになった詳細は`damage-calc.md`§7を参照。これに伴い`src/pages/box/[id].astro`の`isVariablePowerMove`抑止ロジックを`isUnsupportedLethalMove`(対象は`はきだす`のみ)に縮小した。wheelバージョン文字列(`pyodide-engine.ts`の`0.2.0`)は変更不要だった(`pyproject.toml`のバージョン据え置きのため)。`npm test`・`npm run test:e2e`・上流`tests/test_lethal.py`(139件)は全てパス済み。

**2026-07-28追記(UI改善ラウンド22 22-E、round-12.mdで指摘された「jpoke更新時の回帰検出の穴」3件への対応)**: 詳細は§6・§7・§2(初期化フロー4番)に反映済み。要約:
- **22-E-1/22-E-2**: `tests/e2e/fixtures/generate_expected.py`が`BOOTSTRAP_PYTHON`を手書き複製していたのをやめ、`pyodide-engine.ts`からソース文字列を直接抽出・execする方式に変更。`calcStats()`/`calcLethalSequence()`もネイティブ一致確認の対象に追加(`tests/e2e/stats-lethal-sequence.spec.ts`、fixtureは`stats-cases.json`6件/`lethal-sequence-cases.json`8件)。既存の`expected.json`(10件)はバイト単位で不変(=既存テストへの実害は元々無かったことを確認)。
- **22-E-3**: `JPOKE_WHEEL_URL`のバージョン文字列ハードコードを解消。`build.mjs`が`wheel-manifest.json`を書き出し、`pyodide-engine.ts`がそれをVite静的importで読む方式に変更(実行時fetch無し)。
- **前提の誤り(訂正)**: 本ファイルの旧版が「ハードコードは`pyodide-engine.ts:36,924`の2箇所」と記録していたが、2026-07-28時点で実測すると**1箇所のみ**だった(§2参照)。round-22.md指示書の「924行目」記述もこの誤りを引き継いでいた。
- `npm test`(256件)・`npm run test:e2e`(3 spec、うち新規2件)は全てパス。新規比較が実際に差分を検出できることを、期待値を意図的にずらして失敗することを確認(その後復元)。

> このファイルは実際のコードを読んで書いた要約です。**すべての事実に出典(ファイル:行)を付けること。**
> 出典の無い記述は次に読むエージェントが信用できないため、書かないでください。

vendoring の方針・更新手順は `vendor/jpoke/VENDORING.md` を見よ(ここでは複製しない)。

## 1. jpoke API表面のうち、このアプリが実際に使っている部分

jpoke は大きいパッケージだが、poke-commons が触れているのは以下だけ。**これ以外は読まなくてよい。**

| 種別 | jpoke側シンボル | 用途 | 呼び出し元 |
|---|---|---|---|
| クラス | `Battle`, `Player`, `Pokemon`, `Move` (`jpoke`直下export) | 対戦状態の構築・実行 | `pyodide-engine.ts` BOOTSTRAP_PYTHON(出典: `src/lib/pyodide-engine.ts:368`) |
| クラス | `jpoke.core.EventContext` | テラスタル発動イベントの手動発火 | 同上(出典: `pyodide-engine.ts:369,463`) |
| 列挙 | `jpoke.enums.Event`(`ON_TERASTALLIZE`のみ使用) | 同上 | 同上(出典: `pyodide-engine.ts:370,463`) |
| 定数 | `jpoke.utils.constants.STATS, STAT_RANK_MIN, STAT_RANK_MAX` | ランク補正クランプ・stat配列の並び対応 | 同上(出典: `pyodide-engine.ts:371`) |
| 関数 | `jpoke.utils.lethal_dist.State, add_dist` | 打点分布のクランプ・畳み込み | 同上(出典: `pyodide-engine.ts:372`) |
| メソッド | `Battle.start/set_ailment/set_volatile/set_weather/set_terrain/activate_side_field/calc_damages/calc_lethal`, `Pokemon.set_evs/set_ivs/terastallize`, `battle.events.emit` | 対戦構築・ダメージ計算本体。`set_volatile(target, name)`はUI改善ラウンド20(20-R3)で追加(揮発状態。片側性の注意は`damage-calc.md`§8参照) | 同上(定義: `vendor/jpoke/src/jpoke/core/battle.py:96,132,1221,1241,1262,1298,1378`) |
| データ | `jpoke.data.POKEDEX, MOVES, ABILITIES, ITEMS` | マスタデータ生成の一次情報源 | `extract_autocomplete.py:343` |
| データファイル | `jpoke/data/ps-champ-ja/pokedex.json`(生JSON、`num`/`forme`) | 図鑑番号・フォルム名の補完 | `extract_autocomplete.py:346-347` |
| データファイル | `jpoke/data/pokeapi/ja_to_id_map.json`, `id_map.json`, `item_sprite_subdir_map.json` | 画像URL解決(ポケモン画像ID・アイテムsprite相対パス) | `extract_autocomplete.py:37-49,257-292`、参照実装 `vendor/jpoke/src/jpoke/utils/pokeapi.py:167-222` |
| ビルド設定 | `pyproject.toml`(jpoke自身) | wheel ビルド (`python -m build --wheel`) | `scripts/build-master-data/build.mjs:103` |

`vendor/jpoke/src/jpoke/utils/pokeapi.py` は**呼び出されてはいない**(Pyodide上でimportもしない)。`src/lib/sprite-urls.ts` がこのファイルの**ロジックをTypeScriptに移植**したもので、実行時の依存関係はない(出典: `src/lib/sprite-urls.ts:1-5`)。

## 2. 実行時(ブラウザ / Pyodide): `src/lib/pyodide-engine.ts`

クライアント専用モジュール(SSR/Cloudflare Workers環境からimport禁止、出典: `pyodide-engine.ts:4-8`)。

### 初期化フロー(`initEngine()`、遅延初期化・シングルトン)
1. Pyodide本体をCDNから`<script>`タグで読み込む: `https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js`(出典: `pyodide-engine.ts:30-32,911`)
2. `window.loadPyodide({ indexURL: ... })` でランタイム起動(出典: `pyodide-engine.ts:917`)
3. `pyodide.loadPackage("micropip")`(出典: `pyodide-engine.ts:920`)
4. `micropip.install(JPOKE_WHEEL_URL)` でjpoke wheelをインストール。**(2026-07-28 UI改善ラウンド22 22-E-3で解消済み)** 以前は `JPOKE_WHEEL_URL` にバージョン文字列 `0.2.0` を直書きしていたが、現在は `public/master-data/pyodide/wheel-manifest.json`(`build.mjs`のwheelビルド完了直後に実際に生成されたファイル名で書き出す)をVite静的import(`src/pages/api/search.ts`が`public/master-data/autocomplete/*.json`を静的importしているのと同じ方式)で読み込み、`` `/master-data/pyodide/wheels/${jpokeWheelManifest.filename}` `` としてURLを組み立てる(出典: `pyodide-engine.ts:34-42`、生成側: `scripts/build-master-data/build.mjs`の`buildPyodideWheel()`末尾)。ビルド時(Vite)に解決されるため実行時fetchは増えない。**実測確認済み**: `wheel-manifest.json`の`filename`を`jpoke-0.3.0-py3-none-any.whl`に手動で書き換えて`astro build`し直したところ、`pyodide-engine.ts`を一切編集せずに`dist/client/_astro/pyodide-engine.*.js`が新しいファイル名を参照するようになった(2026-07-28実測)。
   - **旧記述の訂正**: このファイルの旧版には「バージョン文字列0.2.0は`pyodide-engine.ts:36,924`の2箇所にハードコード」と書かれていたが、2026-07-28時点でコードを確認したところ**実際には36行目の1箇所のみ**だった(`micropip.install(JPOKE_WHEEL_URL)`は変数参照であり文字列直書きではない)。「924行目にも同じ文字列がある」という記述はこの時点で誤りだった(いつ・なぜ1箇所に減ったかは不明。round-22.mdの22-E-3指示に924行目の記載があったが実物と食い違っていたため、実測を優先してこの記述に訂正した)。
   - **未解決の制約(残存)**: `wheel-manifest.json`は`public/master-data/`配下でgit管理外のため、`npm run build:master-data`を一度も実行していないクローン直後の環境では`astro dev`/型チェックがこのJSON importの解決に失敗する。これは`search.ts`が`public/master-data/autocomplete/*.json`を静的importしている既存の制約と同じ(このプロジェクトでは「初回は`npm run build:master-data`が前提」という既存方針を踏襲しており、新たな問題ではない)。
5. `pyodide.runPythonAsync(BOOTSTRAP_PYTHON)` で固定Pythonコードを実行し、`calc_damages_json`/`calc_stats_json`/`calc_lethal_sequence_json`の3関数を`pyodide.globals.get(...)`で取得(出典: `pyodide-engine.ts:927-932`)。

### 公開API(TS側)と対応するPython関数
| TS関数 | 呼ぶPython関数 | 主な処理 | 出典 |
|---|---|---|---|
| `calcDamages(attackerSpec, defenderSpec, moveName, options)` | `calc_damages_json` | `Battle.calc_damages()`(乱数16段階)+ `Battle.calc_lethal()`(1発ごとの致死率) | `pyodide-engine.ts:526-556,965-1005` |
| `calcStats(spec)` | `calc_stats_json` | `Pokemon.stats`(努力値・個体値・性格・レベルのみ、ランク補正/状態異常/テラスタル非反映) | `pyodide-engine.ts:559-565,1030-1043` |
| `calcLethalSequence(attackerSpec, defenderSpec, attacks, options)` | `calc_lethal_sequence_json` | 攻撃列を先頭から`LethalHitResult.__add__`で合成した累計致死率・打点 | `pyodide-engine.ts:635-883,1071-1107` |

**値渡し**: ユーザー入力は文字列結合せず、必ず`pyodide.toPy(obj)`でPythonオブジェクト化してから引数として渡す(コードインジェクション対策、出典: `pyodide-engine.ts:353-358`)。`toPy()`が生成したPyProxyは呼び出し後に`.destroy()`で明示的に破棄しないとPython側にリークする(出典: `pyodide-engine.ts:999-1004,1041,1102-1105`)。

**PokemonSpec → jpoke `Pokemon` の対応**(`_build_pokemon`、出典: `pyodide-engine.ts:393-439`):
- `name/gender/nature/level/abilityName/itemName/moveNames/teraType` → `Pokemon(...)`コンストラクタへそのまま渡す(出典: `pyodide-engine.ts:414-423`)
- `evs/ivs` → `pokemon.set_evs()/set_ivs()`(出典: `pyodide-engine.ts:426-430`)
- `boosts`(6要素、先頭HPは無視) → **`STATS[1:6]`のインデックス対応で`pokemon.boosts[stat]`に直接代入**(Battle構築前、出典: `pyodide-engine.ts:432-437`)。jpokeの`Stat` Literalの並びは`["hp","atk","def","spa","spd","spe","accuracy","evasion"]`(出典: `vendor/jpoke/src/jpoke/types/literals.py:56`)なので現状は正しいが、**この並びが変わると気付かれずランクが別ステータスに適用される**(詳細は§5)。
- `ailment/terastallized` → Battle開始後に`_apply_battle_only_state()`で`battle.set_ailment()`/`mon.terastallize()`+`battle.events.emit(Event.ON_TERASTALLIZE, ...)`を個別適用(理由: `Pokemon.__init__`では状態異常のダメージ半減ハンドラやテラスタル発動特性が発火しないため。出典: `pyodide-engine.ts:442-463`)

**FieldSpec → jpoke対応**(`_apply_field`、出典: `pyodide-engine.ts:480-492`): `weather`→`battle.set_weather(name,5)`、`terrain`→`battle.set_terrain(name,5)`、`defenderSideFields`→`battle.activate_side_field(defenderPlayer,name,5)`。count(持続ターン)は固定値5(ダメージ計算自体は発動有無しか見ないため、出典コメント同箇所)。

**`calcLethalSequence`固有**: 攻撃1件ごとに専用の`Battle`をゼロから再構築する(1つのBattleを使い回すと「壁を消す」等の弱める方向の変化を表現できないため、出典: `pyodide-engine.ts:649-656`)。累計は`LethalHitResult.__add__`で合成し、`_clamp_hp_dist_min0()`でHPを0未満にクランプして単調性を保証する(jpokeの`subtract_dist`がクランプしないため、出典: `pyodide-engine.ts:568-594,684-691`)。打点(`perAttackDamages`/`cumulativeDamage`)とHP(`lethal`)は別系統で集計しており、たべのこし等の回復・継続ダメージは打点側には含まれない(出典: `pyodide-engine.ts:230-238,693-711`)。

### Service Worker: `public/pyodide-sw.js`
cache-first。対象は正規表現2本のみ: `^https://cdn\.jsdelivr\.net/pyodide/`(Pyodide CDN)と`/master-data/pyodide/`(jpoke wheel)。GET以外・対象外URLは素通し(出典: `pyodide-sw.js:8-29`)。`initEngine()`とは独立で、`registerOfflineCache()`はページ読み込み時に呼んでもPyodide自体のロードは開始しない(出典: `pyodide-engine.ts:307-323`)。

## 3. 呼び出し側ページ

| ページ | 初期化トリガー | 使うAPI | 備考 |
|---|---|---|---|
| `src/pages/box/[id].astro` | **ページ表示直後、アイドル時間に自動プリフェッチ**(`requestIdleCallback`)。全ページ共通の「ボタンを押すまで遅延初期化」方針への**明示的な例外**(出典: `box/[id].astro:5489-5503`) | `calcLethalSequence` + `calcStats`(並列。`calcDamages`は不使用、出典: `box/[id].astro:2284-2297,3990-3993`) | 攻守切り替え(`direction`)は「どちらのSpecをattacker/defenderとしてエンジンに渡すか」を入れ替えるだけ(出典: `box/[id].astro:3972-3984`) |
| `src/pages/damage-calc-poc/index.astro` | ボタンクリックで`initEngine()`(遅延初期化の基本形、出典: `damage-calc-poc/index.astro:169-174`) | `calcDamages`のみ(出典: 同ファイル:104-111,187-192) | Phase 1-7の疎通確認用ページ |
| `src/pages/e2e-test-harness/index.astro` | Playwrightから`page.evaluate()`で`window.__pyodideEngine__.init()`を呼ぶ | `calcDamages`を`window.__pyodideEngine__`として公開するだけの薄いラッパー(出典: `e2e-test-harness/index.astro:26-67`) | 本番導線からは一切リンクされないテスト専用ページ |

## 4. ビルド時: マスターデータ生成

`npm run build:master-data` → `scripts/build-master-data/build.mjs`。既定で`vendor/jpoke`を参照し、`JPOKE_DIR`/`JPOKE_PYTHON`で上書き可能(出典: `build.mjs:32-43`)。

1. **オートコンプリート/検索詳細JSON**: `jpokePython extract_autocomplete.py <jpokeSrcDir> <autocompleteOutDir> <detailOutDir>`(出典: `build.mjs:75-85`)
2. **Pyodide wheel**: `jpokePython -m build --wheel --outdir <tmp>`を`vendor/jpoke`直下で実行し、`public/master-data/pyodide/wheels/*.whl`へコピー。既存wheelは事前に全削除(出典: `build.mjs:87-116`)

### 生成物のパスとスキーマ(`extract_autocomplete.py`)
| 出力パス | 生成関数 | フィールド | 出典 |
|---|---|---|---|
| `public/master-data/autocomplete/pokemon.json` | `build_pokemon` | `name, dexNo, imageId, forme, types[]` | `extract_autocomplete.py:116-175` |
| `public/master-data/autocomplete/moves.json` | `build_moves` | `name, type, category, hits?:[min,max]`(連続技のみ) | 同:178-207 |
| `public/master-data/autocomplete/abilities.json` | `build_abilities` | `name` のみ | 同:252-254 |
| `public/master-data/autocomplete/items.json` | `build_items` | `name, spritePath`(解決不可なら`null`) | 同:295-322 |
| `public/master-data/detail/pokemon.json` | `build_pokemon_detail` | `name, types[], baseStats[6], abilities[], learnset[], preEvolution` | 同:210-227 |
| `public/master-data/detail/moves.json` | `build_moves_detail` | `name, type, category, power, accuracy, pp, priority, critRatio, target` | 同:230-249 |

- `imageId`の解決順位: ①`ja_to_id_map.json`の`sections.pokemon.by_ja_name`(jpoke由来) → ②`extract_autocomplete.py`内蔵の手書き上書き表`_IMAGE_ID_OVERRIDES`(2026-07-25時点のPokeAPI実測値) → ③`dexNo`にフォールバック(この場合スプライトはベース種族画像になる)(出典: 同:52-175)
- `moves.json`の`hits`は`ps-champ-ja/moves.json`ではなく**`MoveData.multi_hit`**(jpokeのダメージ計算エンジン自体が参照する一次情報源)から取る(出典: 同:185-193)
- `items.json`の`spritePath`解決は`ja_to_id_map.json`(item_jpoke優先→item全量にフォールバック)→`id_map.json`→`item_sprite_subdir_map.json`の順(出典: 同:257-292、参照実装 `vendor/jpoke/.../pokeapi.py:120-126,186-207`)

`src/pages/api/search.ts`はこれら4つのautocomplete JSONをビルド時にVite静的importでバンドルする(実行時fetchではない、出典: `api/search.ts:22-25,36-41`)。

### learnset は「チャンピオンズで覚えられる技」であって全世代の技ではない(誤解の常連)

`detail/pokemon.json` の `learnset` は `jpoke.data.LEARNSETS` 由来で、その実体は **`vendor/jpoke/src/jpoke/data/ps-champ-ja/learnsets.json`(1.8MB、1288種)**(出典: `vendor/jpoke/src/jpoke/data/learnset.py:15`、`extract_autocomplete.py:223`)。**ポケモンチャンピオンズというフォーマット固有の習得データ**であり、本編シリーズ全世代の技マシン・遺伝技を網羅したものではない。

- 結果として、**技の総数716に対し「覚えるポケモンが0種」の技が218件(30%)存在する**(2026-07-27にCoordinatorが全件集計して確認)。例: `トリプルキック`、`あくうせつだん`、`あやしいかぜ`、`あわ`、`アロマセラピー`。
- **これはデータの欠落ではない。** 実例として `サワムラー` は在籍していて learnset を67件持つが、その中に `トリプルキック` は無い。「種は居るのに技が紐づいていない」ので**欠落に見えるが、フォーマットの仕様である**。
- **UIで「0種」と出すときは断定しないこと。** `/moves/[name]` は「**現在のデータでは**、この技を覚えるポケモンはいません。」という限定つきの文言を使っている(`src/pages/moves/[name].astro`)。ここを「誰も覚えません」と断定すると嘘になりうる。
- 逆に `moves.json`(716件)は**エンジンが持つ技の全量**なので、「技は存在するが、このフォーマットでは誰も使えない」という組み合わせが正常に起こりうる。

## 5. 移植・派生ロジック(jpoke更新で追随が要る箇所)

| poke-commons側 | jpoke参照実装 | 何を移植したか |
|---|---|---|
| `src/lib/sprite-urls.ts` | `vendor/jpoke/src/jpoke/utils/pokeapi.py` | `TYPE_NAME_TO_ID`(19タイプの和名→PokeAPI ID)を**丸ごと転記**(出典: `sprite-urls.ts:14-36`、参照元 `pokeapi.py:46-68`。2026-07-27時点で内容一致を確認済み)。`TYPE_SPRITES_DIR`(`types/generation-ix/scarlet-violet`)も同様に転記(出典: `sprite-urls.ts:9-12`、`pokeapi.py:42-44`)。`itemImageUrl()`はビルド時に解決済みの`spritePath`を受け取るだけで、`pokeapi.py`の`_resolve_pokeapi_id`相当のID解決はしない。 |
| `src/lib/pokemon-master-data.ts` | 同上(間接) | `spriteUrl()`/`officialArtworkUrl()`が`https://raw.githubusercontent.com/.../pokemon/{imageId}.png`等のURLテンプレートを**独自にハードコード**(出典: `pokemon-master-data.ts:47-53`)。`sprite-urls.ts`とは別の文字列リテラルで、`pokeapi.py`の`get_pokemon_image_url`の`path_by_kind`辞書(出典: `pokeapi.py:94-115`)とは共有コードなし。 |
| `src/lib/opponent-notes-validation.ts` | `pyodide-engine.ts`の`PokemonSpec`/`FieldSpec`/`SequenceAttack` | `OPPONENT_BUILD_KEYS`/`OPPONENT_FIELD_KEYS`という許可キーのホワイトリストを手書きで維持(出典: `opponent-notes-validation.ts:152-179`)。状態異常名・天候名などの**値の妥当性はjpoke側の定義を正とし、文字列型チェックのみに留める**(二重管理を避ける意図的な設計、出典: 同:69-70) |
| `src/pages/api/search.ts` | `jpoke.data`(間接、`extract_autocomplete.py`経由) | jpokeを直接参照せず、ビルド生成済みJSONのみを使う |

## 6. テスト: jpokeネイティブ実行との一致確認

**(2026-07-28 UI改善ラウンド22 22-E-1/22-E-2で全面的に作り直した。以下は現行版の記述。)**

`tests/e2e/fixtures/generate_expected.py`が`vendor/jpoke/src`をネイティブPythonで実行し、3種類の期待値ファイルを事前生成する(既定ソースは`vendor/jpoke/src`、`JPOKE_SRC_DIR`で上書き可、出典: `generate_expected.py:31-37`)。

| 期待値ファイル | ケース定義 | 対応するTS関数 | 比較するPlaywright spec |
|---|---|---|---|
| `expected.json` | `cases.json`(10件) | `calcDamages()` | `damage-calc.spec.ts` |
| `expected-stats.json` | `stats-cases.json`(6件) | `calcStats()` | `stats-lethal-sequence.spec.ts` |
| `expected-lethal-sequence.json` | `lethal-sequence-cases.json`(8件) | `calcLethalSequence()` | `stats-lethal-sequence.spec.ts` |

**旧実装との違い(重要な設計変更)**: 以前の`generate_expected.py`は`pyodide-engine.ts`の`BOOTSTRAP_PYTHON`(`_build_pokemon`/`calc_damages_json`等)を**手書きで複製**していた。この複製が古くなり、`boosts`(ランク補正)を一切反映しない状態のまま長期間放置されていたことが判明した(下記「発見した乖離」参照)。2026-07-28に、複製をやめて**`pyodide-engine.ts`から`BOOTSTRAP_PYTHON`のPythonソース文字列をそのまま抽出し`exec()`する方式**に変更した(`generate_expected.py`の`_extract_bootstrap_python()`/`_load_bootstrap_namespace()`)。これにより、ブラウザ(Pyodide)側とネイティブ側が**文字通り同一のPythonコード**を実行するようになり、複製による乖離が構造的に起こらなくなった(「片方はPyodide用・片方はネイティブ用」という実行環境の違いは残るが、ロジックの二重管理は解消した)。抽出はBOOTSTRAP_PYTHON文字列内にバッククォートが1つも無いこと(`pyodide-engine.ts`側の既存の制約と同じ)を前提にした単純な文字列切り出しで実装している。

**発見した乖離(修正前、22-E-2の調査結果)**: 旧`generate_expected.py`の`_build_pokemon`/`calc_damages_json`は`BOOTSTRAP_PYTHON`の**古い版**の複製で、以下が未反映だった:
- `boosts`(ランク補正)が一切反映されない(`spec.get("boosts")`が存在しなかった)
- 状態異常(`ailment`)・テラスタル(`terastallized`)・**揮発性状態(`volatiles`、UI改善ラウンド20 20-R3で`_apply_battle_only_state`に追加)**のいずれも未反映(旧版には`_apply_battle_only_state`関数自体が存在しなかった)
- 連続ヒット回数(`hitCount`)が未反映(`calc_damages_json`の引数に無かった)
- 技解決のフォールバックが`active_attacker.moves[0]`(無関係な技への暗黙フォールバック)だったが、現行`_resolve_move`は`Move(move_name)`を新規生成する
- `calc_stats_json`/`calc_lethal_sequence_json`に相当する関数が旧版には**存在しなかった**(§7参照)

`tests/e2e/fixtures/cases.json`(既存10件)はこれらの条件を使っていなかったため、修正前でも既存テストへの実害は無かった(実測: 抽出方式に切り替えた後も`expected.json`はバイト単位で不変だった)。しかし`boosts`等を使うケースが追加された瞬間、期待値が実際の挙動とずれたまま「一致」と誤判定される状態だった。**新しいfixture(`stats-cases.json`/`lethal-sequence-cases.json`)は意図的に`boosts`/`ailment`/`terastallized`/`volatiles`/`hitCount`/per-attack上書きを網羅しており、この種の乖離を今後も検出できる。**

`tests/e2e/damage-calc.spec.ts`が実ブラウザ(Chromium)上の`calcDamages()`と`expected.json`を完全一致比較する(出典: `damage-calc.spec.ts:1-12,90-101`)。`tests/e2e/stats-lethal-sequence.spec.ts`が同様に`calcStats()`/`calcLethalSequence()`と`expected-stats.json`/`expected-lethal-sequence.json`を完全一致比較する(浮動小数点の`probability`も含め完全一致で通ることを実測済み。Pyodide=WASM上のCPythonとネイティブCPythonのIEEE754倍精度演算がbit単位で一致することを前提にしており、2026-07-28時点で実際に一致することを確認した)。

**ブラウザ側での関数公開(`e2e-test-harness/index.astro`)**: 元々`window.__pyodideEngine__`には`calc`(=`calcDamages`)しか公開されていなかった。22-E-1でこのページに`calcStats`/`calcLethalSequence`を追加公開した。**このページは`src/pages/e2e-test-harness/`配下だが、Playwright専用のテストハーネス(本番導線に一切リンクされない)であり、UI改善ラウンド22の他エージェント(α/β/γ/ε)の担当ファイルとは重複しない。**

## 7. jpoke更新で「黙って壊れる」場所(重要度順)

型エラーにならず実行時に**間違った値**が出る箇所。上から順にリスクが高い。

1. **`STATS[1:6]`のインデックス対応**(`pyodide-engine.ts:434-437`付近): `jpoke.types.literals.Stat`の要素順(現在`["hp","atk","def","spa","spd","spe",...]`、出典: `vendor/jpoke/src/jpoke/types/literals.py:56`)が変わると、`boosts`配列の値が別のステータスに適用される。TypeScript側は文字列インデックスを検証しないため、コンパイルは通り、ダメージ計算の結果だけが静かにおかしくなる。
2. **`LethalHitResult.__add__`/`subtract_dist`の内部挙動への依存**(`calc_lethal_sequence_json`全体): 打点とHPを分けて集計するロジック・単調性クランプは、jpokeの`jpoke/core/lethal.py`の非公開実装詳細(`_lethal_loop`の打ち切り仕様、`__add__`のダメージ/HP合成規則)への深い依存。ここが変わっても型は壊れず、累計致死率・打点の数値だけがずれる。**(2026-07-28時点)** §6の一致確認(`stats-lethal-sequence.spec.ts`)がこの経路をカバーするようになったため、この種の変化はテストで検出できるようになった。
3. **~~`tests/e2e/fixtures/generate_expected.py`のBOOTSTRAP_PYTHON複製が古い~~ → 2026-07-28 UI改善ラウンド22 22-E-1/22-E-2で解消済み**(§6参照)。複製をやめてBOOTSTRAP_PYTHONを直接execする方式に変更し、`calcStats`/`calcLethalSequence`の一致確認も追加した。`vendoring更新手順(VENDORING.md`手順4)の前提「jpoke更新後にnpm testで検出できる」は、`npm run test:e2e`(`test:e2e:update-fixtures`で期待値再生成後)まで含めれば、`/box/[id].astro`が実際に使う計算経路(`calcStats`/`calcLethalSequence`)もカバーするようになった。
4. **`extract_autocomplete.py`の`_IMAGE_ID_OVERRIDES`**: PokeAPI実測値の手書き表。jpokeの`ja_to_id_map.json`が該当フォルムを解決できるようになっても、この表が優先されず古い値のまま残り得る(コード上の優先順位は①`ja_to_id_map.json`が先なので実際には②より①が優先されるが、①側のキー名表記がわずかに変わると①で解決できず②の古い値にフォールバックしてしまう、という形で顕在化する)。
5. **`sprite-urls.ts`/`pokemon-master-data.ts`のURLテンプレート**: `pokeapi.py`のディレクトリ構成・拡張子が変わっても、これらのTS側文字列リテラルは自動追随しない。結果は例外ではなく画像404(表示崩れ)として現れる。

## 8. Pyodide経由であることに起因する制約

- **初期化が重い**: Pyodideランタイム(wasm)+ micropipによるjpoke wheelインストールを経る。E2Eテスト(`tests/e2e/damage-calc.spec.ts`)は初期化+10ケース分の直列計算を`test.setTimeout(180_000)`(180秒)に設定している(既定の`playwright.config.ts`のグローバル`timeout: 120_000`より延長、出典: `damage-calc.spec.ts:78`、`playwright.config.ts:24`)。
- **Python↔JS値変換**: `pyodide.toPy()`で明示変換したPyProxyオブジェクトのみを引数に渡し、使用後は`.destroy()`で破棄が必須(破棄漏れはPython側メモリリーク、出典: `pyodide-engine.ts:999-1004`)。戻り値はPython側で`json.dumps()`した文字列をJS側で`JSON.parse()`する方式で、PyProxyをそのままJSオブジェクトとして扱う経路は使っていない(出典: `pyodide-engine.ts:556,565,882,997,1039,1100`)。
- **コード注入対策**: BOOTSTRAP_PYTHONはビルド時に確定した固定文字列で、ユーザー入力を文字列結合しない。計算対象データは常に関数引数(`toPy()`変換済み)として渡す(出典: `pyodide-engine.ts:353-358`)。
- **~~wheelバージョンのハードコード~~ → 2026-07-28 UI改善ラウンド22 22-E-3で解消済み**(§2参照): `JPOKE_WHEEL_URL`は`wheel-manifest.json`(build.mjsが実際に生成したファイル名で書き出す)からのVite静的importで組み立てるようになった。`vendor/jpoke`更新時は`build.mjs`の生成物(=`npm run build:master-data`を実行すること)だけで追随し、`pyodide-engine.ts`の手動更新は不要になった。
- **オフラインキャッシュとバージョン更新の相互作用**: `public/pyodide-sw.js`は`/master-data/pyodide/`配下をcache-firstで保存する(出典: `pyodide-sw.js:9`)。wheelファイル名にバージョンが含まれるため、jpoke更新でファイル名が変われば新URLとして扱われキャッシュミス→再取得されるが、`CACHE_NAME`(`"pyodide-engine-v1"`)自体は更新時に変更されない(出典: `pyodide-sw.js:8`)ため、キャッシュの世代管理は「URLが変わることに依存」している。**この構造は22-E-3後も変わらない**(`wheel-manifest.json`自体も`/master-data/pyodide/`配下なのでcache-first対象だが、`wheel-manifest.json`はHTMLに埋め込まれるのではなくビルド時にJSバンドルへインライン化されるため、SWのキャッシュ対象としては現在も参照されない。実行時に`wheel-manifest.json`をfetchする経路が無いことに変わりはない)。
- (未確認) Pyodide上で使えないPython機能(C拡張モジュール依存など)がjpoke側に将来追加された場合にどう壊れるかは、現状jpokeが「ランタイム依存ゼロの純Python」(出典: `extract_autocomplete.py:4-5`)であるため未検証。
