// bfcache復帰時に、離れている間にユーザーデータ(所持ポケモン・チーム)が書き換わっていた場合だけ
// reload を呼ぶ。単に別ページを見て戻っただけのときは、復元されたDOMをそのまま使い再取得・再描画しない。
// 書き込み側は pokemon-repo / team-repo 等の保存成功時に種類を指定して bumpUserDataRevision() を呼ぶ。
// localStorage に置くので別タブでの保存も検知できる。

export type UserDataRevisionKind = "owned" | "team";

function revisionKey(kind: UserDataRevisionKind): string {
	return `poke-guide:user-data-revision:${kind}`;
}

function readRevision(kind: UserDataRevisionKind): string | null {
	try {
		return window.localStorage.getItem(revisionKey(kind)) ?? "";
	} catch {
		return null;
	}
}

/** 所持ポケモンまたはチームを書き換えた直後に呼ぶ。 */
export function bumpUserDataRevision(kind: UserDataRevisionKind): void {
	try {
		window.localStorage.setItem(revisionKey(kind), `${Date.now()}-${Math.random().toString(36).slice(2)}`);
	} catch {
		// 保存できない環境では readRevision() も null を返し、復帰のたびに reload する(従来挙動)。
	}
}

export function reloadOnBfcacheRestore(
	reload: () => void,
	kinds: readonly UserDataRevisionKind[] = ["owned", "team"],
): void {
	let seenRevisions = kinds.map(readRevision);
	window.addEventListener("pageshow", (event) => {
		if (!event.persisted) return;
		const currentRevisions = kinds.map(readRevision);
		if (currentRevisions.every((current, index) => current !== null && current === seenRevisions[index])) return;
		seenRevisions = currentRevisions;
		reload();
	});
}
