const mobileTrainingUi = document.getElementById("mobile-training-ui");
const mobileTrainingBar = document.getElementById("mobile-training-bar");
const editShell = document.getElementById("edit-shell");

if (mobileTrainingUi && mobileTrainingBar && editShell) {
	type MobileTab = "training" | "damage";
	let activeTab: MobileTab = "training";
	const narrowMedia = window.matchMedia("(max-width: 899px)");
	const tabButtons = mobileTrainingBar.querySelectorAll<HTMLButtonElement>("button[data-mobile-tab]");

	// UI改修依頼(モバイル、2026-08-07)「提案図(docs/ui_proposal/mobile/)のとおり、モバイルでは
	// セカンドバー以外のヘッダーを一切置かない」により、900px未満では共通トップバー
	// (.app-topbar、ロゴ・戻る・ページ固有操作)をCSSで丸ごと隠す(box/[id].astro の
	// <style is:global> 参照)。ただしトップバーに載せていた操作系まで消すと、モバイルからは
	// 個体の削除も非公開切り替えも保存失敗の検知もできなくなるため、実体とイベントを複製せず
	// DOMごと下記の移設先へ移す(ユーザー指示: 育成タブの下部へ移す)。
	//   - 耐久調整 / すべて折りたたむ … ダメージ計算タブのツールバー行(提案図の「フィルタ・耐久調整」の帯)
	//   - 保存状態 / 非公開 / 削除     … 育成タブ本文の最下部(#mobile-edit-actions)
	// 900px以上へ戻したときは元の兄弟位置へ必ず復帰させる(トップバーが再び現れるため)。
	type Relocation = {
		el: HTMLElement;
		host: HTMLElement;
		/** true のときはダメージ計算タブを開いている間だけ移す(耐久調整の既存挙動)。 */
		damageTabOnly: boolean;
		parent: Node;
		next: Node | null;
	};
	const RELOCATION_SPECS: ReadonlyArray<readonly [elementId: string, hostId: string, damageTabOnly: boolean]> = [
		["bulk-adjust-button", "mobile-damage-toolbar-actions", true],
		["damage-collapse-toggle-button", "mobile-damage-toolbar-actions", true],
		["autosave-status", "mobile-edit-actions", false],
		["opponent-notes-save-alert", "mobile-edit-actions", false],
		["collection-opt-out-label", "mobile-edit-actions", false],
		["delete-button", "mobile-edit-actions", false],
	];
	const relocations: Relocation[] = [];
	for (const [elementId, hostId, damageTabOnly] of RELOCATION_SPECS) {
		const el = document.getElementById(elementId);
		const host = document.getElementById(hostId);
		// 読み込み失敗・未ログイン時はトップバーのスロット自体が描画されない(box/[id].astro の
		// {pokemon && ...})。見つからない要素は黙って飛ばす(el()と違いthrowさせない)。
		if (!el || !host || !el.parentNode) continue;
		relocations.push({ el, host, damageTabOnly, parent: el.parentNode, next: el.nextSibling });
	}

	function shouldRelocate(damageTabOnly: boolean): boolean {
		return narrowMedia.matches && (!damageTabOnly || activeTab === "damage");
	}

	function applyRelocations(): void {
		for (const { el, host, damageTabOnly } of relocations) {
			if (shouldRelocate(damageTabOnly) && el.parentNode !== host) host.appendChild(el);
		}
		// 復帰は RELOCATION_SPECS の逆順で行う。insertBefore の参照ノード(next)は元の親における
		// 隣の兄弟であり、その兄弟自身がまだ移設先に居ると参照ノードが親の子でなくなって
		// NotFoundError になる。後ろの要素から戻せば、参照ノードは必ず先に戻っている。
		// (念のため、参照ノードが親の子でない場合は末尾追加へ落とす。)
		for (let i = relocations.length - 1; i >= 0; i--) {
			const { el, damageTabOnly, parent, next } = relocations[i];
			if (shouldRelocate(damageTabOnly) || el.parentNode === parent) continue;
			parent.insertBefore(el, next && next.parentNode === parent ? next : null);
		}
	}

	function applyTab(): void {
		mobileTrainingUi.dataset.mobileTab = activeTab;
		editShell.dataset.mobileTab = activeTab;
		for (const button of tabButtons) {
			const isActive = button.dataset.mobileTab === activeTab;
			if (isActive) {
				button.dataset.active = "true";
				button.setAttribute("aria-current", "page");
			} else {
				button.removeAttribute("data-active");
				button.removeAttribute("aria-current");
			}
		}
		applyRelocations();
	}

	for (const button of tabButtons) {
		button.addEventListener("click", () => {
			const nextTab = button.dataset.mobileTab;
			if (nextTab !== "training" && nextTab !== "damage") return;
			activeTab = nextTab;
			applyTab();
		});
	}
	narrowMedia.addEventListener("change", applyTab);
	applyTab();
}
