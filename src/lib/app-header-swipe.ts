// app-header(横タブ)の直下コンテンツ領域を左右にフリックしたとき、隣のタブへ切り替える。
// タブ項目(.app-header__item)は<button>(同一ページ内切り替え)と<a>(別ページへの
// リンク)の両方があり得るため、共通して.click()を呼ぶことで両方に対応する。
//
// ナビゲーション(nextItem.click())は同期的に即座に発火させ、一切遅延させない
// (体感速度を落とさないため)。ハイライト(インジケーター)のスライド演出はそれと並行して
// 追い討ちで走らせるだけの、成功すれば儲けものの装飾。<a>(別ページ遷移)の場合、実際に
// ドキュメントが差し替わるまでは通信・描画のタイムラグが必ず入るため、その間だけ現在の
// ヘッダーが表示され続け、演出が最後まで見えることが多い。差し替えが速い場合は演出が
// 途中で切れるが、その時点で旧DOM自体が消えるため見た目には単なるハードカットに戻るだけで
// 実害はない(Astro View Transitions未導入のため、遷移そのものの暗転は残る)。

interface SwipeState {
	startX: number;
	startY: number;
	startTime: number;
	active: boolean;
}

const SWIPE_MIN_DISTANCE = 48;
const SWIPE_MAX_DURATION = 600;
const SWIPE_DIRECTION_RATIO = 1.5;
const INDICATOR_DURATION_MS = 150;
const INDICATOR_EASING = "ease";

function isHorizontallyScrollable(el: Element): boolean {
	if (!(el instanceof HTMLElement)) return false;
	if (el.scrollWidth <= el.clientWidth) return false;
	const overflowX = getComputedStyle(el).overflowX;
	return overflowX === "auto" || overflowX === "scroll";
}

function startsInsideHorizontalScroller(target: EventTarget | null, contentEl: HTMLElement): boolean {
	let node: Element | null = target instanceof Element ? target : null;
	while (node && node !== contentEl.parentElement) {
		if (isHorizontallyScrollable(node)) return true;
		node = node.parentElement;
	}
	return false;
}

/** input[type="range"] の横ドラッグは値の変更であり、画面タブを切り替える
 * フリックとしては扱わない。range自体のネイティブ操作はブラウザに任せる。 */
function startsInsideRangeInput(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest('input[type="range"]') !== null;
}

// 開いているモーダル(aria-modal="true")の中で始まったタッチは、モーダル自身が
// 独自のフリック操作(タブ切り替え等)を持ちうるため、背後のページのタブ切り替えには使わない。
// 例: ダメージ計算の詳細設定パネル(#damage-detail-panel、モバイルでは中央に浮くモーダル)は
// 本文を左右にフリックしてタブを切り替える独自ジェスチャーを持ち、フリック幅が大きいと
// この関数が無いと同じジェスチャーが背後のbox編集ページのタブ切り替えとしても誤検知されていた。
function startsInsideOpenModal(target: EventTarget | null, contentEl: HTMLElement): boolean {
	let node: Element | null = target instanceof Element ? target : null;
	while (node && node !== contentEl.parentElement) {
		if (node instanceof HTMLElement && node.getAttribute("aria-modal") === "true") return true;
		node = node.parentElement;
	}
	return false;
}

function tabItems(headerEl: HTMLElement): HTMLElement[] {
	return Array.from(headerEl.querySelectorAll<HTMLElement>(".app-header__item"));
}

function backButton(headerEl: HTMLElement): HTMLElement | null {
	return headerEl.querySelector<HTMLElement>(".app-header__back");
}

function activeTabIndex(items: HTMLElement[]): number {
	return items.findIndex((item) => item.dataset.active === "true" || item.getAttribute("aria-current") === "page");
}

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** タブ一覧内のインジケーター要素を取得する。無ければ生成して挿入する(冪等)。
 * .app-header__listが見つからない場合はnullを返し、呼び出し側は演出なしにフォールバックする
 * (呼び出し元のheaderEl特定が将来ずれても、タブ切り替え自体は壊れないようにするため)。 */
function getOrCreateIndicator(headerEl: HTMLElement): { list: HTMLElement; indicator: HTMLElement } | null {
	const list = headerEl.querySelector<HTMLElement>(".app-header__list");
	if (!list) return null;
	let indicator = list.querySelector<HTMLElement>(":scope > .app-header__swipe-indicator");
	if (!indicator) {
		indicator = document.createElement("div");
		indicator.className = "app-header__swipe-indicator";
		indicator.setAttribute("aria-hidden", "true");
		list.appendChild(indicator);
	}
	return { list, indicator };
}

// 直近のインジケーターアニメーション。連続スワイプで割り込まれたら前者をcancel()する
// (Web Animations APIならバックグラウンドタブでの取りこぼしも無く、中断も素直に書ける)。
let activeAnimation: Animation | null = null;

/** fromItemの位置からtoItemの位置へインジケーターを一度だけスライドさせる。
 * <button>(同一ページ内切り替え)の場合、呼び出し時点でtoItemは既に
 * data-active="true"になっている(=クリックハンドラが同期的に切り替え済み)。
 * <a>(別ページ遷移)の場合はtoItemのdata-activeは更新されない(遷移先ページの
 * SSRで決まるため)が、offsetLeft/offsetWidthしか使わないのでどちらでも動く。 */
