# 揺れの原因パターンと定石の直し方

`--cls` が出した犯人セレクタと `dx/dy/dw/dh` から、まずこの表に当てはまるかを見る。**当てはまれば調査を省略して直してよい。**

## 判断の順番

1. **その要素は最初から存在しているか?** 無いなら「後から生えて押した」パターン(A/B)
2. **存在するが寸法が変わったか?** なら「中身が入って伸びた」パターン(C/D/E)
3. **位置だけ変わったか?** なら「別の要素に押された」= 犯人は上/左の兄弟。そちらを追う
4. **DOMごと動いたか?** なら「移設」パターン(F)

---

## A. `hidden` / `display: none` の要素が解決後に現れる

**症状**: `dx` か `dw` が +2〜8px 程度。`value` は 0.00 と出ることも多い(小さい要素なので)。

**例**: 技タイプ色バー。`[hidden] { display: none }` のため幅0 → 解決後に3px。

**直し方**: **要素を最初からレイアウトに置き、「未確定」を塗りの無さで表現する。**

```css
/* ✗ 幅が 0 → 3px と変わる */
.card-move-type-bar[hidden] { display: none; }

/* ✓ 常に 3px を占め、色が付くかどうかだけが変わる */
.card-move-type-bar { flex: 0 0 3px; width: 3px; background-color: transparent; }
```

JS側は `el.hidden = false` ではなく `el.style.backgroundColor = …` / クラス付与だけにする。

**やってはいけないこと**: バーを細くする・消す等、**見た目やタップ領域を縮めて解決しない**(→ `feedback_no_shrink_tap_targets`)。

## B. 一時的な文言が出入りする

**症状**: ボタンや状態表示の周辺が数百ms〜数秒だけずれて戻る。`startTime` が操作直後。

**例**: `button.textContent = "登録中…"`、`statusTextEl.textContent = "保存中…"`。

**直し方**: 2択で判断する。

- **廃止**: 代替のフィードバック(ボタンの `disabled`、完了時の表示)があるなら文言の差し替え自体をやめる
- **残すが揺らさない**: 進行状況に意味があるなら、**その要素に入りうる全文言のうち最長のものが収まる `min-width` / `min-height` を対象別CSSに置く**。要素をレイアウトから消さない(`display` ではなく `visibility` / `opacity` で切り替える)

## C. 非同期で計算した値がテキストに入って幅が伸びる

**症状**: `dx` が負で `dw` が正(右詰めの数値が左へ伸びた)。`startTime` が Pyodide 初期化やAPI応答の後。

**例**: 実数値(`#stat-hp` 等)が `-` → `175` になる。

**直し方**:

- 数値が入る枠に **`min-width` を桁数ぶん確保する**(`ch` 単位、または `font-variant-numeric: tabular-nums` + 固定幅)
- プレースホルダを「値と同じ文字数のダミー」にして、寸法を先に確定させる
- 右詰め・中央寄せなら、伸びる方向が隣の要素を押さないレイアウト(grid の固定トラック等)にする

## D. 画像の寸法が読み込み完了まで確定しない

**症状**: `dh` が正で、画像より下が押し下がる。`startTime` が画像リクエストの完了時刻。

**直し方**: `<img>` に **`width` / `height` 属性を必ず入れる**(CSSで実寸を変えていても、比率が確定するので予約される)。`onerror` でフォールバック画像に差し替える箇所は、**フォールバック先も同じ寸法**であることを確認する(立ち絵は champion sprite → 公式絵。→ `feedback_icon_champion_sprite_priority`)。

背景画像やCSSの `background-image` で描いているなら、コンテナ側に `aspect-ratio` を置く。

## E. 折りたたみ・条件付き要素の初期状態がSSRとhydrationでずれる

**症状**: `dh` が数十px。`startTime` が DOMContentLoaded 直後。

**例**: ゲストは localStorage を読めないため SSR では空で描かれ、hydration 後に中身が入る。

**直し方**:

- SSR側でプレースホルダを**実物と同じ寸法**で描く(`createMobilePreviewPlaceholder` と `mobile-pokemon-preview.css` が既にこの方針。コメントを読むこと)
- どうしても寸法を先に決められないなら、**確定するまで領域ごと `visibility: hidden` にして、確定後にまとめて出す**(`MobilePokemonPreview.astro` の `<style is:inline>#mobile-training-ui { visibility: hidden; }` が実例)。ただし「白いまま待つ時間」が伸びるので、E以外では使わない

## F. JSがDOMを別の場所へ移動させる

**症状**: `dh` が数十px、しかも**増えてから減る(またはその逆)の2連発**。移設元と移設先の両方が動く。

**例**: `src/lib/box-id/mobile-edit-tabs.ts` が、900px未満で隠れるトップバーから「保存状態・非公開・削除」を `#mobile-edit-actions` へDOMごと移設している。

**直し方**:

- **移設をやめて、最初から置きたい場所に描く**(表示・非表示はCSSのメディアクエリで切り替える)のが本筋。イベント配線を張り直したくないという理由で移設しているだけなら、DOMを2箇所に置かずCSSで解決できないか先に検討する
- 移設が避けられないなら、**移設元・移設先の両方にあらかじめ同じ高さを予約する**か、移設が終わるまで両方を `visibility: hidden` にする

## G. スクロールバーの出現でコンテンツ幅が変わる

**症状**: ページ全体の `dx` が一律 ~15px。

**直し方**: `html { scrollbar-gutter: stable; }`。**このアプリはモバイル専用方針なので優先度は低い**(→ `project_mobile_only_focus`)。

## H. Web フォント読み込みでテキストの寸法が変わる

**症状**: テキストを含む要素が広範囲に `dw`/`dh` 変化。`startTime` がフォント取得完了時。

**直し方**: `font-display: optional`、またはフォールバックフォントのメトリクスを `size-adjust` で合わせる。**アプリ側で消せない場合は dashboard の note に残して🟡で許容してよい。**

---

## 直すときの共通ルール

- **見た目を変えない。** 揺れを消すために要素を小さくしたり、タップ領域を縮めたりしない(→ `feedback_no_shrink_tap_targets`)
- スタイルは対象別CSSファイルへ。テンプレートの `style` 属性・分散した `<style>` は禁止(ルート `CLAUDE.md`「スタイル定義」)。**唯一の例外は E の `<style is:inline>` による初期非表示**で、これは「パース時点で効かないと意味がない」ため既存実装が意図的に採っている
- `prefers-color-scheme` 分岐を新規に足さない(→ `project_dark_mode_only`)
- 直したら**同じCSS/コンポーネントを共有する他の画面も測り直す**(回帰確認)
