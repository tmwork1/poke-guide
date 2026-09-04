// 育成タブのポケモンプレビュー(実数値・努力値の表、MobilePokemonPreview.astroの
// .pokemon-preview-stats-wrap)をタップして開くステータス調整モーダルの開閉。
//
// StatAdjustmentDialog.astro(モーダルの外枠)とLeftPanel.astro(既存のステータス
// 調整欄 #stat-adjustment-section・その復帰位置の目印 #stat-adjustment-home)は
// どちらも育成タブでしか描画されないため、この1ファイルからdocument.getElementById
// で両者にまたがってアクセスする(このプロジェクトの既存の流儀)。
//
// 「完全に共用」の実現方法: #stat-adjustment-section を複製・同期するのではなく、
// 開くときにDOMノードそのものをモーダル本体(#stat-adjustment-dialog-body)へ移動し、
// 閉じるときに #stat-adjustment-home の直前へ戻す。既存のid参照・イベントリスナー
// (src/lib/box-id/left-panel.ts)は一切変更しないため、そのまま引き続き機能する。
import { bindModalDismissal } from "../modal-dismiss";
import { bindSettingsModalTrigger } from "./settings-modal";

const trigger = document.getElementById("pokemon-preview-stats-trigger");
const backdrop = document.getElementById("stat-adjustment-dialog-backdrop");
const dialog = document.getElementById("stat-adjustment-dialog");
const body = document.getElementById("stat-adjustment-dialog-body");
const closeButton = document.getElementById("stat-adjustment-dialog-close-button");
const section = document.getElementById("stat-adjustment-section");
const home = document.getElementById("stat-adjustment-home");

// ダメージ/バトルデータ/上位チーム/相性タブにはモーダル本体(LeftPanel.astro側)が
// 存在しないため、要素が揃わない場合は安全にno-opにする。
if (trigger && backdrop && dialog && body && closeButton && section && home) {
	function openDialog(): void {
		body!.appendChild(section!);
		backdrop!.hidden = false;
		dialog!.hidden = false;
		dialog!.focus();
	}

	function closeDialog(): void {
		if (!dialog!.hidden) home!.before(section!);
		backdrop!.hidden = true;
		dialog!.hidden = true;
		trigger!.focus();
	}

	// モバイルではclickを待たず、最初に届くpointerdownで開く
	// (.pokemon-preview-sprite-wrap/mega-preview-toggle.tsと同じ方針)。
	// clickはキーボード操作(Enter/Space)のフォールバックとして残す。
	bindSettingsModalTrigger(trigger, { kind: "stats" });
	document.addEventListener("box-settings:open", (event) => {
		if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "stats") openDialog();
	});
	// role="button"のdivはEnter/Spaceを自動では発火しないため、キーボード操作を明示的に配線する。

	closeButton.addEventListener("click", closeDialog);
	bindModalDismissal({ backdrop, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
}
