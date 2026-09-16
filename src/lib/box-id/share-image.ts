import { bindModalDismissal, markModalPortal } from "../modal-dismiss";
import { getDamageRowsForShare, type DamageRowForShare } from "./damage-calc";

type ShareAction = "copy" | "save";

interface ShareImageDialogElements {
	backdrop: HTMLElement;
	dialog: HTMLElement;
	closeButton: HTMLButtonElement;
	cancelButton: HTMLButtonElement;
	executeButton: HTMLButtonElement;
	selectAllButton: HTMLButtonElement;
	clearAllButton: HTMLButtonElement;
	rowList: HTMLElement;
}

export function initializePokemonShareImage(): void {
	const copyButton = document.getElementById("pokemon-share-image-copy-button") as HTMLButtonElement | null;
	const saveButton = document.getElementById("pokemon-share-image-save-button") as HTMLButtonElement | null;
	const speciesInput = document.getElementById("species-name") as HTMLInputElement | null;
	const backdrop = document.getElementById("share-image-backdrop");
	const dialog = document.getElementById("share-image-dialog");
	const closeButton = document.getElementById("share-image-dialog-close-button") as HTMLButtonElement | null;
	const cancelButton = document.getElementById("share-image-dialog-cancel-button") as HTMLButtonElement | null;
	const executeButton = document.getElementById("share-image-dialog-execute-button") as HTMLButtonElement | null;
	const selectAllButton = document.getElementById("share-image-select-all-button") as HTMLButtonElement | null;
	const clearAllButton = document.getElementById("share-image-clear-all-button") as HTMLButtonElement | null;
	const rowList = document.getElementById("share-image-row-list");
	if (!copyButton || !saveButton || !speciesInput || !backdrop || !dialog || !closeButton || !cancelButton || !executeButton || !selectAllButton || !clearAllButton || !rowList) return;

	const dialogElements: ShareImageDialogElements = { backdrop, dialog, closeButton, cancelButton, executeButton, selectAllButton, clearAllButton, rowList };
	const actionButtons: Record<ShareAction, HTMLButtonElement> = { copy: copyButton, save: saveButton };
	const originalLabels: Record<ShareAction, string> = { copy: "画像をコピー", save: "画像を保存" };
	let activeAction: ShareAction | null = null;
	let selectedRows: DamageRowForShare[] = [];
	let feedbackTimer: ReturnType<typeof window.setTimeout> | undefined;
	let isRunning = false;

	const clipboardSupported = (): boolean => (
		typeof ClipboardItem !== "undefined"
		&& typeof navigator.clipboard?.write === "function"
	);
	const speciesName = (): string => speciesInput.value.trim();
	const setButtonLabel = (action: ShareAction, label: string): void => {
		actionButtons[action].querySelector<HTMLElement>(".pokemon-share-image-action-label")!.textContent = label;
	};
	const syncButtons = (): void => {
		const hasSpecies = speciesName() !== "";
		for (const action of ["copy", "save"] as const) {
			const button = actionButtons[action];
			button.disabled = isRunning || !hasSpecies || (action === "copy" && !clipboardSupported());
			if (!hasSpecies) {
				button.title = `ポケモンを選択すると${action === "copy" ? "画像をコピー" : "画像を保存"}できます`;
			} else if (action === "copy" && !clipboardSupported()) {
				button.title = "このブラウザは画像のコピーに対応していません";
			} else {
				button.removeAttribute("title");
			}
		}
	};
	const closeDialog = (): void => {
		backdrop.hidden = true;
		dialog.hidden = true;
		activeAction = null;
	};
	const renderRows = (rows: DamageRowForShare[]): void => {
		selectedRows = [];
		const fragment = document.createDocumentFragment();
		for (const row of rows) {
			const label = document.createElement("label");
			label.className = "share-image-row-option";
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.value = row.id;
			checkbox.addEventListener("change", () => {
				selectedRows = rows.filter((candidate) => rowList.querySelector<HTMLInputElement>(`input[value="${CSS.escape(candidate.id)}"]`)?.checked);
			});
			const text = document.createElement("span");
			text.className = "share-image-row-option-text";
			text.textContent = row.label;
			label.append(checkbox, text);
			fragment.appendChild(label);
		}
		rowList.replaceChildren(fragment);
	};
	const setAllRowsChecked = (checked: boolean): void => {
		for (const checkbox of Array.from(rowList.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) checkbox.checked = checked;
		const rows = getDamageRowsForShare();
		selectedRows = checked ? rows : [];
	};
	const openDialog = (action: ShareAction, rows: DamageRowForShare[]): void => {
		activeAction = action;
		renderRows(rows);
		executeButton.textContent = action === "copy" ? "コピー" : "保存";
		backdrop.hidden = false;
		dialog.hidden = false;
		dialog.focus();
	};
	const showFeedback = (action: ShareAction, succeeded: boolean): void => {
		if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
		setButtonLabel(action, succeeded ? (action === "copy" ? "コピーしました" : "保存しました") : "失敗しました");
		feedbackTimer = window.setTimeout(() => {
			setButtonLabel(action, originalLabels[action]);
			feedbackTimer = undefined;
		}, 2000);
	};
	const run = async (action: ShareAction, rows: DamageRowForShare[]): Promise<void> => {
		isRunning = true;
		syncButtons();
		try {
			if (action === "copy") {
				// Safariではユーザー操作中にwriteを呼ぶ必要があるため、BlobのPromiseを直接渡す。
				const blobPromise = createImageBlob(rows);
				await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
			} else {
				const blob = await createImageBlob(rows);
				await saveImage(blob, speciesName());
			}
			showFeedback(action, true);
		} catch (error) {
			if (action === "save" && error instanceof DOMException && error.name === "AbortError") return;
			console.error("[share-image] failed to create image", error);
			showFeedback(action, false);
		} finally {
			isRunning = false;
			syncButtons();
		}
	};
	const request = (action: ShareAction): void => {
		if (actionButtons[action].disabled) return;
		const rows = getDamageRowsForShare();
		if (rows.length === 0) {
			void run(action, []);
			return;
		}
		openDialog(action, rows);
	};

	copyButton.addEventListener("click", () => request("copy"));
	saveButton.addEventListener("click", () => request("save"));
	speciesInput.addEventListener("input", syncButtons);
	closeButton.addEventListener("click", closeDialog);
	cancelButton.addEventListener("click", closeDialog);
	selectAllButton.addEventListener("click", () => setAllRowsChecked(true));
	clearAllButton.addEventListener("click", () => setAllRowsChecked(false));
	executeButton.addEventListener("click", () => {
		const action = activeAction;
		if (!action) return;
		closeDialog();
		void run(action, selectedRows);
	});
	markModalPortal(dialog);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	syncButtons();
}

async function createImageBlob(rows: DamageRowForShare[]): Promise<Blob> {
	const preview = document.querySelector<HTMLElement>(".pokemon-preview");
	if (!preview) throw new Error("Pokemon preview was not found");
	const backgroundColor = getComputedStyle(document.body).backgroundColor;
	const wrapper = document.createElement("div");
	wrapper.className = "pokemon-share-image-capture";
	// 幅はプレビューの実測幅(=画面幅)に合わせ、横paddingは付けない。狭めると種族名の省略位置が
	// 画面と変わってしまう。背景色はbodyから拾う(ページ背景と同じ色で画像を塗る)。
	wrapper.style.width = `${Math.ceil(preview.getBoundingClientRect().width)}px`;
	wrapper.style.backgroundColor = backgroundColor;
	const previewClone = preview.cloneNode(true) as HTMLElement;
	previewClone.removeAttribute("hidden");
	wrapper.appendChild(previewClone);
	if (rows.length > 0) {
		// ダメージカードのCSS(box-damage-card.css)は全て `#opponent-notes-section` 配下で
		// 当たるので、複製も同じidを持つsectionで包む。撮影の数百msだけidが重複するが、
		// document.getElementByIdは文書順で先(=本物)を返すので既存コードには影響しない。
		const section = document.createElement("section");
		section.id = "opponent-notes-section";
		section.className = "damage-calc-area";
		const cards = document.createElement("div");
		cards.className = "damage-rows-list pokemon-share-image-damage-list";
		for (const row of rows) {
			const card = row.root.cloneNode(true) as HTMLElement;
			card.removeAttribute("hidden");
			card.style.removeProperty("display");
			cards.appendChild(card);
		}
		section.appendChild(cards);
		wrapper.appendChild(section);
	}
	document.body.appendChild(wrapper);
	try {
		const [{ toBlob }] = await Promise.all([
			import("html-to-image"),
			document.fonts?.ready ?? Promise.resolve(),
		]);
		const blob = await toBlob(wrapper, {
			pixelRatio: 2,
			backgroundColor,
			cacheBust: true,
			// 画面外に置くためのposition:fixed/leftは複製側にもコピーされ、そのままだと描画範囲の外へ
			// 出て真っ白な画像になる。ルート要素のスタイルだけ上書きして描画位置を戻す。
			style: { position: "static", left: "0", top: "0" },
			// src未設定のhiddenな<img>(もちものアイコン等)は読み込みエラーになり、既定では
			// 生成全体が失敗する。表示に影響しないので握りつぶして続行する。
			onImageErrorHandler: () => undefined,
		});
		if (!blob) throw new Error("Image blob could not be created");
		return blob;
	} finally {
		wrapper.remove();
	}
}

async function saveImage(blob: Blob, speciesName: string): Promise<void> {
	const filename = `${speciesName || "pokemon"}.png`;
	const file = new File([blob], filename, { type: "image/png" });
	if (navigator.canShare?.({ files: [file] })) {
		await navigator.share({ files: [file] });
		return;
	}
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = filename;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
