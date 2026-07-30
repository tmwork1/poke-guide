// box/[id].astro 構造分割ラウンド(フェーズ2)。
//
// 右サイド(詳細設定サイドバー、#damage-detail-panel)専用のロジック一式
// (docs/plan/ui_parallelization.md 4.1節「右サイド専用16」)。元は box/[id].astro の
// <script> 内、`if (opponentNotesSection) { ... }` ブロックのうち
// 「--- 詳細設定サイドバー ---」以降にまとまって定義されていたもので、ロジックは
// 一切変更せずこのファイルへ移設した(定義位置の変更のみ)。
//
// ダメージ計算(damage-calc.ts)とは scheduleRowSave/scheduleRowCalc/refreshRowConditionChips/
// selectColumn/renderDetailPanel/getSelectedRow/getSelectedColumn/clearSelection(いずれも
// shared-core.ts経由。フェーズ1で確立済み)に加え、DAMAGE_WEATHERS/DAMAGE_TERRAINS/
// DAMAGE_AILMENTS/DAMAGE_ATTACKER_VOLATILES/DAMAGE_DEFENDER_VOLATILES/clampInt(damage-calc.ts
// からexport、後述)・deselectRowIfCurrent/renderDetailPanelEmpty/renderColumnLevelDetailPanel/
// openDetailPanelOverlayIfNarrow(このファイルからdamage-calc.tsへexport)という2方向の
// 依存がある(コーディネーターへの報告事項: damage-calc.ts⇄right-panel.tsは相互import。
// いずれも関数宣言(hoistされ、循環import下でも安全)またはモジュール top-level で
// 即時評価されない値のみを跨いでいるため、実行時の初期化順序に問題は無い)。
//
// このファイルは damage-calc.ts の #opponent-notes-section ガード内から
// `initRightPanel()` を1回呼ばれることで初期化される(#damage-detail-panel 等は
// #opponent-notes-section と常に同時にSSR描画されるため、ガードの共有は安全)。
import { el } from "../owned-pokemon-form";
import { officialArtworkUrl } from "../pokemon-master-data";
import {
	applySprite,
	scheduleRowCalc,
	scheduleRowSave,
	refreshRowConditionChips,
	getSelectedRow,
	clearSelection,
	renderDetailPanel,
	type DamageRowState,
	type DamageColumnState,
} from "./shared-core";
import {
	DAMAGE_WEATHERS,
	DAMAGE_TERRAINS,
	DAMAGE_AILMENTS,
	DAMAGE_ATTACKER_VOLATILES,
	DAMAGE_DEFENDER_VOLATILES,
	clampInt,
} from "./damage-calc";

// --- 詳細設定サイドバー(ラウンド5ユーザー指示・要件9) ---
// ⚙クリックで<dialog>を開く方式をやめ、カードを選択すると右サイドバー
// (#damage-detail-panel、静的マークアップ)に詳細設定を表示する方式にする。
// 「カードの面積による制限を気にしなくてよくなるので、レイアウトの自由度が
// 生まれる」というのがユーザーの弁。1600px以上では常時表示のパネル(3カラム目)、
// それ未満では右からのオーバーレイになる(scoped <style>の@media (min-width:1600px)参照)。
// ラウンド6ユーザー指示(要件2): 選択対象が「カード全体(相手ビルドの箱)」と
// 「特定の技列」の2階層になったため、selectedRowだけでなく現在どちらの粒度が
// 選ばれているかをselectedColumnで持つ(null=カード全体、非null=その技列)。
// selectedRow/selectedColumn自体は構造分割ラウンド(フェーズ1)でshared-core.tsへ
// 移設し(selectColumn/applySelectionMarks/renderDetailPanelと同じ場所)、この
// <script>からはgetSelectedRow/getSelectedColumn/clearSelectionの3アクセサ経由で
// 読み書きする(上のimport参照)。
// 構造分割ラウンド(フェーズ2): 元は const + その場でのel()呼び出しだったが、
// このファイル単体では#damage-detail-panel等が存在する保証が無い(damage-calc.ts側の
// #opponent-notes-sectionガードに依存する)ため、let宣言にして実際の取得は
// 下のinitRightPanel()(damage-calc.tsのガード内から1回だけ呼ばれる)に移した。
// 値・取得内容は一切変えていない。
let detailPanelEl: HTMLElement;
let detailPanelBodyEl: HTMLElement;
let detailPanelCloseButton: HTMLButtonElement;
let detailBackdropEl: HTMLElement;

export function isWideSidebarLayout(): boolean {
	return window.matchMedia("(min-width: 1600px)").matches;
}
// 1600px未満ではオーバーレイ(スライドイン+背景)として開閉する。
// 1600px以上は常時表示の3カラム目なので開閉操作自体が不要。
export function openDetailPanelOverlayIfNarrow(): void {
	if (isWideSidebarLayout()) return;
	detailPanelEl.classList.add("is-open");
	detailBackdropEl.hidden = false;
}
export function closeDetailPanelOverlay(): void {
	detailPanelEl.classList.remove("is-open");
	detailBackdropEl.hidden = true;
}

// 空状態(要件9: 未選択時の見せ方)。ページ表示直後・行削除直後もこれを表示する。
// ラウンド6ユーザー指示(要件1): ⚙ボタンを廃止したため、案内文もクリック領域の
// 説明に置き換えた。ラウンド7ユーザー指示(方針転換): 相手ビルドの箱のクリックは
// 無反応になったため、案内文からも「相手ビルドの箱をクリック」の記述を除く。
// 🔴 UI改善ラウンド29(29-R1)「空状態の文言が、存在しない技列のクリックを促している」:
// この空状態(技0件・ダメージ計算0件など)では中央カラムも空状態のCTA
// (「+ ダメージ計算を追加」)だけで、クリックできる技列自体が存在しない。
// 実際に押せる操作(相手ポケモンの登録)を指す文言に差し替える(round-29.mdの
// 提案例をそのまま採用)。あわせて.damage-detail-panel-body-innerでラップし、
// margin-block:autoによる上下中央寄せ(29-R1)の対象にする。
export function renderDetailPanelEmpty(): void {
	detailPanelBodyEl.innerHTML = "";
	const inner = document.createElement("div");
	inner.className = "damage-detail-panel-body-inner";
	const p = document.createElement("p");
	p.className = "damage-detail-panel-empty";
	p.textContent = "相手ポケモンを登録すると、ここに設定が表示されます。";
	inner.appendChild(p);
	detailPanelBodyEl.appendChild(inner);
}

