import { bindModalDismissal, markModalPortal } from "../modal-dismiss";
import { getDamageRowsForShare, type DamageRowForShare } from "./damage-calc";

type ShareAction = "copy" | "save";

export function initializePokemonShareImage(): void {
	const saveButton = document.getElementById("pokemon-share-image-save-button") as HTMLButtonElement | null;
	const speciesInput = document.getElementById("species-name") as HTMLInputElement | null;
	const backdrop = document.getElementById("share-image-backdrop");
	const dialog = document.getElementById("share-image-dialog");
	const closeButton = document.getElementById("share-image-dialog-close-button") as HTMLButtonElement | null;
	const copyButton = document.getElementById("share-image-dialog-copy-button") as HTMLButtonElement | null;
	const downloadButton = document.getElementById("share-image-dialog-download-button") as HTMLButtonElement | null;
	const allRow = document.getElementById("share-image-all-row");
	const allCheckbox = document.getElementById("share-image-all-checkbox") as HTMLInputElement | null;
	const rowList = document.getElementById("share-image-row-list");
	if (!saveButton || !speciesInput || !backdrop || !dialog || !closeButton || !copyButton || !downloadButton || !allRow || !allCheckbox || !rowList) return;

	const actionButtons: Record<ShareAction, HTMLButtonElement> = { copy: copyButton, save: downloadButton };
	const originalLabels: Record<ShareAction, string> = { copy: "コピー", save: "ダウンロード" };
	const feedbackTimers: Partial<Record<ShareAction, ReturnType<typeof window.setTimeout>>> = {};
	let availableRows: DamageRowForShare[] = [];
	let selectedRows: DamageRowForShare[] = [];
	let isRunning = false;

	const clipboardSupported = (): boolean => (
		typeof ClipboardItem !== "undefined"
		&& typeof navigator.clipboard?.write === "function"
	);
	const speciesName = (): string => speciesInput.value.trim();
	const setButtonLabel = (action: ShareAction, label: string): void => {
		actionButtons[action].querySelector<HTMLElement>(".share-image-dialog-action-label")!.textContent = label;
	};
	const syncSelectedRows = (): void => {
		selectedRows = availableRows.filter((row) => rowList.querySelector<HTMLInputElement>(`input[value="${CSS.escape(row.id)}"]`)?.checked);
		// 「すべて」は全行チェック済みのときだけチェック状態にする(1行でも外れたら外す)。
		allCheckbox.checked = availableRows.length > 0 && selectedRows.length === availableRows.length;
	};
	const syncButtons = (): void => {
		const hasSpecies = speciesName() !== "";
		saveButton.disabled = !hasSpecies;
		if (!hasSpecies) {
			saveButton.title = "ポケモンを選択すると画像を保存できます";
		} else {
			saveButton.removeAttribute("title");
		}

		copyButton.disabled = isRunning || !clipboardSupported();
		if (!clipboardSupported()) {
			copyButton.title = "このブラウザは画像のコピーに対応していません";
		} else {
			copyButton.removeAttribute("title");
		}
		downloadButton.disabled = isRunning;
	};
	const closeDialog = (): void => {
		backdrop.hidden = true;
		dialog.hidden = true;
	};
	const renderRows = (rows: DamageRowForShare[]): void => {
		availableRows = rows;
		selectedRows = rows.slice();
		rowList.hidden = rows.length === 0;
		allRow.hidden = rows.length === 0;
		allCheckbox.checked = rows.length > 0;
		const fragment = document.createDocumentFragment();
		for (const row of rows) {
			const label = document.createElement("label");
			label.className = "share-image-row-option";
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.value = row.id;
			checkbox.checked = true;
			checkbox.addEventListener("change", syncSelectedRows);
			const card = document.createElement("div");
			card.className = "share-image-row-card";
			card.appendChild(cloneDamageCard(row.root));
			label.append(checkbox, card);
			fragment.appendChild(label);
		}
		rowList.replaceChildren(fragment);
	};
	const setAllRowsChecked = (checked: boolean): void => {
		for (const checkbox of Array.from(rowList.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))) checkbox.checked = checked;
		syncSelectedRows();
	};
	const openDialog = (rows: DamageRowForShare[]): void => {
		renderRows(rows);
		backdrop.hidden = false;
		dialog.hidden = false;
		dialog.focus();
	};
	const showFeedback = (action: ShareAction, succeeded: boolean): void => {
		const timer = feedbackTimers[action];
		if (timer !== undefined) window.clearTimeout(timer);
		setButtonLabel(action, succeeded ? (action === "copy" ? "コピーしました" : "保存しました") : "失敗しました");
		feedbackTimers[action] = window.setTimeout(() => {
			setButtonLabel(action, originalLabels[action]);
			delete feedbackTimers[action];
		}, 2000);
	};
	const run = async (action: ShareAction): Promise<void> => {
		isRunning = true;
		syncButtons();
		try {
			if (action === "copy") {
				// Safariではユーザー操作中にwriteを呼ぶ必要があるため、BlobのPromiseを直接渡す。
				const blobPromise = createImageBlob(selectedRows);
				await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
			} else {
				const blob = await createImageBlob(selectedRows);
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

	saveButton.addEventListener("click", () => {
		if (!saveButton.disabled) openDialog(getDamageRowsForShare());
	});
	speciesInput.addEventListener("input", syncButtons);
	closeButton.addEventListener("click", closeDialog);
	allCheckbox.addEventListener("change", () => setAllRowsChecked(allCheckbox.checked));
	copyButton.addEventListener("click", () => {
		if (!copyButton.disabled) void run("copy");
	});
	downloadButton.addEventListener("click", () => {
		if (!downloadButton.disabled) void run("save");
	});
	markModalPortal(dialog);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	syncButtons();
}

function cloneDamageCard(root: HTMLElement): HTMLElement {
	const card = root.cloneNode(true) as HTMLElement;
	card.removeAttribute("hidden");
	card.style.removeProperty("display");
	card.removeAttribute("id");
	for (const element of Array.from(card.querySelectorAll<HTMLElement>("[id]"))) element.removeAttribute("id");
	return card;
}

async function createImageBlob(rows: DamageRowForShare[]): Promise<Blob> {
	const preview = document.querySelector<HTMLElement>(".pokemon-preview");
	if (!preview) throw new Error("Pokemon preview was not found");
	const backgroundColor = getComputedStyle(document.body).backgroundColor;
	const wrapper = document.createElement("div");
	wrapper.id = "pokemon-share-image-capture";
	wrapper.className = "pokemon-share-image-capture";
	// 幅はプレビューの実測幅(=画面幅)に合わせ、横paddingは付けない。狭めると種族名の省略位置が
	// 画面と変わってしまう。背景色はbodyから拾う(ページ背景と同じ色で画像を塗る)。
	wrapper.style.width = `${Math.ceil(preview.getBoundingClientRect().width)}px`;
	wrapper.style.backgroundColor = backgroundColor;
	const previewClone = preview.cloneNode(true) as HTMLElement;
	previewClone.removeAttribute("hidden");
	wrapper.appendChild(previewClone);
	if (rows.length > 0) {
		const section = document.createElement("section");
		section.className = "damage-card-scope damage-calc-area";
		const cards = document.createElement("div");
		cards.className = "damage-rows-list pokemon-share-image-damage-list";
		for (const row of rows) cards.appendChild(cloneDamageCard(row.root));
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
