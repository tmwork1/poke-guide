# UI改善ラウンド46

[← 索引](../ui_plan.md)

## ラウンド46の要件(2026-07-30 ユーザー指示第30弾)

ユーザーの言葉: 「ダメージカード_圧縮.pngを参考にUIを改善」

対象は `/box/[id]` のダメージ計算カード(相手ごとの1行)の**折りたたみ(圧縮)表示**のみ(ラウンド45と同じ対象領域)。ユーザーが新規追加した `docs/ui_proposal/ダメージカード_圧縮.png` を構造の正として参照する。

### Coordinatorが着手前に確認した新ワイヤーフレームとの差分

`docs/ui_proposal/ダメージカード_圧縮.png` の構造: 圧縮表示は「アイコン | 種族名/攻撃or防御/特性/H-A-B-C-D-S(左4行)」「技名/詳細設定/累計計算結果(右3行)」。

現状の実装と比較すると、右ブロックは既にこの3行構成(42-D5)を満たしている。**左ブロックは「種族名/与ダメ・被ダメバッジ/実数値(2行)」の3要素構成で、特性(とくせい)が完全に欠落している。** これはラウンド42で「340px幅に名前・攻守バッジ・実数値6つを収める時点で十分密になっており、特性名まで足すと1行に収まらず可読性を損なう」という理由で意図的に外された判断(`damage-calc.ts` 2178行目付近のコメント)。しかしラウンド45で左ブロック幅が115.2px→234.42pxまで拡張されており、当時の空間制約の前提が変わっている。

Coordinator実測(1920×1080、`/box/c8680844-dd43-42a4-bdf1-f3de11fe3267`、「すべて折りたたむ」クリック後、Playwright実測):
- `.card-damage` 高さ: 119.09px(4枚とも同一)
- `.damage-row-collapsed-summary`(左ブロック内の名前+バッジ+実数値スタック): 幅234.42px・高さ96.34px
- `.damage-row-collapsed-name`: 幅206.08px、0.92rem/700
- `.damage-row-collapsed-direction`(与ダメ/被ダメバッジ): 幅49.5px
- 右ブロック(`.damage-row-collapsed-techniques` + `.damage-row-total`): 高さ48〜71px(技数・条件の有無で変動)

### 撮影スクリプトの拡張

折りたたみ状態のスクリーンショットが今回もこちらで再び必要になった(ラウンド45でも同様に必要になり、当時はその場限りのPlaywrightスクリプトで撮った)。2回目の発生のため `scripts/shot.mjs` に **`--click <selector>`**(安全と確認済みの要素をPyodide待ち完了後にクリックする、複数指定可、`text=`プレフィックスで完全一致テキストクリック)を新設した。`setCollapsed()` は `scheduleRowSave` を呼ばない(自動保存に影響しない)ことをコード確認済みなので、クリック対象として安全と判断した。次ラウンド以降は `npm run shot -- --page box/<id> --click "text=すべて折りたたむ"` で撮れる。

## Step2: UIレビュアー・プレイヤー視点レビュアーの講評(sonnet、2026-07-30)

ラウンド45と同じく、画面固有の完成度問題に絞ってUIレビュアー・プレイヤー視点レビュアーの2体を起動した(UX・統一感レビュアーは今回省略。統一感は実装後の変更領域限定の軽量パスで確認する)。

