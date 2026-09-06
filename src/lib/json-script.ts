// <script type="application/json"> にJSONを埋め込むための安全な直列化処理。
// JSON.stringify() は < や / をエスケープしないため、</script> を含む文字列があると
// script要素から脱出できる。このアプリで埋め込む集計・候補データには他ユーザー由来の
// 自由入力も混ざり得るため、HTML構文として解釈される文字をJSONのUnicodeエスケープへ置換する。

// script要素内でHTML構文として扱われ得る文字と、JavaScript文字列で互換性問題を起こし得る
// 行・段落区切りを、JSONとして等価なUnicodeエスケープへ変換するための対応表。
const JSON_SCRIPT_ESCAPE_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

// JSON.stringify()の出力をscript要素へ安全に埋め込める文字列へ変換する。
// undefinedはJSON.stringify()が文字列を返さないため、クライアント側が常にJSON.parseできるよう
// JSONのnullへ明示的に正規化する。
export function toJsonScriptContent(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.replace(/[<>&\u2028\u2029]/g, (character) => JSON_SCRIPT_ESCAPE_MAP[character]);
}

// toJsonScriptContent() \u3067\u57cb\u3081\u8fbc\u3093\u3060\u6587\u5b57\u5217\u914d\u5217\u3092\u3001\u30d6\u30e9\u30a6\u30b6\u5074\u3067\u8aad\u307f\u51fa\u3059\u5bfe\u306e\u51e6\u7406\u3002
// \u4ee5\u524d\u306f species-select-dialog.ts / owned-pokemon-form.ts / damage-calc-page/secondary-bar.ts \u306e
// 3\u7b87\u6240\u306b\u540c\u3058\u51e6\u7406\u304c\u5225\u3005\u306b\u66f8\u304b\u308c\u3066\u304a\u308a\u3001\u8981\u7d20\u304c\u7121\u3044\u3068\u304d\u306e\u623b\u308a\u5024(null \u3068 [])\u307e\u3067\u98df\u3044\u9055\u3063\u3066\u3044\u305f\u3002
// \u547c\u3073\u51fa\u3057\u5074\u306f\u3044\u305a\u308c\u3082\u300c\u8aad\u3081\u306a\u3051\u308c\u3070\u7a7a\u914d\u5217\u300d\u3068\u3057\u3066\u6271\u3063\u3066\u3044\u305f\u306e\u3067\u3001[] \u306b\u63c3\u3048\u3066\u3053\u3053\u3078\u96c6\u7d04\u3059\u308b\u3002
//
// \u8981\u7d20\u304c\u7121\u3044\u5834\u5408(\u305d\u306e\u30da\u30fc\u30b8\u304c\u30c7\u30fc\u30bf\u3092\u57cb\u3081\u8fbc\u3093\u3067\u3044\u306a\u3044)\u306f\u6b63\u5e38\u7cfb\u306a\u306e\u3067\u9ed9\u3063\u3066 [] \u3092\u8fd4\u3057\u3001
// JSON\u3068\u3057\u3066\u58ca\u308c\u3066\u3044\u308b\u5834\u5408(=\u57cb\u3081\u8fbc\u307f\u5074\u306e\u30d0\u30b0)\u3060\u3051\u8b66\u544a\u3059\u308b\u3002
export function readJsonScriptStringArray(elementId: string): string[] {
  const script = document.getElementById(elementId);
  if (!script) return [];
  try {
    const parsed: unknown = JSON.parse(script.textContent ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch (error) {
    console.warn(`[json-script] #${elementId} \u306e\u57cb\u3081\u8fbc\u307fJSON\u3092\u89e3\u6790\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f`, error);
    return [];
  }
}
