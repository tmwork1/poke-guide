// 検索元の表記を壊さず比較時だけ揃えられるよう、DOMに依存しない純粋関数に限定する。
/** ひらがなのコードポイントだけを対応するカタカナへ移し、長音符などは保持する。 */
export function toKatakana(s: string): string {
	return s.replace(/[\u3041-\u3096]/g, (char) =>
		String.fromCharCode(char.charCodeAt(0) + 0x60),
	);
}

/** 表記幅・かな種・英字の大小・前後空白の差を検索比較前に揃える。 */
export function normalizeForSearch(s: string): string {
	return toKatakana(s.normalize("NFKC")).toLowerCase().trim();
}

/** 候補と入力の表記差を吸収して部分一致を判定する。 */
export function kanaIncludes(haystack: string, needle: string): boolean {
	return normalizeForSearch(haystack).includes(normalizeForSearch(needle));
}

/** 候補と入力の表記差を吸収して前方一致を判定する。 */
export function kanaStartsWith(haystack: string, needle: string): boolean {
	return normalizeForSearch(haystack).startsWith(normalizeForSearch(needle));
}