### UIレビュアーの指摘(優先度A/B/C)
- 特性行の追加自体は234.42px幅の箱に構造的に妥当。新規クラス`.damage-row-collapsed-ability`を、右ブロックに既にある`.damage-row-collapsed-detail-line`(0.76rem/font-weight 400/`var(--color-text-muted)`/nowrap+ellipsis+title)と同一仕様で新設すれば、新色・新フォントサイズを増やさずに済む
- 挿入位置は与ダメ/被ダメバッジと実数値グリッドの間(ワイヤーフレームの順序どおり)
- 特性行追加でsummary高さが96.34px→約116〜139px相当に伸び、カード高さも119.09px→約139px(+17%程度)に連動して伸びる見込み。「圧縮」規格の趣旨とは緊張関係があるが、特性はH-A-B-C-D-Sと同格の事実情報であり許容範囲と判断(規格違反ではない)
- (B)右ブロック(48〜71px)は元々summaryより短く、`.damage-row-body`のalign-items:centerで生じる上下余白差が今回の高さ増でほぼ倍に拡大する見込み。次ラウンド以降の軽い位置調整候補として記録(今回は必須としない、対応できれば可)
- (B)`.damage-row-collapsed-name`の`max-width:14em`(206.08px)は115.2px幅時代の値が未更新のまま残っている棚卸し対象(実害は今のところ無し)

### プレイヤー視点レビュアーの指摘
- 特性欠落は実戦の判断ミスに直結すると強く指摘(画面に映る4体すべてが具体例: **マルチスケイル**の多段技非対称発動=直前のバグ修正コミット`7189a33`と直結する論点、**しんりょく**のHP閾値による被ダメ急増、**こだいかっせい**の「はれ」トリガーの誤解されやすさ、**メガランチャー**の攻撃側限定発動)
- 表示順序(種族名→攻撃or防御→特性→実数値)はドメイン上妥当。持ち物・テラスがアイコンのみ/特性がテキストという使い分けも妥当(持ち物・テラスは記号として暗記される種類の情報、特性は種類が多くピクトグラム化できない)
- 省略時は`title`属性でフルテキストを保持すべき(UIレビュアーと重複指摘、統合済み)

## Step2.5: Coordinator統合・裁定

- 両レビュアーとも「特性行追加」を優先度Aとして一致。UIレビュアーの実装方針(`.damage-row-collapsed-detail-line`と同一仕様の新規クラス)を採用する
- `title`属性によるフルテキスト保持は重複指摘のため1件に統合
- カード高さの増加(+17%程度)はUIレビュアーが「規格違反ではなく許容範囲の代償」と判断しており、Coordinatorもこれに同意する(特性はダメージ計算の根拠情報であり、圧縮表示から省いてよい装飾ではない)
- 右ブロックの縦方向余白差拡大(B-1)は今回の変更が直接の原因のため、実装者に「対応できれば行う、無理に大きな変更はしない」形でPriority Bとして依頼する
- name行のmax-width棚卸し(B-2)も同じ要素群を触るついでに対応可能なら行う、Priority B

### 優先度A(必ず直す)
- **A-1 圧縮表示の左ブロックに特性行を追加**(指摘者: UI・プレイヤー視点): 【問題】現状は種族名/与ダメ・被ダメバッジ/実数値の3要素のみで特性が完全に欠落しており、ワイヤーフレーム(`docs/ui_proposal/ダメージカード_圧縮.png`)の4行構成(種族名/攻撃or防御/特性/H-A-B-C-D-S)と食い違う。プレイヤー視点レビュアー指摘のとおり、特性はダメージ計算そのものに直結する情報で、折りたたみ一覧だけで相手を見比べる場面で判断ミスに繋がる。【提案】
  1. `damage-calc.ts`の`collapsedSummary`組み立て箇所(2163行目付近)に、`collapsedDirectionEl`と`collapsedStatsEl`の間へ新規要素`collapsedAbilityEl`(`.damage-row-collapsed-ability`)を追加する。
  2. `refreshCollapsedSummary()`で`collapsedAbilityEl.textContent = row.abilityName.trim() || "(特性未設定)"`のように反映する(名前欄の`(名前未設定)`と同じフォールバック文法)。`title`属性にもフルテキストをセットする(省略時のため)。
  3. CSS(`DamageCalcSection.astro`)に新規ルールを追加:
     ```css
     #opponent-notes-section .damage-row-collapsed-ability {
       font-size: 0.76rem;
       font-weight: 400;
       color: var(--color-text-muted);
       white-space: nowrap;
       overflow: hidden;
       text-overflow: ellipsis;
     }
     ```
     `max-width`は付けない(親のflexで234.42pxまで自然に伸びる)。
  4. `row.abilityName`が変わるタイミング(abilitySelectのchangeイベント等)で`refreshCollapsedSummary()`が呼ばれることを確認し、呼ばれていなければ追加する。

