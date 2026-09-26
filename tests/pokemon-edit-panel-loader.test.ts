import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("非表示の編集パネルは共有 Promise を通じて動的 import する", async () => {
	const [component, loader, itemDialog, teraDialog] = await Promise.all([
		readFile(new URL("src/components/box-id/PokemonEditPanel.astro", root), "utf8"),
		readFile(new URL("src/lib/box-id/pokemon-edit-panel-loader.ts", root), "utf8"),
		readFile(new URL("src/lib/box-id/item-select-dialog.ts", root), "utf8"),
		readFile(new URL("src/lib/box-id/tera-select-dialog.ts", root), "utf8"),
	]);

	assert.doesNotMatch(component, /import\s+["']\.\.\/\.\.\/lib\/box-id\/pokemon-edit-panel["']/);
	assert.match(component, /initializePokemonEditPanelLoader\(\)/);
	assert.match(loader, /modulePromise\s*\?\?=\s*import\("\.\/pokemon-edit-panel"\)/);
	assert.match(loader, /stopImmediatePropagation\(\)/);
	assert.match(itemDialog, /from\s+["']\.\/pokemon-edit-panel-loader["']/);
	assert.match(teraDialog, /from\s+["']\.\/pokemon-edit-panel-loader["']/);
});
