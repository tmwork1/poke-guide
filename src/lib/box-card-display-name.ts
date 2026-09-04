/** ボックスカード向けに、末尾の括弧書きを名称本体と補足表記へ分ける。 */
export function splitBoxCardDisplayName(displayName: string): { name: string; suffix: string | null } {
	const match = /^(.*?)(\([^()]+\))$/.exec(displayName.trim());
	if (!match || !match[1]) return { name: displayName, suffix: null };
	return { name: match[1], suffix: match[2] };
}