// ラウンド5ユーザー指示(要件10): 天候・フィールドはセレクトをやめてアイコン選択式にする。
// ラウンド6で行レベル/技列レベルの2つのパネルから共用する汎用部品として独立させた
// (どちらのパネルが呼んでも見た目・挙動は同じ)。
// ラウンド11ユーザー指示(実装リスク3・任意対応): ariaLabelを渡した呼び出し元だけ
// グループにaria-labelを付与する(role="radiogroup"に対してアクセシブルな名前が
// 無かった既存の不整合を、状態異常アイコン化のついでに軽く補う。必須要件ではない)。
// ⚠️ ラウンド24ユーザー指示(24-R1)「選択中のボタンを再度クリックすると未選択(なし相当)に
// 戻るようにする」により、クリックハンドラを変更する。以前は常にクリックしたボタンを
// 選択状態にしていた(=常にどれか1つが選択されている前提)が、天候・フィールドから
// 「なし」の選択肢自体を削除した(24-R1、上のDAMAGE_WEATHERS/DAMAGE_TERRAINS参照)ため、
// 「どれも選択されていない」状態を表現する手段が必要になった。既に選択中(aria-pressed=
// "true")のボタンをもう一度押した場合はvalue=""(トグルオフ)を通知する。
export function buildIconToggleGroup(
	options: Array<{ value: string; label: string; icon: string }>,
	current: string,
	onChange: (value: string) => void,
	ariaLabel?: string,
): HTMLElement {
	const group = document.createElement("div");
	group.className = "damage-detail-icon-group";
	group.setAttribute("role", "radiogroup");
	if (ariaLabel) group.setAttribute("aria-label", ariaLabel);
	for (const opt of options) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "damage-detail-icon-btn";
		button.setAttribute("aria-pressed", String(opt.value === current));
		button.title = opt.label;
		button.innerHTML = opt.icon;
		const labelSpan = document.createElement("span");
		labelSpan.textContent = opt.label;
		button.appendChild(labelSpan);
		button.addEventListener("click", () => {
			const wasPressed = button.getAttribute("aria-pressed") === "true";
			for (const child of Array.from(group.children)) {
				(child as HTMLElement).setAttribute("aria-pressed", "false");
			}
			if (wasPressed) {
				// 24-R1: 選択中のボタンの再クリックは「なし」(value: "")に戻す
				// (全ボタンaria-pressed=falseの状態を作る)。
				onChange("");
			} else {
				button.setAttribute("aria-pressed", "true");
				onChange(opt.value);
			}
		});
		group.appendChild(button);
	}
	return group;
}

// ラウンド24ユーザー指示(24-R2)「テラスタル発動・急所・揮発状態・壁のチェックボックスを、
// 天候・フィールドと同じ『クリックでONになるボタン』に置き換える」。テラス/急所/壁は
// 単一のON/OFF(boolean)、揮発状態は複数選択(配列)だが、いずれも「他の項目との排他制御を
// 持たない独立したトグル」という点でweather/フィールド(単一選択のradiogroup)とは選択
// モデルが異なるため、buildIconToggleGroup()を排他選択のまま流用せず、1個のboolean
// トグルボタンを作る専用の軽量関数を新設する(複数個並べれば複数選択группが作れる:
// 揮発状態はこの関数をoptions.lengthぶん呼ぶだけで済み、複数選択用の別モードを
// buildIconToggleGroup()に増設する二重実装を避けられる)。
// 見た目は天候/フィールドの.damage-detail-icon-btnをそのまま流用し、アイコンを
// 持たない(テキストのみの)ボタンなので.is-text-onlyで縦積みflexを横並びに変える
// モディファイアだけを追加する(色・枠・aria-pressed時の強調はicon-btnの基底ルールを
// 継承するため二重定義しない)。
export function buildToggleButton(
	label: string,
	pressed: boolean,
	onChange: (pressed: boolean) => void,
	options?: { title?: string; disabledTitle?: string },
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "damage-detail-icon-btn is-text-only";
	button.setAttribute("aria-pressed", String(pressed));
	button.textContent = label;
	if (options?.disabledTitle) {
		button.disabled = true;
		button.setAttribute("aria-disabled", "true");
		button.title = options.disabledTitle;
	} else if (options?.title) {
		button.title = options.title;
	}
	button.addEventListener("click", () => {
		const next = button.getAttribute("aria-pressed") !== "true";
		button.setAttribute("aria-pressed", String(next));
		onChange(next);
	});
	return button;
}

