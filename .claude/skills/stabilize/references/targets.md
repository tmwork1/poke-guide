# 計測対象の一覧

`stabilize` skill が「すべてのページ・タブ・モーダル」を漏れなく測るための台帳。**新しい画面・タブ・モーダルを追加したらここに1行足す。** 実測値そのものは書かない(それは `docs/stabilize/dashboard.md` 側)。

共通の前提: `npm run dev` 起動済み。既定の計測条件は **`--size 390x844 --theme dark --repeat 3`**(モバイル専用方針・ダーク一本化のため)。`<id>` は実データのUUIDに置き換える。

## 1. ページ遷移直後(全ページ必須)

`--from` を付けて実際の導線を再現する。付けない素の遷移も1回は測る。

| # | 対象 | probe |
|---|---|---|
| P-01 | ホーム | `--page home` |
| P-02 | ボックス一覧 | `--page box` |
| P-03 | ポケモン編集(育成タブ) | `--from box --page box/<id>` |
| P-04 | ポケモン編集(ダメージタブ) | `--from box --page "box/<id>?tab=damage"` |
| P-05 | バトルデータ | `--page "box/data?pokemon=<id>"` |
| P-06 | 上位チーム | `--page "box/ranked?pokemon=<id>"` |
| P-07 | 相性 | `--page "box/matchup?pokemon=<id>"` |
| P-08 | チーム一覧 | `--page team` |
| P-09 | チーム詳細(編成タブ) | `--from team --page team/<id>` |
| P-10 | チーム詳細(ポケモンタブ) | `--from team --page "team/<id>?tab=pokemon"` |
| P-11 | チーム詳細(データタブ) | `--page "team/<id>?tab=data"` |
| P-12 | データハブ | `--page data` |
| P-13 | すばやさ早見表 | `--page data/speed-chart` |
| P-14 | 上位ビルド | `--page data/top-builds` |
| P-15 | ダメージ計算 | `--page damage-calc` |
| P-16 | 検索 | `--page search` |
| P-17 | 共有ページ | `--page share/<slug>` |
| P-18 | ボックス一覧(ゲスト) | `--page box --guest` |
| P-19 | ポケモン編集(ゲスト) | `--page box/<id> --guest` |

## 2. タブ切替(操作後の揺れ)

`--mark` でフェーズを区切ってから操作する。**タブがページ遷移(`<a href>`)の場合は 1. の遷移計測と同じなので重複して測らない**(`--mark` を打っても遷移でウィンドウが作り直され、マークは消える)。ここに載せるのは**同一ページ内でDOMを差し替えるタブ**だけ。

| # | 対象 | probe |
|---|---|---|
| T-01 | ポケモン編集 育成→ダメージ(同一ページ内切替) | `--page box/<id> --mark tab-damage --click "[data-mobile-tab=damage]"` |
| T-02 | チーム詳細 編成→ポケモン | `--page team/<id> --mark tab-pokemon --click "[data-mobile-tab=pokemon]"` |
| T-03 | チーム詳細 編成→データ | `--page team/<id> --mark tab-data --click "[data-mobile-tab=data]"` |
| T-04 | データハブのタブ切替 | `--page data --mark tab-switch --click "<DataHubTabs.astro のタブ>"` |

## 3. モーダル・ダイアログ開閉

**⚠️ `/box/[id]` `/team/[id]` のモーダルは、開閉だけで自動保存が走るものがある。** 各行の「安全性」を確認してから測る。未確認のものは**まず `--click` せずにコードを読んで、保存が走らないことを確かめる**(→ `.claude/skills/ui/references/pitfalls.md`)。

| # | 対象 | 開くトリガ | 安全性 |
|---|---|---|---|
| M-01 | 種族選択 | `#species-select-trigger-button` / `#pokemon-preview-species-trigger` | 開くだけなら安全(選択すると保存が走る) |
| M-02 | もちもの選択 | `#item-dropdown-button` / `#pokemon-preview-item-trigger` | 同上 |
| M-03 | テラスタイプ選択 | `#tera-dropdown-button` | 同上 |
| M-04 | ステータス調整 | `#pokemon-preview-stats-trigger` | 要確認 |
| M-05 | 耐久調整 | `#bulk-adjust-button` | 要確認 |
| M-06 | すばやさ調整 | `#speed-adjust-dialog` のトリガ | 要確認 |
| M-07 | ダメージ詳細パネル | `.damage-column` のタップ(→ `reference_shot_damage_detail_panel`) | 要確認 |
| M-08 | わざ選択 | `#move-<slot>` へのfocus | 要確認 |
| M-09 | ダメージ計算のボックス選択 | `#damage-calc-pokemon-button` | 安全(読み取りのみ) |
| M-10 | ダメージ計算のチーム選択 | `#damage-calc-team-button` | 安全(読み取りのみ) |
| M-11 | ダメージ計算のもちもの選択 | `#damage-calc-item-select-dialog` のトリガ | 安全(読み取りのみ) |
| M-12 | ゲストログイン誘導 | ゲストモードで保存操作 | 安全 |

計測例:

```bash
npm run probe -- --page damage-calc --size 390x844 --theme dark --cls \
  --mark open-box-select --click "#damage-calc-pokemon-button"
```

## 4. 非同期データ差し込み後の揺れ(操作なし)

初期表示から数秒のあいだに遅れて入る内容。1. のページ計測に含まれるが、**遅い経路(Pyodide初期化・OP.GG使用率・スプライト画像)は `--repeat 3` でも揺らぎが大きい**ので、疑わしいときは `--repeat 5` で測る。

| # | 対象 | 備考 |
|---|---|---|
| A-01 | 実数値(jpoke/Pyodide 経由) | ポケモンプレビュー・ボックスカード・チームカード |
| A-02 | 技タイプ色バー | `loadMoveTypeMap()` の解決待ち |
| A-03 | 立ち絵(champion sprite → 公式絵フォールバック) | `width`/`height` 指定の有無を確認する |
| A-04 | もちものアイコン | 同上 |
| A-05 | OP.GG使用率 | **devでは空になる**(→ `project_opgg_usage_dev_server_stall`)。`npm run preview` で測る |

## 未計測を減らすためのルール

- `src/pages/` にページを足したら 1. に行を足す
- 同一ページ内でDOMを差し替えるタブを足したら 2. に行を足す
- `src/components/**/…Dialog.astro` を足したら 3. に行を足す
- 「後から非同期で埋まる表示」を足したら 4. に行を足す
