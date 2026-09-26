import type * as PokemonEditPanelModule from "./pokemon-edit-panel";

let modulePromise: Promise<typeof PokemonEditPanelModule> | null = null;
let loadedModule: typeof PokemonEditPanelModule | null = null;
let initialized = false;

/** 編集パネル本体はこの Promise だけを経由して読み込み、同時操作でも二重初期化しない。 */
export function loadPokemonEditPanel(): Promise<typeof PokemonEditPanelModule> {
	modulePromise ??= import("./pokemon-edit-panel").then((module) => {
		loadedModule = module;
		return module;
	});
	return modulePromise;
}

export function getItemSuggestionRatio(value: string): number | undefined {
	return loadedModule?.getItemSuggestionRatio(value);
}

export function getTeraSuggestionRatio(value: string): number | undefined {
	return loadedModule?.getTeraSuggestionRatio(value);
}

/**
 * 表示中の編集フォームは従来どおり直ちに初期化する。非表示フォームでは最初の設定モーダル
 * イベントをいったん止め、本体の初期化後に再送することで未初期化のフォームを操作させない。
 */
export function initializePokemonEditPanelLoader(): void {
	if (initialized) return;
	initialized = true;

	const host = document.querySelector<HTMLElement>(".pokemon-settings-modal-host");
	if (!host) return;

	document.addEventListener("box-settings:open", (event) => {
		if (loadedModule) return;
		event.stopImmediatePropagation();
		const detail = (event as CustomEvent<unknown>).detail;
		void loadPokemonEditPanel().then(() => {
			document.dispatchEvent(new CustomEvent("box-settings:open", { detail }));
		});
	}, { capture: true });

	if (host.classList.contains("is-form-visible")) void loadPokemonEditPanel();
}