// 攻撃側/防御側で共通の「能力ランク(1入力)+状態異常+テラスタル発動(+急所)」
// ブロックを作る(ラウンド6で技列レベルパネル専用の部品として独立させた。
// row/scheduleRowCalc/scheduleRowSave/refreshRowConditionChipsは明示的に
// 引数で受け取り、呼び出し側のクロージャに依存しない)。
// ラウンド5ユーザー指示(要件12): 「攻撃側5能力+防御側5能力=セレクト10個」を
// やめ、攻守それぞれ1つの入力にする。エンジン(pyodide-engine.ts)のPokemonSpec.boosts
// は能力ごとのランク配列を受け取る実装なので、実際に渡す配列はresolveColumn
// DerivedFields()が技の物理/特殊分類にもとづき、攻撃側はA(攻撃)/C(特攻)、
// 防御側はB(防御)/D(特防)のどちらに載せるかを振り分けて組み立てる
// (素早さランクはダメージ計算に影響しないため入力自体を落とした)。
// ラウンド3 A-6(4)由来: 急所固定は「攻撃側が急所を出すか」の設定なので攻撃側へ統合。
// ラウンド11ユーザー指示(要件11-7・省スペース化): この関数の出力を「見出し+能力ランク」
// 1行/「テラスタル(+急所)」チェック1行/状態異常アイコン1行、の3行構成に圧縮した。
// 能力ランクは<select>(-6〜+6の13択)から<input type="number">のネイティブ
// スピンボックスに置き換える。min/maxはキー入力を止めないため、input/blur両方で
// [-6,6]にclampする(矢印クリック・キーボード編集どちらの変更もinputイベントで拾う。
// blurは「空欄のまま離れた」場合を0にフォールバックさせるための保険)。フォーカス中の
// wheelで値が変わる事故はpreventDefaultで防ぐ。iOSで矢印が出ないためinputmode="numeric"
// を付与する(ネイティブspinnerの矢印自体は出したいのでCSSでは消さない)。
// ラウンド17指摘(A-1・実バグ): teraTypeValueは、この側(攻撃側 or 防御側)が
// 実際に使っているポケモンの現在のテラスタイプ文字列(空文字="テラスなし")。
// jpokeはteraType未指定でテラスタル発動すると自身の第1タイプへ黙ってフォールバックし、
// 意図せず2.0倍のタイプ一致補正がかかる(画面表示は「テラスなし」のまま)。
// `.claude/skills/jpoke/references/ruleset.md` §4「テラスタイプ未指定時のデフォルト」・
// `damage-calc.md` 3補参照。呼び出し側(renderColumnLevelDetailPanel)が
// 攻撃側/防御側それぞれについて、対応するビルド(この個体の#tera select、または
// 相手ビルド箱のrow.teraType)の現在値をそのまま渡す。
// ラウンド23ユーザー指示(23-R3)「攻撃側と防御側の設定は、パネルを左右2分割して
// 並べて配置」に対応するため、appendChild先を呼び出し側から受け取る
// parentEl引数に変更した(従来はdetailPanelBodyEl固定)。呼び出し側
// (renderColumnLevelDetailPanel)が.damage-detail-side(攻撃側/防御側それぞれの
// 列コンテナ)を渡すことで、このセクション1つぶんの中身(見出し+ランク/
// テラス+急所/状態異常/揮発状態)がその列の中に積まれる。
// 🔴 ラウンド25ユーザー指示(25-R1)「急所を独立した帯として天候より前に出す」により、
// 急所(critical)はこの関数から切り離し、renderColumnLevelDetailPanelの先頭で
// 単独の帯として描画するように変更した(呼び出し元の引数からcritical/
// onCriticalChangeを削除。防御側は元々undefinedだったため呼び出し元も
// 単純化される)。
// 🔴 UI改善ラウンド28ユーザー指示(28-R3)「攻撃(自分)→攻撃側に変更」により、titleは
// row.directionによらず固定文字列("攻撃側"/"防御側")になった。「自分/相手」の
// 区別が可視テキストから消えるため、aria-label専用にariaSideLabel引数を新設する
// (呼び出し側=renderColumnLevelDetailPanelがrow.directionから組み立てた
// "攻撃側(自分)"/"攻撃側(相手)"等を渡す)。titleは改名していない。
export function buildSideSection(
	parentEl: HTMLElement,
	row: DamageRowState,
	title: string,
	ariaSideLabel: string,
	rank: number,
	ailment: string,
	terastallized: boolean,
	teraTypeValue: string,
	onRankChange: (value: number) => void,
	onAilmentChange: (value: string) => void,
	onTeraChange: (value: boolean) => void,
	// ラウンド20ユーザー指示(20-R3): 揮発状態。攻撃側/防御側で効果のある項目が
	// 異なる(DAMAGE_ATTACKER_VOLATILES/DAMAGE_DEFENDER_VOLATILES参照)ため、
	// 選択肢配列は呼び出し側(renderColumnLevelDetailPanel)がどちらの側かに
	// 応じて渡す。
	volatilesOptions: { value: string; label: string }[],
	volatilesValue: string[],
	onVolatilesChange: (value: string[]) => void,
	// 🔴 UI改善ラウンド29(29-R3)「攻撃側・防御側のチップ列が列幅の半分しか
	// 使っていない」: 攻撃側は状態異常・テラスタル・じゅうでん(volatilesOptionsの
	// 唯一の項目)を1行にまとめる指示のため、この1件だけは下のchipRowへ混ぜ込む。
	// 防御側の9件の揮発状態は従来どおり独立したグループのまま(呼び出し側
	// =renderColumnLevelDetailPanelがtrue/falseを渡す)。
	// 🔴 UI改善ラウンド32ユーザー指示(32-R4)「攻撃側の2段目は、急所,じゅうでんの順に
	// 同じグループとして配置」対応: mergeVolatileIntoChipRow=trueの側(攻撃側)では
	// じゅうでんを1段目のchipRowではなく新設の2段目(chipRow2)へ入れ、その要素を
	// 呼び出し元へ返す(呼び出し元が急所ボタンをchipRow2の先頭に挿入するため)。
	// 防御側(false)ではchipRow2を作らずnullを返す。
	mergeVolatileIntoChipRow: boolean,
): HTMLElement | null {
	// ラウンド25ユーザー指示(25-R1)「ランク、状態異常を同じグループにする」により、
	// 見出し+ランクの行と状態異常の行を1つのグループ(.damage-detail-group)に
	// まとめる(グループ化のCSSはCSS側の#damage-detail-panel-body
	// .damage-detail-group参照)。
	const rankAilmentGroup = document.createElement("div");
	rankAilmentGroup.className = "damage-detail-group";
	parentEl.appendChild(rankAilmentGroup);

	// 1行目: 見出し(左)+能力ランクのスピンボックス(右)。
	const headingRow = document.createElement("div");
	headingRow.className = "damage-detail-side-heading-row";
	const heading2 = document.createElement("p");
	heading2.className = "damage-detail-section-heading";
	// 🔴 UI改善ラウンド29(29-R2)「攻撃側/防御側がどちらの個体か色でも判別できない」:
	// 見出しの文言自体は変えず(28-R3のユーザー指示に抵触するため)、区切り線・
	// ラベル文字色をカードの攻撃/防御トグルと同じ赤/青トークンに転用する(CSS側の
	// .damage-detail-sides / .damage-detail-side + .damage-detail-side 参照)。
	// 色だけに依存しない代替(WCAG 1.4.1)として、既存アイコンの転用が実在しない
	// ため(実装者の判断、CSS側コメント参照)新設した形状マーカーを見出し直後に添える。
	const sideIcon = document.createElement("span");
	sideIcon.className = `damage-detail-side-icon ${title === "攻撃側" ? "is-attack" : "is-defense"}`;
	sideIcon.setAttribute("aria-hidden", "true");
	heading2.append(sideIcon, document.createTextNode(title));
	headingRow.appendChild(heading2);

	const rankField = document.createElement("div");
	rankField.className = "damage-detail-rank-field";
	const rankLabel = document.createElement("span");
	rankLabel.textContent = "ランク";
	const rankInput = document.createElement("input");
	rankInput.type = "number";
	rankInput.min = "-6";
	rankInput.max = "6";
	rankInput.step = "1";
	rankInput.inputMode = "numeric";
	rankInput.className = "damage-detail-rank-input";
	rankInput.value = String(rank);
	rankInput.setAttribute("aria-label", `${ariaSideLabel}の能力ランク`);
	const updateEmphasis = () => {
		const n = Number(rankInput.value);
		rankInput.classList.toggle("is-nonzero", Number.isFinite(n) && n !== 0);
	};
	updateEmphasis();
	// 矢印クリック・キーボード編集どちらもcommitへ集約する。空欄・"-"単体(入力途中)は
	// まだ矯正しない(毎キー入力で値を書き戻すとユーザーが"-6"を打てなくなるため)。
	const commitRank = (fallbackToZeroIfEmpty: boolean): void => {
		const raw = rankInput.value.trim();
		if (!fallbackToZeroIfEmpty && (raw === "" || raw === "-")) return;
		const n = raw === "" || raw === "-" || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
		const clamped = clampInt(n, -6, 6);
		if (rankInput.value !== String(clamped)) rankInput.value = String(clamped);
		onRankChange(clamped);
		updateEmphasis();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	};
	rankInput.addEventListener("input", () => commitRank(false));
	rankInput.addEventListener("change", () => commitRank(true));
	rankInput.addEventListener("blur", () => commitRank(true));
	// フォーカス中にホイールを回すと値が変わる事故を防ぐ(passiveだと
	// preventDefaultが効かないため { passive: false } で明示登録する)。
	rankInput.addEventListener(
		"wheel",
		(e) => {
			if (document.activeElement === rankInput) e.preventDefault();
		},
		{ passive: false },
	);
	rankField.append(rankLabel, rankInput);
	// ラウンド28ユーザー指示(28-R5)「ランク入力欄はタイトルの次の行に移動」により、
	// このrankFieldはheadingRow(見出しの次の行)に置いていた。
	// 🔴 UI改善ラウンド31ユーザー指示(31-R3)「ランク・状態異常・テラスタルは横並びに
	// 配置」により、rankFieldをheadingRowから外し、下のchipRow(状態異常・テラスタル
	// と同じ横並びの行)の先頭要素にする(見出し単独行→ランク・状態異常・テラスタルが
	// 横並びの1行、という2行構成になる)。
	rankAilmentGroup.appendChild(headingRow);

	// ラウンド29ユーザー指示(29-R3)「攻撃側・防御側のチップ列が列幅の半分しか
	// 使っていない」により、状態異常select・テラスタルボタン(・攻撃側だけは
	// じゅうでんボタン)を1つの.damage-detail-chip-row(flex-wrap)にまとめていた。
	// 🔴 UI改善ラウンド31ユーザー指示(31-R3)により、ランク(rankField)もこの行に
	// 加える(先頭に追加。ランク→状態異常→テラスタル(→じゅうでん)の順は
	// これまでの読み取り順を維持する)。これらは独立したトグル/セレクトで
	// 意味的な上下関係を持たないため、横並びにしても読み取り順は変わらない
	// (round-29.md 29-R3と同じ考え方)。旧teraGroup/compactRow・ailmentRowは
	// 廃止し、rankAilmentGroup直下のこのchipRow1つに統合する。
	const chipRow = document.createElement("div");
	chipRow.className = "damage-detail-chip-row";
	rankAilmentGroup.appendChild(chipRow);
	chipRow.appendChild(rankField);

	// 状態異常の<select>(「11-8の修正」ユーザー指示で、ラウンド11の
	// アイコントグル化からリスト選択方式に戻した。選択肢が何個あっても表示は
	// 常に1行というのが「場所をとる」問題の解消に最も直接的なため、天候/
	// フィールドのようなbuildIconToggleGroup()化はせずネイティブ<select>にする。
	// ゆめうつつはDAMAGE_AILMENTSの時点で除外済み)。
	// ラウンド25ユーザー指示(25-R2)「可視ラベルを削除しplaceholder風にする」により
	// 可視ラベル(旧ailmentLabel)は生成しない。aria-label/titleで意味を残す。
	const ailmentSelect = document.createElement("select");
	ailmentSelect.className = "damage-detail-ailment-select";
	ailmentSelect.setAttribute("aria-label", `${ariaSideLabel}の状態異常`);
	ailmentSelect.title = "状態異常";
	// 🔴 UI改善ラウンド28ユーザー指示(28-R8)「状態異常のplaceholderを『なし』→
	// 『状態異常』に変更」: ネイティブ<select>は選択中<option>のtextContentを
	// 閉時/開時どちらの表示にも同じ文字列で使うため、単純にDAMAGE_AILMENTSの
	// value=""ラベルを書き換えると開いたリスト側にも「状態異常」という選択肢に
	// 見えてしまう(意味が壊れる。round-28.mdが名指しで警告している事故)。
	// そのため、リストには現れない(hidden)専用のプレースホルダoptionを先頭に
	// 追加し、value=""のときは常にこちらを選択中にする。リストから選べる
	// 「なし」(DAMAGE_AILMENTSそのまま、value=""を明示的に選び直すための実体)は
	// 別optionとして残す。DAMAGE_AILMENTSのvalue自体(jpokeのAilmentNameと一致する
	// 契約)は一切変えない。
	const ailmentPlaceholderOpt = document.createElement("option");
	ailmentPlaceholderOpt.value = "";
	ailmentPlaceholderOpt.textContent = "状態異常";
	ailmentPlaceholderOpt.hidden = true;
	ailmentPlaceholderOpt.selected = ailment === "";
	ailmentSelect.appendChild(ailmentPlaceholderOpt);
	for (const opt of DAMAGE_AILMENTS) {
		const optionEl = document.createElement("option");
		optionEl.value = opt.value;
		optionEl.textContent = opt.label;
		// value===""(DAMAGE_AILMENTSの先頭「なし」)は上のhiddenプレースホルダ側を
		// 既定選択にするため、ここではselectedにしない(二重にselectedを付けると
		// 後勝ちでこちらが選ばれてしまい、閉時表示が「なし」に戻ってしまう)。
		if (opt.value === ailment && opt.value !== "") optionEl.selected = true;
		ailmentSelect.appendChild(optionEl);
	}
	// ラウンド24(24-L3)のテラスなしplaceholder化と同じ視覚言語(破線枠+
	// 透明背景+muted文字色、CSSは.damage-detail-ailment-select.is-ailment-unselected
	// 参照)を、状態異常「なし」(value==="")選択中にも適用する。
	function updateAilmentPlaceholderState(): void {
		ailmentSelect.classList.toggle("is-ailment-unselected", ailmentSelect.value === "");
	}
	updateAilmentPlaceholderState();
	ailmentSelect.addEventListener("change", () => {
		onAilmentChange(ailmentSelect.value);
		// 28-R8: ユーザーがリストの「なし」(可視option、value="")を選んだ場合、
		// 選択状態をhiddenのプレースホルダ(index0、同じvalue="")に付け替えて、
		// 閉じているときの表示を常に「状態異常」に揃える(なし/状態異常のどちらを
		// 経由しても、value=""である限り閉時表示は一定にする)。selectedIndexの
		// 変更はchangeイベントを再発火しないため無限ループにはならない。
		if (ailmentSelect.value === "") ailmentSelect.selectedIndex = 0;
		updateAilmentPlaceholderState();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	});
	chipRow.appendChild(ailmentSelect);

	// テラスタルボタン(急所は25-R1でこの関数から切り離し、
	// renderColumnLevelDetailPanelの先頭に独立した帯として移した)。
	// ラウンド24ユーザー指示(24-R2)「テラスタル発動・急所・揮発状態・壁のチェックボックスを、
	// 天候・フィールドと同じ『クリックでONになるボタン』に置き換える」により、
	// <input type="checkbox">+<label>をbuildToggleButton()(単一boolean用トグルボタン、
	// 上のbuildIconToggleGroupの直後に新設)に置き換える。
	// ラウンド17指摘(A-1・実バグ): テラスタイプが未設定(""=「テラスなし」)のビルドで
	// 発動すると、jpokeが黙って第1タイプへフォールバックし無警告で2.0倍の
	// タイプ一致補正がかかる。対応するビルドのテラスタイプが空のときはボタン
	// 自体をdisabledにし、常時見えるテキスト+titleの両方で理由を示す(推奨案どおり。
	// 「代替案」の表示だけで済ませる案は、押せてしまう=誤って2倍を発動できて
	// しまう余地を残すため不採用)。pressedは「有効かつterastallized」で決める
	// (無効なのに見た目だけON済みという矛盾状態を作らない)。
	const teraAvailable = teraTypeValue !== "";
	// ラウンド23ユーザー指示(23-R3)「テラスタル」(5文字)→「テラス」(3文字)に
	// 短縮していたが、🔴 ラウンド28ユーザー指示(28-R6)「テラス(未設定)→
	// テラスタルに表記変更」により撤回する。
	const teraButton = buildToggleButton(
		"テラスタル",
		teraAvailable && terastallized,
		(pressed) => {
			onTeraChange(pressed);
			scheduleRowCalc(row);
			scheduleRowSave(row);
			refreshRowConditionChips(row);
		},
		teraAvailable
			? { title: "テラスタル発動" }
			: {
				disabledTitle:
					"テラスタイプが未設定のため使用できません(未設定のままテラスタル発動すると、" +
					"元の第1タイプへ自動フォールバックし意図しない2倍のタイプ一致補正になるため)",
			},
	);
	chipRow.appendChild(teraButton);
	if (!teraAvailable) {
		const teraNote = document.createElement("span");
		teraNote.className = "damage-detail-tera-note";
		// 🔴 ラウンド28ユーザー指示(28-R6)「テラスタル」表記変更後は「(未設定)」注記に
		// 「テラスタル(未設定)」のような意味の重複が出るため表示しない(CSSで
		// display:none、#damage-detail-panel-body .damage-detail-tera-note参照)。
		// DOM自体は残す(pitfalls.mdの「要素を消す指示でもDOMは残す」方針)。理由は
		// teraButtonのdisabledTitleに残っているため、disabled+titleを消さない限り
		// 情報は失われない(⚠️ ラウンド17 A-1のdisabled挙動は変更していない)。
		teraNote.textContent = "(未設定)";
		chipRow.appendChild(teraNote);
	}

	// 🔴 UI改善ラウンド29(29-R3): 攻撃側だけ、揮発状態の唯一の項目(じゅうでん)を
	// 1段目のchipRowではなく独立した2段目(chipRow2)へ混ぜ込む(mergeVolatileIntoChipRow=
	// true)。防御側(9件)は従来どおり独立したグループのまま(下のelse節)。
	// 🔴 UI改善ラウンド32ユーザー指示(32-R4)「攻撃側の2段目は、急所,じゅうでんの順に
	// 同じグループとして配置」により、29-R3時点では1段目のchipRowに混ぜていた
	// じゅうでんを、新設の2段目(secondaryChipRow、同じ.damage-detail-chip-rowクラス)へ
	// 分離する。呼び出し元(renderColumnLevelDetailPanel)がこの行を返り値として受け取り、
	// 急所ボタンをこの行の先頭に挿入する(1段目=ランク/状態異常/テラスタルは変更なし、
	// 2段目=急所→じゅうでんの順になる)。
	let secondaryChipRow: HTMLElement | null = null;
	if (mergeVolatileIntoChipRow && volatilesOptions.length > 0) {
		secondaryChipRow = document.createElement("div");
		secondaryChipRow.className = "damage-detail-chip-row";
		rankAilmentGroup.appendChild(secondaryChipRow);
		for (const opt of volatilesOptions) {
			const optButton = buildToggleButton(
				opt.label,
				volatilesValue.includes(opt.value),
				() => {
					// この行にはじゅうでん以外にも急所ボタン(呼び出し元が挿入)が
					// 同居しうるため、data-volatile-value属性を持つボタンだけに
					// 限定して現在の選択状態を読み直す(旧chipRow版と同じ考え方)。
					const next = Array.from(
						secondaryChipRow!.querySelectorAll<HTMLButtonElement>('button[data-volatile-value][aria-pressed="true"]'),
					).map((btn) => btn.dataset.volatileValue ?? "");
					onVolatilesChange(next);
					scheduleRowCalc(row);
					scheduleRowSave(row);
					refreshRowConditionChips(row);
				},
			);
			optButton.dataset.volatileValue = opt.value;
			secondaryChipRow.appendChild(optButton);
		}
	}

	// 揮発状態(volatile)。ラウンド20ユーザー指示(20-R3)で追加。
	// 選択肢が無い側(このラウンドの実測では発生しない想定だが、将来の分類変更に
	// 備えて防御的に)は行自体を出さない。
	// ラウンド24ユーザー指示(24-R2)「揮発状態は複数選択のままにすること(単一選択の
	// radiogroupにしないこと)」。buildToggleButton()はボタン同士に排他制御を
	// 一切持たせない単発トグルなので、選択肢の数だけ独立して並べれば
	// そのまま複数選択(multi-select)になる(buildIconToggleGroup()側に
	// 複数選択モードを増設する二重実装を避けられる)。
	// ラウンド25ユーザー指示(25-R1)「その他の状態(揮発状態)を別グループにする」により
	// 独立した.damage-detail-groupに包む。
	// 🔴 UI改善ラウンド29(29-R3): 上でmergeVolatileIntoChipRow=true(=攻撃側)で
	// 処理済みの場合はこの独立グループを作らない(二重表示を避ける)。防御側
	// (mergeVolatileIntoChipRow=false)は従来どおりここで独立グループを作る。
	if (!mergeVolatileIntoChipRow && volatilesOptions.length > 0) {
		const volatileGroupWrap = document.createElement("div");
		// ラウンド27ユーザー指示(27-R3)「防御側で壁のボタンを揮発状態より前に配置する」
		// に対応するため、呼び出し側(renderColumnLevelDetailPanel)がこのグループを
		// 目印にwallRowをinsertBeforeできるよう、追加のクラス
		// (damage-detail-volatile-wrap)を付ける(damage-detail-groupの見た目は
		// そのまま維持する追加クラスで、シグネチャは変えない)。
		volatileGroupWrap.className = "damage-detail-group damage-detail-volatile-wrap";
		parentEl.appendChild(volatileGroupWrap);
		const volatileRow = document.createElement("div");
		volatileRow.className = "damage-detail-volatile-row";
		// 🔴 UI改善ラウンド28ユーザー指示(28-R9)「その他の状態、の表記を削除」により、
		// この可視ラベルはCSSで非表示にする(#damage-detail-panel-body
		// .damage-detail-volatile-row-label、display:none)。DOM自体は残す。
		// 代わりに揮発状態ボタン群のコンテナ(volatileGroup)にrole="group"+
		// aria-labelを付け、スクリーンリーダー利用者にもグループの意味が
		// 伝わるようにする(視覚的に消しても読み上げ情報は落とさない)。
		const volatileLabel = document.createElement("span");
		volatileLabel.className = "damage-detail-volatile-row-label";
		volatileLabel.textContent = "その他の状態";
		volatileRow.appendChild(volatileLabel);
		const volatileGroup = document.createElement("div");
		volatileGroup.className = "damage-detail-volatile-group";
		volatileGroup.setAttribute("role", "group");
		volatileGroup.setAttribute("aria-label", `${ariaSideLabel}のその他の状態`);
		// ⚠️ 実装時に踏んだ罠(チェックボックス時代から維持): `next` を「引数の
		// volatilesValue(パネル描画時点のスナップショット)を都度フィルタして作る」
		// 実装にすると、同じパネルを開いたまま2個目以降のボタンを操作したときに
		// 古いスナップショットを基準にしてしまい、直前の操作が消える(1個目だけなら
		// 偶然「空配列→空配列」で症状が出ず気付きにくい)。DOM(このグループ内の
		// button[aria-pressed="true"])を都度直接読み直すことで、何個・どの順で
		// 操作しても常に「今画面に見えている選択状態」と一致させる。
		for (const opt of volatilesOptions) {
			const optButton = buildToggleButton(
				opt.label,
				volatilesValue.includes(opt.value),
				() => {
					// 🔴 UI改善ラウンド32ユーザー指示(32-R5)「かべをその他の状態と同じ
					// グループに入れる」対応: このvolatileGroupには呼び出し元
					// (renderColumnLevelDetailPanel)がかべボタンも挿入するようになった
					// (data-volatile-value属性を持たない)。フィルタを付けないと
					// かべのon/off状態が空文字列としてvolatilesValueに混入してしまうため、
					// data-volatile-value属性を持つボタンだけに限定する(攻撃側chipRow2と
					// 同じ考え方)。
					const next = Array.from(
						volatileGroup.querySelectorAll<HTMLButtonElement>('button[data-volatile-value][aria-pressed="true"]'),
					).map((btn) => btn.dataset.volatileValue ?? "");
					onVolatilesChange(next);
					scheduleRowCalc(row);
					scheduleRowSave(row);
					refreshRowConditionChips(row);
				},
			);
			optButton.dataset.volatileValue = opt.value;
			volatileGroup.appendChild(optButton);
		}
		volatileRow.appendChild(volatileGroup);
		volatileGroupWrap.appendChild(volatileRow);
	}
	return secondaryChipRow;
}

