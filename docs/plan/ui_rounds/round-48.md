# UI改善ラウンド48

[← 索引](../ui_plan.md)

## ラウンド48の要件(2026-07-30 ユーザー指示第32弾)

ユーザーの言葉(原文、「個体編集画面 ダメージカード」節):
> - N発目の数字の右側の縦棒を削除
> - 結果表示の上の横点線を削除
> - 技カード削除ボタンの丸枠を非表示にして、ボタンをもう少し右上に配置
> - 相手ビルドの情報を種族ごとにローカルに記録しておき、次に同じ種族をビルドする際にデフォルト値として設定するようにする

「共通」「ボックス画面」「個体編集画面 ヘッダー」「個体編集画面 左サイド」の各節は空欄(指示なし)。今回は `/box/[id]` のダメージ計算カードのみが対象。

対象実装ファイルは2つに集約されている(Explore調査済み):
- `src/components/box-id/DamageCalcSection.astro` — `.card-damage` のCSS/HTML/`<script>`本体
- `src/lib/box-id/damage-calc.ts` — 状態管理(`DamageRowState`)・保存/読込ロジック
- 呼び出し元 `src/pages/box/[id].astro` は変更不要(見込み)

## Step3: 計画への記録(ユーザー直接指示のため新規レビュアー講評は行わない)

### 優先度A(必ず直す。すべてユーザー直接指示)

- **A-1 「N発目」の右側の縦棒を削除**: 【問題】`DamageCalcSection.astro:1420-1431` `.damage-column-order-label`(技カード左端の番号帯)に `border-right: 1px solid var(--color-border);`(1430行目)があり、番号と技名/結果の間を縦棒で区切っている。【提案】この `border-right` 宣言を削除する。番号帯の幅(`width: 1.4em`)・中央寄せは維持し、区切りは余白(既存の `gap`/`padding`)だけで表現する。削除後、番号と技名の間が詰まりすぎて見える場合は実装者判断で `gap` を微調整してよい(新しい罫線は足さない)。

- **A-2 結果表示の直上の横点線を削除**: 【問題】`DamageCalcSection.astro:1562-1569` `.damage-column-footer`(技カード最下段、技ごとのダメ・致死率を表示する `.damage-column-result` の親)に `border-top: 1px dashed var(--color-border);`(1568行目)がある。**ラウンド34で相手ビルド箱側の `.damage-row-total` の点線は既に撤去済みだが、この技カード単体側の点線は今回が初の撤去対象。**混同しないこと。【提案】`border-top` 宣言を削除する。`padding-top: 0.15rem` は区切りの余白として残してよい(実装者判断、詰まりすぎるなら微調整可)。

- **A-3 技カード削除ボタンの丸枠を非表示にし、位置をもう少し右上に**: 【問題】`DamageCalcSection.astro:1680-1700` `.damage-column-remove-button`(1技カード単位の削除ボタン、`×`)は共通クラス `.damage-row-icon-button`(28px円形・`box-shadow: var(--shadow-sm)`)を流用し、さらに独自に `background: var(--color-surface); border: 1px solid var(--color-border);` を持つ(1685-1686行目)ため、はっきりした丸いボタン枠に見える。位置は `position: absolute; top: var(--space-2); right: var(--space-2);`(1681-1683行目、技カード右上、8px inset)。
  【提案】
  1. `#opponent-notes-section .damage-column-remove-button` に対して `background: transparent; border: none; box-shadow: none;` を明示上書きし、丸い枠・背景・影を消す(**共通クラス `.damage-row-icon-button` 自体は編集しない** — カード全体の削除ボタン `.damage-row-delete-button` や折りたたみボタン `.damage-row-collapse-toggle-button` が同じクラスを共有しているため、書き換えるとそちらにも波及する。このセレクタ限定の上書きに留める)。
  2. hover時の赤背景表示(`:hover:not(:disabled)` ルール、1689-1693行目)は維持してよい(押せることが分かるフィードバックとして必要。ホバー時だけ背景が付くのは「常時は枠なし」という要件と矛盾しない)。
  3. クリック領域(28px)自体は縮めない(視認性より押しやすさを優先。枠を消すだけで領域は変えない)。
  4. 位置を「もう少し右上」に: `top` / `right` の inset を `var(--space-2)`(8px)より小さい値(実装者判断、例: `2px`前後)に詰めるか、技カードの角によりかかるよう調整する。技名入力欄・ヒット数入力と重ならないことを実測で確認する(`.damage-column.has-remove-button .damage-column-move-row` のpadding-right確保ロジック(1515-1523行目)と整合させる。位置を変えても技名行との重なりが発生しないか実機確認必須)。

