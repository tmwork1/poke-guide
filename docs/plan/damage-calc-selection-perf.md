# /damage-calc: ボックス/チームからのポケモン呼び出し高速化・UX改善計画

**背景(2026-09-11のセッション)。** `/damage-calc` でボックスから自分側ポケモンを選ぶと、選択直後に画面が静止して見える不具合が「以前のコミットで対策済みのはずが再発した」との報告を受け、原因調査・修正・fable advisorへの追加相談まで行った。このセッションはここで終了し、続きは次のセッションで実装する。**実装はcodexへ委任する方針**(ユーザー指示)。

## このセッションで完了した修正(コミット済み)

1. `species-select-dialog.ts` のポケモン選択グリッドで、アイコンが `img.style.display = "none"` で初期非表示にされ、`applySprite()`(shared-core.ts)は `imgEl.hidden` の切り替えでしか表示を戻さないため、画像が永久に非表示のままだった(タップ自体は機能する)。`img.hidden = true` に変更して修正。
2. 同根の不具合が `damage-calc.ts`(box/[id]のダメージカードのスプライト・もちものドロップダウン画像)と `damage-detail-panel.ts`(対面選択見出しアイコン)にも見つかり、同様に修正。
   - 再発防止のため `feedback_applysprite_hidden_contract` メモリに設計契約を記録済み。今後 `applySprite`/`applyItemImage`(shared-core.ts)にimgElを渡すコードを書く/レビューするときは、初期非表示を `style.display` ではなく `hidden` 属性で行うこと。
3. `/damage-calc` でボックスから自分側ポケモンを選んだ直後に画面が静止する不具合を修正。
   - 原因: `matchup-card.ts` の `calculateAttackRows()`/`calculateDefenseRows()` 内のループが `await calcDamages(...)` している体裁でも、`calcDamages()`/`calcStats()`(pyodide-engine.ts)の中身は完全に同期実行のPyodide(Wasm)呼び出しであるため、awaitしてもマイクロタスクの連鎖が続くだけでブラウザに制御が返らず、技数×守備パターン数ぶんの計算が1つの長いタスクにまとまっていた(実測: 約740msのlongtask)。以前のコミット(`b637b9b`「Close box selector before matchup refresh」、box-select-dialog.tsで`closeDialog()`を先に呼びrAFを1回挟んでからdispatchEventする対策)だけでは防げていなかった。
   - 対策: 各行の計算後に `await new Promise(resolve => setTimeout(resolve, 0))`(`yieldToBrowser()`)を挿入し、マクロタスク境界を明示的に作ってブラウザに描画機会を与えるようにした。最大フレームギャップは約800ms→約230msに改善(Performance Observerのlongtask + rAFタイミングで実測)。

## 2026-09-11 追記: TODO 1〜4 実装済み(codexへ委任 → Coordinatorが実測検証)

下記「優先順位付きTODO」の1〜4を実装した。実測(Performance Observerのlongtask + rAFフレームギャップ、`npm run probe --eval`、dark/390x844、クリック後8秒窓)の結果:

| 操作 | 最大フレームギャップ | longtask合計 |
|---|---|---|
| box選択(1体) 修正前 | 378ms | 854ms |
| box選択(1体) 修正後 | **274ms** | 818ms |
| team選択(5体) 修正前 | 981ms | 3978ms |
| team選択(5体) 修正後 | **267ms** | 3238ms |

発見Aの読みどおり、team選択での効果が圧倒的(981ms→267ms、約73%短縮)。総計算時間(longtask合計)はほぼ変わらず、「1つの長いタスク」が「短いタスクの列」に分割されたことが数値に表れている。

なお修正3(`initEngine()`の並行化)では、requestIdが変わって`await enginePromise`に到達しないケースでunhandled rejectionにならないよう、`enginePromise.catch(() => {})`をCoordinatorが追加した。

**残TODOは5・6・7。**

## fable advisorへの相談結果(1〜4は上記のとおり実装済み)

「さらなる短縮・UX改善」を相談したところ、上記の修正だけでは不十分な箇所が見つかった。特に**発見Aはteam選択(最大6体)で深刻な未修正のフリーズが残っている可能性が高い**ため優先度が高い。

### 発見A(最重要・未修正): `Promise.all(cards.map(async...))` がyield対策を無効化している

`matchup-card.ts` の `run()` は、複数カード(box=1体、team=最大6体)の計算を次の形で回している。

```ts
await Promise.all(cards.map(async (card) => {
  const selfSpeed = self ? (await calcStats(self)).stats.spe : null;
  ...
  await calculateAttackRows(...);   // 各行の後で yieldToBrowser() を実行(今回追加した対策)
  await calculateDefenseRows(...);
}));
```

JSはシングルスレッドなので、`Array.prototype.map` は各カードのasyncコールバックを**呼び出し順に同期的に**実行し、最初の`await`に当たるたびに次のカードへ進む。`calcStats`/`calcDamages`が完全同期であることと合わせると、「6体分の同期処理」がまず一息に走り、`Promise.all`の待機でマイクロタスクキューが一気にドレインされる。マイクロタスクはブラウザが描画判定する前に全て掃き切られるため、各カードに仕込んだ`yieldToBrowser()`が**カードをまたいで無効化**される。

→ **対策**: `cards.map(async...)` を `for (const card of cards) { await ... }` という逐次ループに変更するだけで、総計算時間は変えずに「1枚ごとに描画チャンスが訪れる」構造になる。副次効果として画面上部(最も見られやすい)のカードから先に完成するようになる。**box側への影響なし、修正範囲は限定的。最優先で着手。**

