// ダメージ計算の詳細設定モーダル(#damage-detail-panel)内で「相手ビルド」⇔「わざ1」⇔「わざ2」…を
// フリックで切り替えたとき、本文(#damage-detail-panel-body)を一度だけ横スライドさせる演出。
// タップでの切り替え(selectColumn/selectBuildへの直接呼び出し)は対象外(即座にハードカットのまま)。
//
// 本文の描画(renderBuildDetailPanel/renderColumnLevelDetailPanel、right-panel.ts)は毎回
// detailPanelBodyEl.innerHTML = "" で直前の中身を破棄してから作り直す設計になっている。
// そのため「旧パネルを残したまま新パネルを追加する」ことはできず、代わりに次の手順を踏む:
//   1. 切り替え前に、現在の中身(detailPanelActionsElを除く)を検知不可能な位置へ退避する
//   2. 通常どおりperformSwitch()(selectBuild/selectColumn)を呼ぶ(常に実行する)
//   3. 退避した旧パネルと、新しく描画された新パネルを並べてアニメーションさせる
//   4. 完了後、新パネルを元の位置(detailPanelBodyEl直下、detailPanelActionsElの前)へ戻す
//
// 途中の分岐(フォーム取得失敗・空状態など)で新パネルの構造が「ちょうど1個」にならない
// ケースがあるため、その場合は演出だけ諦める(切り替え自体はperformSwitch()で完了済み)。

const SLIDE_DURATION_MS = 150;
const SLIDE_EASING = "ease";

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let activeTrack: HTMLElement | null = null;
let activeAnimations: Animation[] = [];

/** 新パネル(incomingの中身)を元の位置(actionsElの前)へ戻し、trackを解体する。
 * 通所完了・中断のどちらの経路からも同期的に呼ばれる。 */
function settle(bodyEl: HTMLElement, actionsEl: HTMLElement, track: HTMLElement): void {
	const incoming = track.querySelector<HTMLElement>(":scope > .damage-detail-panel-slide-incoming");
	if (incoming) {
		const anchor = actionsEl.parentElement === bodyEl ? actionsEl : null;
		while (incoming.firstChild) bodyEl.insertBefore(incoming.firstChild, anchor);
	}
	track.remove();
	bodyEl.style.overflow = "";
}

/** 進行中のスライドがあれば、アニメーションをcancel()し、同期的に後始末する。
 * 次のスワイプを始める前に必ず呼ぶ(Animation.finishedのcatch()側の後始末を待つと、
 * 次の退避処理と競合しうるため、cancel()と後始末は同一の同期ブロックで行う)。 */
function finalizeActiveSlide(bodyEl: HTMLElement, actionsEl: HTMLElement): void {
	if (!activeTrack) return;
	for (const anim of activeAnimations) anim.cancel();
	activeAnimations = [];
	const track = activeTrack;
	activeTrack = null;
	settle(bodyEl, actionsEl, track);
}

/**
 * bodyEl(#damage-detail-panel-body)の中身を、direction方向へ一度だけスライドさせながら
 * performSwitch()(selectBuild/selectColumnの呼び出し)を実行する。
 * actionsEl(#damage-detail-panel-actions、行単位で使い回す削除ボタン)はスライド対象から除く
 * (どのわざ/相手ビルドを見ていても内容が同じため、演出中も動かさずその場に残す)。
 */
export function playDetailPanelSlide(
	bodyEl: HTMLElement,
	actionsEl: HTMLElement,
	direction: 1 | -1,
	performSwitch: () => void,
): void {
	finalizeActiveSlide(bodyEl, actionsEl);

	if (prefersReducedMotion()) {
		performSwitch();
		return;
	}

	// フォーム内にフォーカスが残っていると、DOM解体前にchange等のハンドラが走らないままに
	// なるため、退避前に明示的にフォーカスを外す。
	const focused = document.activeElement;
	if (focused instanceof HTMLElement && bodyEl.contains(focused)) focused.blur();

	const scrollTop = bodyEl.scrollTop;
	const clientHeight = bodyEl.clientHeight;

	const outgoing = document.createElement("div");
	outgoing.className = "damage-detail-panel-slide-outgoing";
	for (const child of Array.from(bodyEl.children)) {
		if (child === actionsEl) continue;
		outgoing.appendChild(child);
	}

	performSwitch();

	if (outgoing.childElementCount === 0) return; // 退避する中身が無かった(初回等)。演出だけ諦める。

	const newChildren = Array.from(bodyEl.children).filter((child) => child !== actionsEl);
	if (newChildren.length !== 1 || clientHeight <= 0) return; // 想定外の構造。演出だけ諦める。
	const incomingContent = newChildren[0];

	const incoming = document.createElement("div");
	incoming.className = "damage-detail-panel-slide-incoming";
	incoming.appendChild(incomingContent);

	// 見えていた画をそのまま流す(旧パネルはリセットせず、離脱直前のスクロール位置のまま出す)。
	outgoing.style.top = `${-scrollTop}px`;
	incoming.style.top = "0";

	const track = document.createElement("div");
	track.className = "damage-detail-panel-slide-track";
	track.style.height = `${clientHeight}px`;
	track.appendChild(outgoing);
	track.appendChild(incoming);

	bodyEl.insertBefore(track, bodyEl.firstChild);
	bodyEl.style.overflow = "hidden";
	activeTrack = track;

	const outAnim = outgoing.animate(
		[{ transform: "translateX(0)" }, { transform: `translateX(${-direction * 100}%)` }],
		{ duration: SLIDE_DURATION_MS, easing: SLIDE_EASING, fill: "forwards" },
	);
	const inAnim = incoming.animate(
		[{ transform: `translateX(${direction * 100}%)` }, { transform: "translateX(0)" }],
		{ duration: SLIDE_DURATION_MS, easing: SLIDE_EASING, fill: "forwards" },
	);
	activeAnimations = [outAnim, inAnim];

	Promise.all([outAnim.finished, inAnim.finished])
		.then(() => {
			if (activeTrack !== track) return; // 既に中断・後始末済み
			outAnim.cancel();
			inAnim.cancel();
			activeAnimations = [];
			activeTrack = null;
			settle(bodyEl, actionsEl, track);
		})
		.catch(() => {
			// cancel()による中断。finalizeActiveSlide側の後始末が既に完了している。
		});
}