### 優先度B(直せるとよい)
- **B-1 右ブロックの縦方向余白差**(指摘者: UI): A-1でsummary高さが伸びる結果、`.damage-row-body`のalign-items:centerによる右ブロックとの上下余白差が拡大する見込み。対応できれば、右側コンテナに`align-self: flex-start`+微調整のpadding-topを検討する。無理に大きな変更はしない(見送り可、その場合は積み残しに記録)。
- **B-2 name行のmax-width棚卸し**(指摘者: UI): `.damage-row-collapsed-name`の`max-width: 14em`(206.08px)はラウンド45拡幅前(115.2px幅時代)の値が未更新のまま残っている。実害は無いが、A-1で同じ要素群を触るついでに`max-width: 100%`へ変更するか、現行幅に見合う値へ更新できれば行う(必須ではない)。

### 優先度C(今回は対応しない)
なし(両レビュアーとも優先度Cの追加提案なし)

### 維持すべき点(壊さないこと)
- ラウンド45で確立した左ブロック234.42px幅・実数値3列grid(H↑C・A↑D・B↑S縦整列)、chevron縦中央寄せ、性格▲/▼記号、実数値font-weight 700統一
- 右ブロックの3段構成(技名/詳細設定/累計結果、42-D5)
- アイテム・テラスタルはアイコンのみ表示(42-D4)、特性追加後もそちらはテキスト表示を追加しない(現状維持)
- 削除ボタン・折りたたみボタンの位置

## ラウンド46の実施結果(2026-07-30)

### 実施済み

| 項目 | 対象 | 結果(実測値) |
|---|---|---|
| A-1 特性行の追加 | `damage-calc.ts`(`collapsedAbilityEl`新設)/ `DamageCalcSection.astro`(`.damage-row-collapsed-ability`新設) | 与ダメ/被ダメバッジと実数値グリッドの間に挿入。`.damage-row-collapsed-detail-line`と同一仕様(0.76rem/400/muted/ellipsis+title)を流用、新色・新サイズなし。`row.abilityName`が変わる3箇所(`rebuildRowAbilityOptions()`内の空化・デフォルト設定、`abilitySelect`のchange)すべてで`refreshCollapsedSummary()`呼び出しを確認・追加。4体すべて(マルチスケイル/しんりょく/こだいかっせい/メガランチャー)が正しく表示され、ellipsis省略は発生せず |
| B-1 右ブロックの縦方向余白差 | `.damage-row-techniques-row`(折りたたみ限定) | 対応した。`align-self: flex-start; padding-top: 0.5rem;`を追加。変更前は上下に均等分散していた余白(片側22〜34px)が、変更後は技名行が種族名行とほぼ同じ高さに揃い(top差約2.4px)、余白が下側にまとまった |
| B-2 name行のmax-width棚卸し | `.damage-row-collapsed-name` | 対応した。`max-width: 14em`→`max-width: 100%`に変更し、親のflex伸縮に委ねる形にした |

### 実測値(Coordinator・実装者双方で確認)
- `.card-damage`高さ: 変更前119.09px → **変更後141.72px**(4枚とも同一、事前予測「約139px」とほぼ一致)
- `.damage-row-collapsed-summary`高さ: 96.34px → **118.97px**
- 特性行(`.damage-row-collapsed-ability`)高さ: **19.44px**(4枚とも同一)