### 優先度A(機能追加、ユーザー直接指示)

- **A-4 相手ビルドの情報を種族ごとにローカル記憶し、次に同じ種族を入力したときデフォルト値として適用する**:
  【背景】現状、相手の種族名(`row.name`)を含む「相手ビルド」(`nature`/`abilityName`/`itemName`/`teraType`/`evs`)はDB(`opponent_notes.opponent_build`)にカード単位で保存されるのみで、**同じ種族を別のカードで再入力するたびに性格・特性・持ち物・テラス・努力値をゼロから打ち直す必要がある**。ユーザーは「ローカルに記録」と明示しているため、**DBへの新規カラム追加ではなく、ブラウザの `localStorage` を使う**(このプロジェクトに `localStorage` の使用例は現状ゼロ件、Exploreで全文grep確認済み。新規実装になる)。

  【対象データ】`nature`(または`natureUp`/`natureDown`の組)・`abilityName`・`itemName`・`teraType`・`evs`(6要素配列)の5項目。技名(`moveName`)・ヒット数・詳細設定(天候/ランク等)は技カード単位の情報であり対象外(相手ビルドの箱に属する情報だけを記憶する)。

  【保存タイミング】`damage-calc.ts:1332` の `saveRow(row: DamageRowState)`(既存のデバウンス保存関数、相手ポケモン名が非空になった時点で呼ばれる)が呼ばれる際、`row.name` が非空なら、保存対象の5項目を `localStorage` にキー `row.name`(種族名そのもの、trim済み)で書き込む。既存の保存ロジック(DB POST/PUT)に相乗りする形で、保存が起きるたびに最新のビルドで上書きする(=「最後に使ったビルド」が種族ごとの既定値になる)。

  【適用タイミング】`damage-calc.ts:2390-2392` 付近、種族名入力欄(`nameInput`)の `change` イベントハンドラ(既存の `rebuildRowAbilityOptions` / `applyRowMegaStoneAutofill` と同じ呼び出し位置)に処理を追加する。種族名が確定した時点で、**その行の相手ビルド5項目がすべて未設定(nature未設定・abilityName空・itemName空・teraType空・evs全て0)の場合に限り**、`localStorage` に該当種族のプリセットがあれば読み込んで `row.nature`(および `natureUp`/`natureDown`)・`row.abilityName`・`row.itemName`・`row.teraType`・`row.evs` に適用し、対応する入力欄・セレクトの表示を更新した上で `recalcRow()` + 保存(`scheduleRowSave`相当、既存の仕組みに乗せる)を呼ぶ。
  - **「すべて未設定の場合に限り」が必須の条件**: 既に値が入っている行(DBから読み込んだ既存カードなど)に対して種族名を変更したときに、ユーザーが既に設定した値を勝手に上書きしてはいけない。新規追加した空の行に初めて種族名を入れたときだけ発動させる。
  - `localStorage` が使用不可(プライベートブラウジング等で例外を投げる環境)でもページ全体が壊れないよう、読み書きは `try/catch` で囲み失敗時は無視する(この機能が使えないだけで他の動作に影響しないこと)。
  - キー設計は実装者判断でよいが、他機能と衝突しない名前空間(例: `poke-commons:opponent-build-preset:<種族名>`)にする。

### 維持すべき点(壊さないこと)
- `.damage-row-icon-button` 共通クラス自体(カード全体削除ボタン・折りたたみボタンが依存する)。A-3はこのクラスを編集せず、`.damage-column-remove-button` 個別のセレクタで上書きする。
- 技カード削除ボタンの「常時表示(ホバー限定にしない)」という確立済み方針(ラウンド43決定、1677-1679行目コメント参照)。
- 相手ビルドの入力欄自体のDB保存契約(`opponent_notes.opponent_build`)。A-4は保存経路に「ローカルにも書く」処理を足すだけで、既存の保存/読込ロジックは変更しない。
- `.damage-column`/`.damage-row-total-result`等、pitfalls.md「壊してはいけないもの」節のクラス名。

## 追加指示(2026-07-30、A-1〜A-4実装中にユーザーから追加)

ユーザーの言葉(原文): 「ニックネーム入力欄の枠も実線にする」