// 技列1枚だけの設定パネル。ラウンド7ユーザー指示(方針転換)で「カード全体設定」の
// 概念自体を廃止したため、天候・フィールド・壁もここに統合し、急所・能力ランク・
// 状態異常・テラスタル発動と合わせて全項目をこのcolumn(技カード)1枚だけに
// 書き込む(行内の他の技列には一切波及させない)。
export function renderColumnLevelDetailPanel(row: DamageRowState, column: DamageColumnState): void {
	detailPanelBodyEl.innerHTML = "";
	const idx = row.attacks.indexOf(column);
	if (idx === -1) {
		// 選択していた技列がすでに削除されている(削除ボタン連打等の取りこぼし対策)。
		// 選択自体を解除して空状態に戻す(カード全体設定という代替表示先はもう無い)。
		// selectedRow/selectedColumnはshared-core.tsへ移設したため、clearSelection()
		// 経由で解除する(構造分割ラウンド・フェーズ1。ロジック自体は変えていない)。
		clearSelection();
		renderDetailPanelEmpty();
		return;
	}

	// この技カード1枚だけを書き換えてから再計算・保存する共通ヘルパー。
	function applyToColumnField(mutate: () => void): void {
		mutate();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	}

	// 🔴 UI改善ラウンド29(29-R1)「右パネルの余剰空白」: 実際の中身をこの
	// .damage-detail-panel-body-inner 1個にまとめてからdetailPanelBodyElへ
	// appendする(is:global側のmargin-block:auto、CSS参照)。以降、このパネルに
	// 追加する要素はすべてdetailPanelBodyElではなくcontentWrapへappendする。
	const contentWrap = document.createElement("div");
	contentWrap.className = "damage-detail-panel-body-inner";
	detailPanelBodyEl.appendChild(contentWrap);

	// ラウンド23ユーザー指示(23-R1)「選択中カードのタイトルを削除」により、
	// 「{相手名}: 技N(技名)だけの設定」という<h3>見出し(旧
	// .damage-detail-row-heading)を削除した。「この技列だけに適用されます。」の
	// 説明文(ラウンド20 20-R1で死んだ要素として既にDOM削除済み)と合わせて、
	// このパネルにはもう「どの技列を編集中か」を示すテキストが無くなる。
	// ⚠️ 実機で確認: 技列側の選択強調(.damage-column.is-selected、primary実線+
	// box-shadow)が画面内に見えていれば、そのカードだけを見ればどの技列を
	// 編集中か判別できる。ただしカード列を横スクロール/縦スクロールして選択中の
	// 技列が画面外に出ると、パネル側だけを見ても対象が分からなくなる(以前は
	// この見出しがその代替情報源だった)。この退行は実際に確認できたため報告に
	// 明記する。
	// (対応するscoped<style>側の.damage-detail-row-headingルールも削除済み)。

	// ラウンド27ユーザー指示(27-R2)「急所も攻撃側の設定に移動する」で、ラウンド25
	// (25-R1)「急所を独立した帯として天候より前に出す」を一度撤回していたが、
	// ラウンド28ユーザー指示(28-R2)「急所を最上部に配置し、その下に横線を追加」
	// により25-R1の形(detailPanelBodyElの先頭に独立して置く)に一度戻していた。
	// 🔴 UI改善ラウンド31ユーザー指示(31-R2)「急所も攻撃側の設定に移動」により、
	// 28-R2を撤回し、27-R2の形(attackerSideの中)に戻す(下のattackerSide生成後の
	// 呼び出し箇所を参照)。急所が攻撃側だけの設定(防御側に急所は無い、ラウンド3
	// A-6(4)の判断)という仕様は変えない(column.criticalの読み書き先はそのまま)。
	// 🔴 UI改善ラウンド32ユーザー指示(32-R4)「攻撃側の2段目は、急所,じゅうでんの順に
	// 同じグループとして配置」により、急所を独立した.damage-detail-critical-row
	// (別の行)ではなく、じゅうでんと同じチップ行(buildSideSectionが作る2段目の
	// .damage-detail-chip-row)に混ぜる。そのため、ここでは行(div)を作らず
	// トグルボタン自体だけを返す(呼び出し側でチップ行の先頭にinsertBeforeする)。
	// .damage-detail-critical-row自体のCSS定義は他から参照されなくなったため削除した
	// (死んだCSSを残さない)。
	function buildCriticalButton(): HTMLButtonElement {
		return buildToggleButton(
			"急所",
			column.critical,
			(pressed) => {
				applyToColumnField(() => { column.critical = pressed; });
			},
			{ title: "急所固定で計算する(攻撃側だけの設定です)" },
		);
	}
	// ラウンド29(29-R4)「右パネルが『今どのカードの設定か』を示していない」対応として、
	// 「{相手名} — {技名}」というテキストのみの見出しを最上部に追加していた。
	// 🔴 UI改善ラウンド31ユーザー指示(31-R1)「最上部のタイトルはパネルor横棒で領域を
	// 区切る。文字ではなく、[自分アイコン] <攻撃方向矢印> [相手アイコン] <技名> の
	// ように絵的に表現する」により、テキストのみの構成を絵的な表現に作り替える。
	// クラス名.damage-detail-selection-headingは改名しない(このファイル内でこの
	// 1箇所のみが参照元)。
	// 矢印の向きはrow.direction(攻守切り替え)に追随させる: この個体が攻撃側の
	// ときは自分→相手(→)、受け側のときは相手→自分(←)にする
	// (00-foundation.md「攻守切り替え」節: attacker*を「常に所持ポケモン」と
	// 読んではいけない、という注意と同じ理由でrow.directionを見る。row.direction
	// !=="defense"なら自分が攻撃側)。
	// アイコンの並び順自体はユーザーの語順([自分アイコン]→[相手アイコン])どおり
	// 常に固定し、矢印の向きだけを反転させる(実装者の判断: カードを切り替える
	// たびに自分アイコンの左右位置が入れ替わると視線の基準点を見失うため、位置は
	// 固定して矢印だけ反転する方を採用した)。
	// アイコンサイズは新規規格を作らず、.damage-row-icon-button等で確立済みの
	// 28px規格を使う(CSSは#damage-detail-panel-body .damage-detail-selection-icon
	// 参照)。
	function buildSelectionHeadingRow(): HTMLElement {
		const heading = document.createElement("div");
		heading.className = "damage-detail-selection-heading";
		const opponentName = row.name.trim() || "(相手未設定)";
		// speciesInputは左パネル(LeftPanel.astro/left-panel.ts)のキャッシュ済み参照
		// だったが、構造分割ラウンド(フェーズ1)で#species-nameがそちらへ移設されたため、
		// この<script>からはel()で直接DOM参照する(同じ要素・同じ値、キャッシュの
		// 有無だけの違い)。
		const selfName = el<HTMLInputElement>("species-name").value.trim() || "(自分未設定)";
		const moveName = column.moveName.trim();
		const isSelfAttacking = row.direction !== "defense";

		const selfIcon = document.createElement("img");
		selfIcon.className = "damage-detail-selection-icon";
		selfIcon.alt = "";
		selfIcon.style.display = "none";
		const selfIconFallback = document.createElement("span");
		selfIconFallback.className = "damage-detail-selection-icon-fallback";
		void applySprite(selfIcon, selfIconFallback, el<HTMLInputElement>("species-name").value.trim(), officialArtworkUrl);

		// 🔴 UI改善ラウンド32ユーザー指示(32-R1)「矢印を太くて見やすいデザインに変更」
		// により、テキストの矢印文字からインラインSVGのシェブロンへ作り替える。
		// SVG自体は常に右向きの形状で作り、防御カード(isSelfAttacking===false)の
		// ときだけCSSのtransform: scaleX(-1)(.is-reversed、上のCSS参照)で反転する。
		// 31-R1で確立した「矢印の向きがdirectionに追随する」挙動(攻撃カードで
		// 「→」、防御カードで「←」)は壊さない。
		const arrowNs = "http://www.w3.org/2000/svg";
		const arrow = document.createElementNS(arrowNs, "svg");
		arrow.setAttribute("class", "damage-detail-selection-arrow");
		arrow.setAttribute("aria-hidden", "true");
		arrow.setAttribute("viewBox", "0 0 24 24");
		arrow.setAttribute("focusable", "false");
		if (!isSelfAttacking) arrow.classList.add("is-reversed");
		const arrowPath = document.createElementNS(arrowNs, "path");
		arrowPath.setAttribute("d", "M4 12h15m0 0-6-6m6 6-6 6");
		arrowPath.setAttribute("fill", "none");
		arrowPath.setAttribute("stroke", "currentColor");
		arrowPath.setAttribute("stroke-width", "2.5");
		arrowPath.setAttribute("stroke-linecap", "round");
		arrowPath.setAttribute("stroke-linejoin", "round");
		arrow.appendChild(arrowPath);

		const opponentIcon = document.createElement("img");
		opponentIcon.className = "damage-detail-selection-icon";
		opponentIcon.alt = "";
		opponentIcon.style.display = "none";
		const opponentIconFallback = document.createElement("span");
		opponentIconFallback.className = "damage-detail-selection-icon-fallback";
		void applySprite(opponentIcon, opponentIconFallback, row.name.trim(), officialArtworkUrl);

		const moveText = document.createElement("span");
		moveText.className = "damage-detail-selection-move";
		moveText.textContent = moveName || "(技未設定)";

		// 画像だけでは伝わらない情報(誰が攻撃/防御か、技名)をaria-label/titleで
		// テキストとしても残す(WCAG 1.4.1、スクリーンリーダー利用者への退行を作らない)。
		const attackerLabel = isSelfAttacking ? selfName : opponentName;
		const defenderLabel = isSelfAttacking ? opponentName : selfName;
		const fullText = `${attackerLabel} → ${defenderLabel} — ${moveName || "(技未設定)"}`;
		heading.title = fullText;
		heading.setAttribute("aria-label", fullText);
		heading.append(selfIcon, selfIconFallback, arrow, opponentIcon, opponentIconFallback, moveText);
		return heading;
	}
	contentWrap.appendChild(buildSelectionHeadingRow());

	// 🔴 ラウンド23ユーザー指示(23-R3)「攻撃側と防御側の設定は、パネルを左右2分割して
	// 並べて配置」で導入した2列gridは、ラウンド27ユーザー指示(27-R1)により撤回した
	// (CSSの@media(min-width:480px)ブロックを削除、上の
	// #damage-detail-panel-body .damage-detail-sidesコメント参照)。攻撃側→防御側の
	// 順で縦に積む(ワイヤーフレーム docs/ui_proposal/個体編集_右サイド.png どおり)。
	// .damage-detail-side(列)を2つ作り、buildSideSection()のappendChild先を
	// それぞれに割り当てる構造自体はそのまま流用する。
	// 🔴 UI改善ラウンド32ユーザー指示(32-R2)「天候・フィールド設定を一番下に移動」
	// により、以前はこのsidesWrapより前(選択見出しの直後)に置いていた天候・
	// フィールド行(weatherRow/terrainRow)を、sidesWrap・壁ボタンの組み立てが終わった
	// 最後に移した(下方、この関数の末尾を参照)。ここではsidesWrap自体の組み立てだけ
	// 先に行う。
	const sidesWrap = document.createElement("div");
	sidesWrap.className = "damage-detail-sides";
	const attackerSide = document.createElement("div");
	attackerSide.className = "damage-detail-side";
	const defenderSide = document.createElement("div");
	defenderSide.className = "damage-detail-side";
	sidesWrap.append(attackerSide, defenderSide);
	contentWrap.appendChild(sidesWrap);

	// 見出しは攻守の向きによらず「攻撃側」「防御側」固定にする(下記28-R3)。
	// attackerRank等は常に「攻撃側という役割」に対する値であり、どちらが
	// この個体なのかはrow.directionで決まる(recalcRow()のspec組み立てを参照)。
	// 🔴 ラウンド28ユーザー指示(28-R3)「『攻撃(自分)』→『攻撃側』に変更。天候などと
	// 同じタイトル形式にする」により、ラウンド23(23-R3)の「攻撃側(この個体)」→
	// 「攻撃(自分)」という短縮を撤回する(2列分割をやめた27-R1で短縮の理由は
	// 既に消えている)。見出しの可視テキストはrow.directionによらず固定文字列に
	// なるが、「自分/相手」の区別はaria-label側(ariaSideLabel、下記
	// buildSideSection参照)に残し、スクリーンリーダー利用者への退行を作らない。
	const selfIsAttackerForDialog = row.direction !== "defense";
	// ラウンド17指摘(A-1・実バグ): buildSideSection()にテラスタイプの実値を渡す
	// (この個体=左パネルの#tera select、相手=このカードのrow.teraType)。
	// どちらが攻撃側/防御側になるかはrow.direction(攻守切り替え)で入れ替わるため、
	// selfIsAttackerForDialogと同じ条件分岐で対応させる(specの組み立て方は
	// recalcRow()のattackerSpec/defenderSpecの入れ替えと揃えている)。
	// #tera(<select>)は構造分割ラウンド(フェーズ1)でLeftPanel.astroへ移設されたため、
	// この<script>からはel()で直接DOM参照する(同じ要素・同じ値)。
	const selfTeraTypeValue = el<HTMLSelectElement>("tera").value;
	const opponentTeraTypeValue = row.teraType;
	// 🔴 UI改善ラウンド32ユーザー指示(32-R4)「攻撃側の2段目は、急所,じゅうでんの順に
	// 同じグループとして配置」により、buildSideSection()の戻り値(じゅうでんを含む
	// 2段目のチップ行、mergeVolatileIntoChipRow=trueのときだけ生成される)を受け取り、
	// 急所ボタンをその行の先頭に挿入する(31-R2で確立した「急所は攻撃側の中」は
	// 維持しつつ、独立した行ではなく2段目チップ行の一員にする)。
	const attackerSecondaryChipRow = buildSideSection(
		attackerSide,
		row,
		"攻撃側",
		selfIsAttackerForDialog ? "攻撃側(自分)" : "攻撃側(相手)",
		column.attackerRank,
		column.attackerAilment,
		column.attackerTerastallized,
		selfIsAttackerForDialog ? selfTeraTypeValue : opponentTeraTypeValue,
		(value) => { column.attackerRank = value; },
		(value) => { column.attackerAilment = value; },
		(value) => { column.attackerTerastallized = value; },
		DAMAGE_ATTACKER_VOLATILES,
		column.attackerVolatiles,
		(value) => { column.attackerVolatiles = value; },
		// 🔴 UI改善ラウンド29(29-R3): 攻撃側はじゅうでん(DAMAGE_ATTACKER_VOLATILESの
		// 唯一の項目)を状態異常・テラスタルとは別の2段目のチップ行にまとめる。
		true,
	);
	const criticalButton = buildCriticalButton();
	if (attackerSecondaryChipRow) {
		// 「急所,じゅうでん」の順(round-32.mdの言葉どおり)にするため先頭へ挿入する。
		attackerSecondaryChipRow.insertBefore(criticalButton, attackerSecondaryChipRow.firstChild);
	} else {
		// DAMAGE_ATTACKER_VOLATILESは常に1件("じゅうでん")を持つため通常は
		// ここに来ないが、将来の変更に備えてフォールバックを用意する
		// (急所チップ自体は必ず攻撃側に出す)。
		const fallbackRow = document.createElement("div");
		fallbackRow.className = "damage-detail-chip-row";
		fallbackRow.appendChild(criticalButton);
		attackerSide.querySelector(".damage-detail-group")?.appendChild(fallbackRow);
	}
	buildSideSection(
		defenderSide,
		row,
		"防御側",
		selfIsAttackerForDialog ? "防御側(相手)" : "防御側(自分)",
		column.defenderRank,
		column.defenderAilment,
		column.defenderTerastallized,
		selfIsAttackerForDialog ? opponentTeraTypeValue : selfTeraTypeValue,
		(value) => { column.defenderRank = value; },
		(value) => { column.defenderAilment = value; },
		(value) => { column.defenderTerastallized = value; },
		DAMAGE_DEFENDER_VOLATILES,
		column.defenderVolatiles,
		(value) => { column.defenderVolatiles = value; },
		// 防御側の揮発状態は9件あり、29-R3の対象は「状態異常・テラスタル」の2つだけ
		// (round-29.md「防御側の『状態異常』『テラスタル』も同様」)。従来どおり
		// 独立したグループのままにする。
		false,
	);

	// ラウンド20ユーザー指示(20-R2、23-R2でも撤回しない): 壁は「場の設定」ではなく
	// 防御側セクションに含める(壁は防御側にかかる効果のため)。保存キー・
	// エンジンへの渡し方(resolveColumnDerivedFields()がwallEnabled/技の分類から
	// defenderSideFieldsを自動算出する)は一切変えていない。
	// ラウンド24ユーザー指示(24-R2): チェックボックス+labelをbuildToggleButton()に
	// 置き換える。
	// 🔴 UI改善ラウンド32ユーザー指示(32-R5)「壁をかべ(ひらがな)にし、その他の状態と
	// 同じグループに配置する」により、27-R3で確立した「独立した.damage-detail-toggle-row
	// として揮発状態グループの直前に置く」構成を撤回する。かべボタンを
	// .damage-detail-volatile-group(その他の状態のチップ行、buildSideSection内で
	// defenderSide専用に生成される)の先頭へ直接挿入し、他の揮発状態チップと
	// 同じ行・同じ見た目にする。「壁は防御側にかかる効果」という位置づけ(20-R2)自体は
	// 変えない(揮発状態グループも防御側セクションの中にある)。
	// ラウンド23ユーザー指示(23-R3)「自分側の壁」→「自分の壁」、「相手側の壁」→
	// 「相手の壁」に短縮していたが、ラウンド28ユーザー指示(28-R7)
	// 「相手の壁→リフレクター・ひかりのかべに変更」により撤回していた。31-R4で
	// いったん「壁」(漢字)に短縮し、🔴 UI改善ラウンド32ユーザー指示(32-R5)により
	// さらに「かべ」(ひらがな)へ変更する。column.wallEnabledの保存キー・
	// resolveColumnDerivedFields()のロジックは変えない(表示テキストだけの変更)。
	const wallText = "かべ";
	const wallButton = buildToggleButton(
		wallText,
		column.wallEnabled,
		(pressed) => {
			applyToColumnField(() => { column.wallEnabled = pressed; });
		},
		// 32-R5「title属性の説明文は残すこと」により、可視ラベルが「かべ」1語まで
		// 短くなってもtitleの説明文は変更しない。
		{ title: "リフレクター/ひかりのかべを技の分類に応じて自動選択して壁を張る" },
	);
	// 🔴 ラウンド28ユーザー指示(28-R9)「技の分類で自動選択、の表記を削除」により、
	// この<p>はCSSで非表示にする(#damage-detail-panel-body .damage-detail-toggle-hint、
	// display:none)。情報はwallButtonのtitleに残っているため失われない。要素を
	// 「消す」指示でもDOMは残してCSSで見せない方針(pitfalls.md)にする。表示位置は
	// 意味を持たない(常時非表示のため)ので、defenderSideの末尾に置くだけでよい。
	const wallHint = document.createElement("p");
	wallHint.className = "damage-detail-toggle-hint";
	wallHint.textContent = "技の分類で自動選択";
	defenderSide.appendChild(wallHint);
	const defenderVolatileGroup = defenderSide.querySelector(".damage-detail-volatile-group");
	if (defenderVolatileGroup) {
		defenderVolatileGroup.insertBefore(wallButton, defenderVolatileGroup.firstChild);
	} else {
		// DAMAGE_DEFENDER_VOLATILESは常に9件を持つため通常はここに来ないが、
		// 将来の変更に備えてフォールバックを用意する(かべチップ自体は必ず
		// 防御側に出す)。
		const fallbackRow = document.createElement("div");
		fallbackRow.className = "damage-detail-toggle-row";
		fallbackRow.appendChild(wallButton);
		defenderSide.appendChild(fallbackRow);
	}

	// 🔴 UI改善ラウンド32ユーザー指示(32-R2)「天候・フィールド設定を一番下に移動」
	// により、天候・フィールド行をsidesWrap(攻撃側・防御側・その他の状態を含む)より
	// 後、この関数の最後に組み立てる。移動後の順序: 選択見出し→攻撃側→防御側→
	// その他の状態→天候→フィールド。「なし」を選択肢から削除した24-R1により
	// 天候・フィールドとも4択で揃うため、is-row4(4列グリッド)で両方とも
	// 折り返しなく1行に並ぶ(この点は移動の前後で変わらない)。
	const weatherRow = document.createElement("div");
	weatherRow.className = "damage-detail-field-row";
	const weatherLabel = document.createElement("span");
	weatherLabel.className = "damage-detail-field-row-label";
	weatherLabel.textContent = "天候";
	weatherRow.appendChild(weatherLabel);
	const weatherGroup = buildIconToggleGroup(
		DAMAGE_WEATHERS,
		column.weather,
		(value) => { applyToColumnField(() => { column.weather = value; }); },
		"天候",
	);
	weatherGroup.classList.add("is-row4");
	weatherRow.appendChild(weatherGroup);
	contentWrap.appendChild(weatherRow);

	const terrainRow = document.createElement("div");
	terrainRow.className = "damage-detail-field-row";
	const terrainLabel = document.createElement("span");
	terrainLabel.className = "damage-detail-field-row-label";
	terrainLabel.textContent = "フィールド";
	terrainRow.appendChild(terrainLabel);
	const terrainGroup = buildIconToggleGroup(
		DAMAGE_TERRAINS,
		column.terrain,
		(value) => { applyToColumnField(() => { column.terrain = value; }); },
		"フィールド",
	);
	terrainGroup.classList.add("is-row4");
	terrainRow.appendChild(terrainGroup);
	contentWrap.appendChild(terrainRow);
}

