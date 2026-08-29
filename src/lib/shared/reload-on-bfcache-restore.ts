export function reloadOnBfcacheRestore(reload: () => void): void {
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) reload();
	});
}