【背景】`src/components/box-id/LeftPanel.astro:504` `#edit-form input:placeholder-shown:not(:focus) { border-style: dashed; background: transparent; }` により、`#edit-form` 配下の全input(`#nickname`含む)は**値が空でplaceholder表示中は破線+透明背景**になる(「未設定であることを示す」既存の共通仕様、24-L3等で他項目にも横展開済み)。ニックネームが未設定の個体では `#nickname`(160行目、`placeholder="ニックネーム"`)がこの破線スタイルの対象になっている。ユーザーはこれを実線に戻すよう指示している(理由の言及なし。「他の未設定項目と同じ扱いにしない」というユーザー判断として受け止める)。

対象は `/box/[id]` 個体編集画面の左サイド(`LeftPanel.astro`)であり、A-1〜A-4(ダメージカード担当、`DamageCalcSection.astro`/`damage-calc.ts`)とはファイルが別なので並列実装可能。

### 優先度A(追加、ユーザー直接指示)
- **A-5 `#nickname` 入力欄は空欄時も枠線を実線のままにする**: 【問題】上記のとおり `#edit-form input:placeholder-shown:not(:focus)` の共通ルールにより、ニックネーム未設定の個体では `#nickname` が破線+透明背景になる。【提案】`LeftPanel.astro` の `<style>` 内、既存の破線ルール(504-507行目)の**後**に、`#nickname` だけを対象にした上書きを追加する:
  ```css
  #edit-form input#nickname:placeholder-shown:not(:focus) {
  	border-style: solid;
  	background: var(--color-surface);
  }
  ```
  (`input[type="text"]`等の基底ルール、global.css:474-487の値と同じに戻すだけ。新しい色・値は作らない。IDセレクタを2つ重ねているため詳細度は既存の破線ルールより高く、記載順に関わらず勝つが、念のため既存ルールの直後に置く)。
  - 他の項目(種族名・特性・アイテム・テラスタイプ等)の破線ルールは対象外、変更しない。

### 維持すべき点(追加)
- 他のplaceholder-shown破線ルール(種族名以外の未設定項目全般)は変更しない。`#nickname` 限定の上書き。

## 追加指示(2026-07-30、A-5実装中にユーザーからさらに追加)

ユーザーの言葉(原文): 「右サイドの状態異常の入力欄も破線ではなく実線にし、状態異常が入力されているときはハイライト表示する」

【特定】「右サイド」=詳細設定サイドバー(`RightPanel.astro`が静的マークアップ`#damage-detail-panel`を描画し、中身は`right-panel.ts`/`damage-calc.ts`がJSで動的生成する。00-foundation.mdの「パネル」該当区分どおり)。「状態異常の入力欄」= `.damage-detail-ailment-select`(native `<select>`、`right-panel.ts:370`で生成、CSSは`DamageCalcSection.astro`側の`<style is:global>`ブロックに集約、pitfalls.md「Astroのscoped styleはJSで生成した要素に効かない」対応のため)。

**現状(実測済み)**: `DamageCalcSection.astro:2242-2262`が基底スタイル(幅6.5em等、border-styleの指定なし=通常のselect同様solid)。`DamageCalcSection.astro:2266-2270`の`.damage-detail-ailment-select.is-ailment-unselected`(状態異常「なし」選択中、`right-panel.ts:404`の`updateAilmentPlaceholderState()`がJSでこのクラスをトグル)が`border-style: dashed; background: transparent; color: var(--color-text-muted);`を適用している。つまり**現状は「未選択(なし)のときだけ破線」「何か選択中は既に実線」**という状態。ユーザーの「実線にし」は**未選択時の破線をやめる**指示、「ハイライト表示」は**選択中(状態異常が実際に入っている)ときに何らかの強調を新設する**指示、の2点として読み解く。

対象ファイルは `DamageCalcSection.astro` のみで、**A-1〜A-4を担当している実装者と同じファイル**。**A-1〜A-4の実装完了後、同じ実装者(または新規実装者に差分を正確に伝えた上)で続けて着手すること。並列に2体で同じファイルを触らせないこと**(pitfalls.md「担当外ファイルの編集」節、SKILL.md「ファイル単位で担当を割り、同じファイルを2体に触らせない」)。

