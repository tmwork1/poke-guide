import { requestSettingsModal, type SettingsModalKind } from "./settings-modal";

const kinds = new Set<SettingsModalKind>(["species", "item", "tera", "move", "stats"]);

window.addEventListener("DOMContentLoaded", () => {
	const url = new URL(window.location.href);
	const kind = url.searchParams.get("openSettings");
	if (!kind || !kinds.has(kind as SettingsModalKind)) return;
	const slot = Number(url.searchParams.get("slot"));
	requestSettingsModal({
		kind: kind as SettingsModalKind,
		slot: Number.isInteger(slot) && slot >= 1 && slot <= 4 ? slot : undefined,
	});
	url.searchParams.delete("openSettings");
	url.searchParams.delete("slot");
	window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
});
