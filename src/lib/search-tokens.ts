/** Splits an AND-search query on the separators accepted throughout the app. */
export function splitSearchTokens(value: string): string[] {
	return value.split(/[\s\u3000,，、・/／|｜]+/u).filter(Boolean);
}