### 優先度A(追加、ユーザー直接指示)
- **A-6a 状態異常「なし」選択中の破線表示をやめ実線にする**: 【提案】`.damage-detail-ailment-select.is-ailment-unselected`(2266-2270行目)の`border-style: dashed; background: transparent;`を撤去し、基底の`select`スタイル(solid border、通常背景)に戻す。**セレクタ自体は既存クラス削除禁止の規約により残し(JSが引き続き`is-ailment-unselected`をトグルするため)、プロパティを基底と同値へ戻す形で無効化する**(round-47 A-7と同じやり方)。`color: var(--color-text-muted)`(muted文字)は「なし」プレースホルダーであることを示す手掛かりとして残してよいか、それとも文字色も通常に戻すかは実装者判断(**どちらでも「破線ではなく実線」という要件は満たすため、文字色は残す方向を推奨**。ただし維持する場合はコントラストを実測しAA(4.5:1)を満たすことを確認する)。
- **A-6b 状態異常が選択されている(空でない)ときにハイライト表示する**: 【提案】`#damage-detail-panel-body .damage-detail-ailment-select:not(.is-ailment-unselected)`(新規セレクタ)に強調スタイルを追加する。**同じパネル内に既に確立済みの「値が非既定のとき強調する」パターン**が`.damage-detail-rank-field input.is-nonzero`(2206-2210行目、`font-weight: 700; color: var(--color-primary); border-color: var(--color-primary);`)にあるので、**新色を作らず同じ語彙(`--color-primary`)を流用して統一する**ことを推奨する(実装者判断で背景の`--color-primary-soft`を足してもよいが、新色は作らない)。ライト・ダーク両テーマでコントラストを実測確認すること。

### 維持すべき点(追加)
- `.damage-detail-ailment-select`の幅(`6.5em`)・native selectであること自体は変更しない。
- 天候・フィールドなど他のicon-groupのplaceholder表現(破線)は対象外、変更しない。
- ランクの`.is-nonzero`強調ロジック自体(参照するだけで変更しない)。

## 追加指示(2026-07-31、A-6実装待ちの間にユーザーからさらに追加)

ユーザーの言葉(原文、「個体編集画面 左サイド」節):
> - 性格の欄から性格を直接変更できるようにする。ステータスも連動して変更する。
> - テラスなし -> テラスタルなし

ユーザーの言葉(原文、「個体編集画面 ダメージカード」節):
> - テラスなし -> テラスタルなし

### 優先度A(追加、機能追加・ユーザー直接指示、左サイドのみ)

- **🔴 A-7 性格欄から性格を直接変更できるようにする(ステータス連動)**: 【背景・過去の判断の撤回】現在 `#nature-readout-value`(`LeftPanel.astro:192-200`)は `readonly` + `tabindex={-1}` の読み取り専用inputで、性格はH以外の各ステータス見出し横の▲/▼ボタン(`nature-up-{key}`/`nature-down-{key}`、`left-panel.ts:1017-1035`)をクリックして上昇/下降させる方式でのみ決まる。ラウンド21ユーザー指示(21-L4)「readonlyにしない、操作できる部品に見えると疑問を生む」・ラウンド23ユーザー指示(23-L2)「入力不可にしておき自動決定の仕組みを続投」という**過去2回の明示判断をここで撤回する**(ユーザーが今回改めて直接編集を要求したため)。**ラウンド4で一度廃止した「性格`<select>`」(`damage-calc.ts`コメント「性格`<select>`を廃止したので」参照)を左サイドに限定して復活させる形になるが、廃止されたのは対戦相手ビルド側(ダメージカード)のみで、左サイドの▲/▼方式自体は当時から維持されているため、今回はダメージカード側には手を入れない(ユーザー指示も左サイド限定)**。
  【提案】
  1. `LeftPanel.astro:192-200` の `#nature-readout-value` から `readonly` / `tabindex={-1}` を外し、通常の編集可能inputにする(`aria-label`は「性格(能力値の上下選択から自動的に決まります。ここでは編集できません)」→ 直接編集できる旨に更新する)。
  2. 25種類の性格名(`src/lib/stats.ts:44` `NATURE_STAT_MODIFIERS` のキー、`まじめ`等の補正なし5種を含む)を候補にした `<datalist>` を新設し、`list`属性で紐付ける(他ページで既に確立している「input+datalist」パターン、例: `damage-calc.ts`の`nameInput.setAttribute("list", "pokemon-list")`と同じ考え方を踏襲。新しいUI部品を発明しない)。
  3. `left-panel.ts` にこの入力欄の`change`イベントハンドラを追加する: 入力値が`NATURE_STAT_MODIFIERS`に実在する性格名なら、`leftNatureUp`/`leftNatureDown`をその性格の`up`/`down`で上書きし、`refreshNatureButtons()`(▲/▼ボタンの押下状態・ステータスの色分けを更新)→`void recalcStats()`(実数値再計算)→`scheduleSave()`(自動保存)を呼ぶ。これは既存の▲/▼クリックハンドラ(`left-panel.ts:1023-1034`)が呼んでいる関数列とまったく同じ並びなので、そこを参考に実装する。
  4. 存在しない性格名が入力された場合(datalistに無い任意の文字列を手入力した場合)は何も変更せず、`natureReadoutEl.value`を`currentLeftNature()`(現在の実際の性格名)に戻す(不正値の保存を防ぐ)。
  5. ▲/▼ボタンをクリックしたときも、この入力欄の表示値が正しく追随することを確認する(`refreshNatureButtons()`が既に`natureReadoutEl.value = currentLeftNature()`を行っている、896行目付近。この経路は変更不要のはず、実装後に確認)。