function playIndicatorSlide(headerEl: HTMLElement, fromItem: HTMLElement, toItem: HTMLElement): void {
	if (fromItem === toItem || prefersReducedMotion()) return;
	const found = getOrCreateIndicator(headerEl);
	if (!found) return;
	const { list, indicator } = found;

	const fromLeft = fromItem.offsetLeft;
	const fromWidth = fromItem.offsetWidth;
	const toLeft = toItem.offsetLeft;
	const toWidth = toItem.offsetWidth;
	if (fromWidth <= 0 || toWidth <= 0) return;

	// <a>(別ページ遷移)はtoItem自身のdata-activeが更新されないため、アニメーション終了後に
	// is-tab-slidingを解除するとfromItem(旧タブ)の背景が復活し、ハイライトが一瞬旧位置へ
	// 戻ってから遷移するように見える。実際にナビゲーションでDOMごと消えるまでは後片付けせず、
	// インジケーターを目的地に留めたままにする。
	const pinAtDestination = !(toItem instanceof HTMLButtonElement);

	activeAnimation?.cancel();
	headerEl.classList.add("is-tab-sliding");
	indicator.style.top = "0";
	indicator.style.height = "100%";

	const animation = indicator.animate(
		[
			{ transform: `translateX(${fromLeft}px)`, width: `${fromWidth}px` },
			{ transform: `translateX(${toLeft}px)`, width: `${toWidth}px` },
		],
		{ duration: INDICATOR_DURATION_MS, easing: INDICATOR_EASING, fill: "forwards" },
	);
	activeAnimation = animation;

	// タブ一覧自体が横スクロールする(overflow-x: auto)環境では、遷移先タブが表示領域外に
	// なり得るので可視域へ寄せる。sticky配下でページ全体のスクロールを誘発しうる
	// scrollIntoViewは避け、リスト自身をスクロールする。
	const visibleLeft = list.scrollLeft;
	const visibleRight = visibleLeft + list.clientWidth;
	if (toLeft < visibleLeft) {
		list.scrollTo({ left: toLeft, behavior: "smooth" });
	} else if (toLeft + toWidth > visibleRight) {
		list.scrollTo({ left: toLeft + toWidth - list.clientWidth, behavior: "smooth" });
	}

	animation.finished
		.then(() => {
			if (pinAtDestination) return; // 別ページ遷移: ナビゲーションでDOMごと消えるまで留め置く。
			// fill:"forwards"の間はアニメーション側が見た目を保持し続けるため、cancel()して
			// 明け渡してから幅0に戻す(戻さないと、常設インジケーターの残骸が最後の位置に残る)。
			animation.cancel();
			indicator.style.width = "0";
			headerEl.classList.remove("is-tab-sliding");
		})
		.catch(() => {
			// 次のスワイプによるcancel()で棄却されたケース。ここでは何もしない
			// (後発のアニメーション側のfinishedが後片付けを担当する)。
		})
		.finally(() => {
			if (activeAnimation === animation) activeAnimation = null;
		});
}

/**
 * app-header(横タブ)のコンテンツ領域(contentEl)を左右にフリックしたとき、
 * headerEl内の隣の .app-header__item へ切り替える(次のタブへ .click() する)。
 * headerEl/contentElのどちらかがnullなら何もしない。
 */
export function setupAppHeaderSwipe(headerEl: HTMLElement | null, contentEl: HTMLElement | null): void {
	if (!headerEl || !contentEl) return;

	let state: SwipeState | null = null;

	contentEl.addEventListener(
		"touchstart",
		(event) => {
			if (event.touches.length !== 1) {
				state = null;
				return;
			}
			const touch = event.touches[0];
			state = {
				startX: touch.clientX,
				startY: touch.clientY,
				startTime: event.timeStamp,
				active:
					!startsInsideHorizontalScroller(event.target, contentEl) &&
					!startsInsideRangeInput(event.target) &&
					!startsInsideOpenModal(event.target, contentEl),
			};
		},
		{ passive: true },
	);

	contentEl.addEventListener(
		"touchmove",
		(event) => {
			if (state && event.touches.length !== 1) state.active = false;
		},
		{ passive: true },
	);

	contentEl.addEventListener(
		"touchend",
		(event) => {
			const current = state;
			state = null;
			if (!current || !current.active) return;
			const touch = event.changedTouches[0];
			if (!touch) return;
			const dx = touch.clientX - current.startX;
			const dy = touch.clientY - current.startY;
			const dt = event.timeStamp - current.startTime;
			if (dt > SWIPE_MAX_DURATION) return;
			if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
			if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_RATIO) return;

			const items = tabItems(headerEl);
			const activeIndex = activeTabIndex(items);
			if (activeIndex === -1) return;
			const step = dx < 0 ? 1 : -1;
			let nextIndex = activeIndex + step;
			while (nextIndex >= 0 && nextIndex < items.length && items[nextIndex].classList.contains("is-disabled")) {
				nextIndex += step;
			}
			if (nextIndex < 0) {
				// 最左タブでさらに右へフリックした場合は、戻るボタンを押したことにする。
				backButton(headerEl)?.click();
				return;
			}
			if (nextIndex >= items.length) return;

			const fromItem = items[activeIndex];
			const nextItem = items[nextIndex];
			nextItem.click();
			// <button>/<a>問わず、ナビゲーションと並行してハイライト移動を演出する
			// (上のコメント参照。<a>はナビゲーションを遅延させない範囲でのベストエフォート)。
			playIndicatorSlide(headerEl, fromItem, nextItem);
		},
		{ passive: true },
	);
}
