// メモ欄など「常にテキスト全体が見える」ことを要件とするtextarea用。rows属性の最低行数は
// 保ったまま、内容に応じて高さを伸ばす(手動リサイズは不要になるため呼び出し側でresizeも
// 外すこと)。border-boxのpaddingはscrollHeightに含まれるため、height:autoで一旦畳んでから
// scrollHeightを読み直す(畳まないと縮む方向の変化=行削除に追従できない)。
export function autosizeTextarea(el: HTMLTextAreaElement): void {
	const resize = (): void => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	el.addEventListener("input", resize);
	resize();
}