- **A-8 左サイドのテラス表記「テラスなし」→「テラスタルなし」**: 【対象・ユーザー可視文言のみ】`LeftPanel.astro:272`(`<option value="">テラスなし</option>`)・`LeftPanel.astro:283`(`<span id="tera-dropdown-placeholder">テラスなし</span>`)・`left-panel.ts:716`(`aria-label`)・`left-panel.ts:719`(`textContent`)・`left-panel.ts:781`(`textContent`)の計5箇所を「テラスタルなし」に置換する。コメント内の「テラスなし」という記述(過去ラウンドの経緯説明)は変更不要(ユーザー可視文言ではないため)。

### 優先度A(追加、ダメージカード側。A-6と同じファイルのため同じ実装者がA-6と同時に着手すること)

- **A-9 ダメージカードのテラス表記「テラスなし」→「テラスタルなし」**: 【対象】`damage-calc.ts`内の計5箇所 — 2000行目・2019行目(`placeholder.textContent = "テラスなし"`)、2069行目(`aria-label`)、2072行目(`textEl.textContent`)、2100行目(`addOption("", "テラスなし")`)を「テラスタルなし」に置換する。**この項目は`damage-calc.ts`を編集するため、A-1〜A-4を実装したエージェントが空くのを待ってから、A-6(状態異常ハイライト)と同時に着手すること**(同じファイルへの並列編集を避ける)。コメント内の記述は変更不要。

### 維持すべき点(追加)
- ▲/▼ボタンによる性格変更方式そのもの(A-7は直接入力を**追加**するだけで、既存の▲/▼方式は残す。両方から同じ状態を操作できるようにする)。
- ダメージカード側(相手ビルド)の性格入力方式(▲/▼のみ)は今回変更しない。A-9はテラスの表記文字列のみが対象。
- `NATURE_STAT_MODIFIERS`・`natureNameFromBoosts`・`toggleNatureUp`/`toggleNatureDown`(`src/lib/stats.ts`)のロジック自体は変更しない(呼び出すだけ)。

## 参照(実装者へ渡すもの)
- 本ファイル(`docs/plan/ui_rounds/round-48.md`)の該当節
- `.claude/skills/ui/references/pitfalls.md`(特に「`[hidden]`は詳細度で負ける」「`global.css`の指定がAstroのscoped styleに詳細度で負ける」「打ち消したつもりで1階層上を打ち消している」節 — A-3で共通クラス`.damage-row-icon-button`を誤って編集しないための注意として)
- Explore調査結果: `src/components/box-id/DamageCalcSection.astro`(約3000行、CSS/HTML/script本体)・`src/lib/box-id/damage-calc.ts`(約3181行、状態管理)

## ラウンド48の実施結果(2026-07-31)

**ユーザー指示により、実装完了後は統一感レビュアーの軽量パス・メタレビューを行わず、検証後ただちにcommitして終了する。**(「実装がすべて終わった段階でcommitして終了して」)。距離判定用の`ui_plan.md`「最終メタレビュー: ラウンド45」行は**更新しない**(実施していないため。次回ラウンドのStep -1で距離判定が引き続き機能し、確実にメタレビューがトリガーされるようにするため)。