// renderDetailPanel/clearSelectionMarks/applySelectionMarks/selectColumnは
// 構造分割ラウンド(フェーズ1)でshared-core.tsへ移設した(ロジックは一切
// 変更していない。renderDetailPanelがrenderDetailPanelEmpty/
// renderColumnLevelDetailPanelを呼ぶ処理・selectColumnがopenDetailPanelOverlay
// IfNarrowを呼ぶ処理はregisterDamageCalcBridge経由になる。上のimport参照)。

// 行が削除されたときに選択状態を解除する(削除された行の設定が
// サイドバーに残り続けるのを防ぐ)。selectedRow/selectedColumnはshared-core.tsへ
// 移設したため、getSelectedRow/clearSelection経由で読み書きする(構造分割
// ラウンド・フェーズ1。ロジック自体は変えていない)。
export function deselectRowIfCurrent(row: DamageRowState): void {
	if (getSelectedRow() === row) {
		clearSelection();
		renderDetailPanel();
	}
}

// 構造分割ラウンド(フェーズ2): 元はこのファイルの内容がモジュール読み込み時に
// 即座に実行されていた(DOM取得→閉じるボタン/背景クリックのイベント登録→初期状態の
// 空パネル描画)。damage-calc.ts側の#opponent-notes-sectionガードが真になった直後に
// 1回だけ呼ぶ形にする(damage-calc.tsのif (opponentNotesSection) { ... }内、
// registerDamageCalcBridge呼び出しの直後を参照)。実行内容・順序は変えていない。
export function initRightPanel(): void {
	detailPanelEl = el<HTMLElement>("damage-detail-panel");
	detailPanelBodyEl = el<HTMLElement>("damage-detail-panel-body");
	detailPanelCloseButton = el<HTMLButtonElement>("damage-detail-panel-close");
	detailBackdropEl = el<HTMLElement>("damage-detail-backdrop");
	detailPanelCloseButton.addEventListener("click", closeDetailPanelOverlay);
	detailBackdropEl.addEventListener("click", closeDetailPanelOverlay);
	// 初期状態は何も選択されていない(空状態を表示)。
	renderDetailPanelEmpty();
}
