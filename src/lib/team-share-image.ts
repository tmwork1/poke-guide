import { bindModalDismissal, markModalPortal } from "./modal-dismiss";

type ShareAction = "copy" | "save";

export function initializeTeamShareImage(): () => void {
	const saveButton = document.getElementById("team-share-image-save-button") as HTMLButtonElement | null;
	const overviewGrid = document.getElementById("team-overview-grid");
	const backdrop = document.getElementById("team-share-image-backdrop");
	const dialog = document.getElementById("team-share-image-dialog");
	const closeButton = document.getElementById("team-share-image-dialog-close-button") as HTMLButtonElement | null;
	const preview = document.getElementById("team-share-image-preview");
	const copyButton = document.getElementById("team-share-image-dialog-copy-button") as HTMLButtonElement | null;
	const downloadButton = document.getElementById("team-share-image-dialog-download-button") as HTMLButtonElement | null;
	if (!saveButton || !overviewGrid || !backdrop || !dialog || !closeButton || !preview || !copyButton || !downloadButton) return () => undefined;

	const actionButtons: Record<ShareAction, HTMLButtonElement> = { copy: copyButton, save: downloadButton };
	const originalLabels: Record<ShareAction, string> = { copy: "コピー", save: "ダウンロード" };
	const feedbackTimers: Partial<Record<ShareAction, ReturnType<typeof window.setTimeout>>> = {};
	let isRunning = false;
	let runningAction: ShareAction | null = null;

	const clipboardSupported = (): boolean => typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
	const setButtonLabel = (action: ShareAction, label: string): void => {
		actionButtons[action].querySelector<HTMLElement>(".share-image-dialog-action-label")!.textContent = label;
	};
	const syncButtons = (): void => {
		const hasMembers = overviewGrid.querySelector(".team-overview-preview-card") !== null;
		saveButton.disabled = !hasMembers;
		if (hasMembers) saveButton.removeAttribute("title");
		else saveButton.title = "ポケモンを追加すると画像を保存できます";

		copyButton.disabled = isRunning || !clipboardSupported();
		if (clipboardSupported()) copyButton.removeAttribute("title");
		else copyButton.title = "このブラウザは画像のコピーに対応していません";
		downloadButton.disabled = isRunning;
		for (const action of ["copy", "save"] as const) {
			const button = actionButtons[action];
			const spinning = isRunning && runningAction === action;
			button.querySelector<HTMLElement>(".share-image-dialog-action-spinner")!.hidden = !spinning;
			button.querySelector<SVGElement>("svg")!.toggleAttribute("hidden", spinning);
		}
	};
	const closeDialog = (): void => {
		backdrop.hidden = true;
		dialog.hidden = true;
	};
	const openDialog = (): void => {
		preview.replaceChildren(cloneOverviewGrid(overviewGrid));
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
		runningAction = action;
		syncButtons();
		try {
			if (action === "copy") {
				const blobPromise = createTeamImageBlob(overviewGrid);
				await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
			} else {
				await saveImage(await createTeamImageBlob(overviewGrid));
			}
			showFeedback(action, true);
		} catch (error) {
			if (action === "save" && error instanceof DOMException && error.name === "AbortError") return;
			console.error("[team-share-image] failed to create image", error);
			showFeedback(action, false);
		} finally {
			isRunning = false;
			runningAction = null;
			syncButtons();
		}
	};

	saveButton.addEventListener("click", () => {
		if (!saveButton.disabled) openDialog();
	});
	closeButton.addEventListener("click", closeDialog);
	copyButton.addEventListener("click", () => {
		if (!copyButton.disabled) void run("copy");
	});
	downloadButton.addEventListener("click", () => {
		if (!downloadButton.disabled) void run("save");
	});
	markModalPortal(dialog);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	syncButtons();
	return syncButtons;
}

function cloneOverviewGrid(overviewGrid: HTMLElement): HTMLElement {
	const clone = overviewGrid.cloneNode(true) as HTMLElement;
	const elements = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
	for (const element of elements) {
		element.removeAttribute("id");
		element.removeAttribute("aria-pressed");
		element.classList.remove("is-selected");
	}
	return clone;
}

async function createTeamImageBlob(overviewGrid: HTMLElement): Promise<Blob> {
	const backgroundColor = getComputedStyle(document.body).backgroundColor;
	const wrapper = document.createElement("div");
	wrapper.className = "team-share-image-capture";
	wrapper.style.width = `${Math.ceil(overviewGrid.getBoundingClientRect().width)}px`;
	wrapper.style.backgroundColor = backgroundColor;
	wrapper.appendChild(cloneOverviewGrid(overviewGrid));
	document.body.appendChild(wrapper);
	try {
		const [{ toBlob }] = await Promise.all([import("html-to-image"), document.fonts?.ready ?? Promise.resolve()]);
		const blob = await toBlob(wrapper, {
			pixelRatio: 2,
			backgroundColor,
			cacheBust: true,
			style: { position: "static", left: "0", top: "0" },
			onImageErrorHandler: () => undefined,
		});
		if (!blob) throw new Error("Image blob could not be created");
		return blob;
	} finally {
		wrapper.remove();
	}
}

async function saveImage(blob: Blob): Promise<void> {
	const file = new File([blob], "team.png", { type: "image/png" });
	if (navigator.canShare?.({ files: [file] })) {
		await navigator.share({ files: [file] });
		return;
	}
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = file.name;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
