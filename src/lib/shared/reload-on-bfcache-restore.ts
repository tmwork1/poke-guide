// bfcache復帰時に、離れている間にユーザーデータ(所持ポケモン・チーム)が書き換わっていた場合だけ
// reload を呼ぶ。単に別ページを見て戻っただけのときは、復元されたDOMをそのまま使い再取得・再描画しない。
// 書き込み側は pokemon-repo / team-repo 等の保存成功時に bumpUserDataRevision() を呼ぶ。
// localStorage に置くので別タブでの保存も検知できる。

const REVISION_KEY = "poke-guide:user-data-revision";

function readRevision(): string | null {
	try {
		return window.localStorage.getItem(REVISION_KEY) ?? "";
	} catch {
		return null;
	}
}

/** 所持ポケモン・チームを書き換えた直後に呼ぶ。 */
export function bumpUserDataRevision(): void {
	try {
		window.localStorage.setItem(REVISION_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
	} catch {
		// 保存できない環境では readRevision() も null を返し、復帰のたびに reload する(従来挙動)。
	}
}

export function reloadOnBfcacheRestore(reload: () => void): void {
	let seenRevision = readRevision();
	window.addEventListener("pageshow", (event) => {
		if (!event.persisted) return;
		const current = readRevision();
		if (current !== null && current === seenRevision) return;
		seenRevision = current;
		reload();
	});
}