### 実施済み(表: 対象 / 内容 / 結果)
| 対象 | 内容 | 結果(実測) |
|---|---|---|
| A-1 | 「N発目」右の縦棒(`.damage-column-order-label`の`border-right`)を削除 | `DamageCalcSection.astro`実測・スクリーンショット目視で消失確認 |
| A-2 | 結果表示直上の点線(`.damage-column-footer`の`border-top: dashed`)を削除 | 同上、相手ビルド箱側(ラウンド34撤去済み)と混同せず技カード単体側を対応 |
| A-3 | 技カード削除ボタン(`.damage-column-remove-button`)の丸枠を`background:transparent;border:none;box-shadow:none`で非表示化、insetを8px→2pxに詰めた | 共通クラス`.damage-row-icon-button`は無編集(カード全体削除ボタンは円形のまま維持を確認)。技名/ヒット数入力欄との重なりなし |
| A-4(機能追加) | 相手ビルド(nature/abilityName/itemName/teraType/evs)を種族名キーで`localStorage`に記録し、新規の空行に同じ種族名を入れたとき自動適用 | 使い捨て個体でPlaywright実機検証: ピカチュウでプリセット保存→別行で同種族入力→5項目自動適用を確認。既存カードは`isOpponentBuildUnset`ガードで無変更。localStorage不可環境はtry/catchで無害化 |
| A-5 | `#nickname`入力欄を空欄時も実線・不透明背景にする(`LeftPanel.astro`) | ニックネーム未設定フィクスチャで実線化を確認、他の未設定項目(破線のまま)には影響なし |
| A-6a/b | 状態異常セレクト、未選択時の破線を撤去(実線化)+選択中は`.is-nonzero`と同じ`--color-primary`語彙でハイライト | ライト5.68〜5.90:1(未選択時)、選択中ハイライトはダーク7.51:1・**ライト2.50:1(AA未達)**。ただし既存`.is-nonzero`(ランク入力欄)と同一値で、今回新規に持ち込んだ劣化ではない(下記「積み残し」参照) |
| A-7(機能追加) | `#nature-readout-value`のreadonly/tabindexを撤去し、25性格のdatalist付き直接入力を追加。`change`で`NATURE_STAT_MODIFIERS`を正引きし▲/▼と同じ処理列(`refreshNatureButtons→recalcStats→scheduleSave`)を実行。不正値は現在値に復元 | 使い捨て個体で「いじっぱり」入力→atk上昇/spa下降ボタン追随・実数値再計算・DB保存を確認。▲/▼クリック時も入力欄が追随。不正文字列「てすと」で復元を確認。ラウンド21(21-L4)・23(23-L2)の「readonly維持」判断をユーザー指示により撤回 |
| A-8 | 左サイドの「テラスなし」→「テラスタルなし」(計5箇所) | 目視確認済み |
| A-9 | ダメージカードの「テラスなし」→「テラスタルなし」(`damage-calc.ts`計5箇所) | 目視確認済み(フシギバナ(キョダイ)・メガカメックスの未設定表示で確認) |

Coordinator自身の最終検証: `npx astro build`成功・`npm test` 298/298 pass・カイリューフィクスチャ(`c8680844-...`)のダメージカード展開表示をライト/ダーク再撮影し、A-1〜A-3の反映と回帰なしを目視確認。

### 積み残し・要確認事項
- **A-6bのハイライトはライトテーマでコントラスト2.50:1、WCAG AA(4.5:1)未達**。ただし新規劣化ではなく、既存の`.is-nonzero`(ランク入力欄強調)から今回踏襲した値と同一(pitfalls.md「コントラストは計算して確かめる」で以前から知られている`--color-primary`のライトでの弱さの再確認)。**`--color-primary`をこの用途で使う既存パターン自体の是非は次回まとめて検討する**(このラウンドの指示は「同じ語彙を使う」ことだったため、今回は範囲外として据え置く)。
- **round-47積み残しのライトテーマ白文字視認性は今回未対応**(ユーザーから今回の指示に含まれなかったため)。次回の「ユーザー判断待ち」棚卸しで再提示すること。
- **統一感レビュアーの軽量パス・メタレビューは今回未実施**(ユーザー指示により実装完了後ただちにcommitして終了する運用としたため)。`ui_plan.md`の「最終メタレビュー: ラウンド45」は据え置いており、次回ラウンドのStep -1で距離判定(現在3以上)が引き続き機能する。

メタレビュー: **未実施(ユーザー指示により今回は見送り。次回ラウンドで必ず実施すること、距離はラウンド45から広がったまま)**。