### Coordinator最終検証
- `npx astro build`成功、`npm test` 298件全pass
- 1920×1080 ライト/ダークをRead toolで目視確認(特性名4体とも正しく表示、右ブロックの縦位置改善、横スクロールなし、コンソールエラーなし)
- フィクスチャ`c8680844-dd43-42a4-bdf1-f3de11fe3267`のDB値は変更前と一致、DB汚染なし
- `git status --short`で担当2ファイル以外の差分が実装者の変更でないことを確認(round-46.md本体・ui_plan.md・scripts/shot.mjsのCoordinator事前準備分のみ)

### 積み残し(次に着手する項目)
- メガカメックスのカードは詳細設定行が長く右ブロックが4枚中最も高い(82.58px)ため、下側の余白が最も小さい(41.98px、他は63〜65px)。カード高さは左ブロック基準で統一されており崩れてはいないが、将来的にさらに長い詳細設定行が増えた場合はpadding-topの再調整が必要になる可能性がある(優先度C相当)

## 撮影スクリプトの拡張(このラウンドで実施)
`scripts/shot.mjs`に**`--click <selector>`**オプションを新設した(「Step2」節参照)。折りたたみ状態のスクリーンショットが2ラウンド連続(45・46)でその場限りのPlaywrightスクリプトを要していたための恒久対応。`text=`プレフィックスで完全一致テキストクリックに対応。`setCollapsed()`が自動保存を伴わないことをコード確認済みのため、このクリックは既存の「一切触らない」方針に対する安全なオプトインとして追加した。

## 付録: 並行して調査・修正した実バグ(UI改修とは別)

ラウンド46の作業と並行して、ユーザーから「ダメージ計算に失敗している(localhost:4321で『エラー: 計算に失敗しました』と表示される)」と報告があり、Coordinatorが調査・修正した。UIラウンドの範囲外だが、同じ画面(`/box/[id]`)に影響する重大な実バグのため記録する。

**根本原因**: `public/pyodide-sw.js`のjpoke wheelキャッシュがcache-first・`CACHE_NAME`固定・期限なしという設計だった。直前のコミット`7189a33`(技列のマルチスケイル等HP依存効果のバグ修正、`resume_from`引数の導入)でwheelの中身だけが変わり、wheelのバージョン番号(`0.2.0`)もファイル名も据え置かれたため、既にService Workerを登録済みのブラウザは古いキャッシュ済みwheelバイト列を無期限に使い続けた。新しいJS側(`pyodide-engine.ts`)は`Battle.calc_lethal(resume_from=...)`を呼ぶが、古いキャッシュ済みwheelにはこの引数が存在せず、`TypeError: Battle.calc_lethal() got an unexpected keyword argument 'resume_from'`で全カードの計算が失敗していた。

**再現方法**: git履歴から修正前のvendor/jpokeソースを取り出して同名wheelを再ビルドし、Playwrightで新規ブラウザコンテキストのService Worker Cache Storageへ直接シードして確認。修正前コードでは確実に同一のエラーメッセージが再現した。`npm test`・`npx astro build`はこの経路(実ブラウザでのService Worker cache-first)を通らないため検出できない。

**恒久対応**: `scripts/build-master-data/build.mjs`のwheelビルド後にsha256内容ハッシュ(先頭10桁)を「ビルドタグ」としてファイル名に埋め込むよう変更(`jpoke-0.2.0-py3-none-any.whl` → `jpoke-0.2.0-0<hash>-py3-none-any.whl`)。ビルドタグはPEP 427のwheel命名規則が正式にサポートする任意要素(先頭が数字である制約があるため`0`を前置)。中身が変わればURLも自動的に変わるため、cache-firstでも安全になる。同じ再現手順(旧URLをキャッシュへシード)で修正後は正しい計算結果が返ることを確認済み。

`.claude/skills/jpoke/references/integration.md`(Service Worker節・§4ビルド時節・既知の制約リスト)と`vendor/jpoke/VENDORING.md`に出典付きで追記済み。
