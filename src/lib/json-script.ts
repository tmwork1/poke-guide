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