### 発見B(未修正): プレースホルダー挿入直後に「本当のyield」がない

`run()` はプレースホルダーカードをDOM挿入した直後、`Promise.all([loadMoveDetailMap(), fetchOpponentMoveOptions(...), fetchOpponentAbilityOptions(...), loadPokemonMasterList(), loadAbilitiesMap()])` を待つ。これらは全て一度取得すると解決済みPromiseを返すキャッシュ実装のため、2回目以降の`run()`では実ネットワークI/Oを伴わずマイクロタスクのみで即座に解決する。「先にプレースホルダーを差し込んで即座にカードが見える体験を保つ」という実装意図(既存コメント)が、キャッシュが温まっている通常ケースでは実現されていない。

→ **対策**: プレースホルダーをDOMに挿入した直後に `await yieldToBrowser()` を1回挟む。box選択後に残っている約230msのフレームギャップの主因候補。

### 発見C(未修正): `initEngine()` の呼び出しタイミング

`run()` は `registerOfflineCache(); await initEngine();` を5件の`Promise.all`の**後**に呼んでいる。`initEngine()`は冪等・シングルトンで、いつ呼んでも副作用はない。特にページ初回ロード時、Pyodideランタイム(wasm)・jpoke wheelのロードという最重量処理が、技詳細・使用率APIのフェッチ完了を待ってから直列に始まっている。初回表示の体感速度に直接効く。

→ **対策**: `initEngine()`の呼び出しをPromise.allと並行化するか、さらに早いタイミングに前倒しする。

### team-select-dialog.ts の対策漏れ(未修正)

`team-select-dialog.ts` の `selectTeam()` は、box側で入れた「`closeDialog()`を先に呼び、rAFを1回挟んでからdispatchEvent」対策が未適用で、即座に同期dispatchしている。box側より明確に劣化している。

→ **対策**: box同様の「closeDialog()先行+rAF+dispatchEvent」パターンを移植する。ただし**発見Aとセットで行わないと効果が出ない**(rAF遅延だけでは「モーダルが閉じるのが遅れる」問題しか緩和されず、閉じた後の長時間フリーズは発見Aが主因のため解消しない)。

### その他の提案(中期・低優先)

- **team選択時のオプティミスティックUI**: box側は一覧カードで解決済みの画像URLをそのまま対面カードへ渡す仕組み(`artworkUrl`)があるが、`run()`は単一の`selfArtworkUrl: string`しか受け付けないためteam(6体)には未対応。team-select-dialog.ts側で各メンバーカードの`.card-artwork img`からURLを事前抽出し、`run()`に配列で渡すよう拡張すると、6体分の「?」プレースホルダー→差し替えのチラつきを解消できる。
- **相手側実数値・技カテゴリのrun()横断キャッシュ化**: `defenderStats`(`calculateAttackRows`内)は`run()`呼び出し単位のローカルMapで、呼び出しをまたいで再利用されない。相手のビルド・場の状態が変わらない限りモジュールスコープでキャッシュ可能。効果は中程度、実装コストは低め。
- **Web Worker化**: 根本解決策。Pyodideはdedicated Worker内で動作可能で、`calcDamages`/`calcStats`をpostMessageベースのRPCに置き換えればメインスレッドは一切ブロックされなくなる。既存の`currentRequestId !== requestId`による「古い結果を捨てる」設計はWorker化後もそのまま使える。コストは中〜大(bootstrap・wheelロード・進捗通知のWorker移植、Astro/Viteでのworkerバンドル設定)。今回見つかった「yield対策がPromise.allで静かに無効化される」ような落とし穴が積み重なっている状況を踏まえると、中期的に検討する価値は高いが、着手優先度は上記より低くてよい。

## 優先順位付きTODO(次セッションでcodexへ委任する実装単位)

1. ~~`matchup-card.ts`: `run()`内 `Promise.all(cards.map(async...))` を逐次`for...of`ループに変更(発見A)。~~ **完了(2026-09-11)**
2. ~~`matchup-card.ts`: プレースホルダーカードDOM挿入直後に`await yieldToBrowser()`を1回追加(発見B)。~~ **完了(2026-09-11)**
3. ~~`team-select-dialog.ts`: box同様の「closeDialog()先行+rAF+dispatchEvent」パターンを移植。~~ **完了(2026-09-11)**。`selectTeam()`はURL復元経路とも共用のため、`closeDialog()`はダイアログ側のclickハンドラで`selectTeam()`より先に呼び、rAFは`selectTeam()`内のdispatchを包む形にした。
4. ~~`matchup-card.ts`: `initEngine()`の呼び出しタイミングを前倒し(発見C)。~~ **完了(2026-09-11)**
5. team選択時のオプティミスティックUI(6体分の立ち絵URL事前抽出、box側の仕組みの横展開)。
6. 相手側実数値・技カテゴリのrun()横断キャッシュ化。
7. Web Worker化(中期・大規模投資)。

## 実装時の注意

- 効果検証は、このセッションで使った手法(Performance Observerのlongtaskをprobeスクリプトのevalから購読し、クリック→計算完了までの最大フレームギャップ/longtask長を実測)を再利用する。感覚だけで「直った」と判断しない。
- box(1体)・team(2〜6体)の両方で、修正前後の実測値を比較すること。特に発見Aの修正はteam選択でこそ効果が大きいはずなので、team側の検証を欠かさない。
- 1〜4は既存の設計・関数シグネチャへの影響が小さい修正。5・6は中コスト。7(Web Worker化)は設計変更が大きいため、着手前に方針をユーザーと相談すること。
