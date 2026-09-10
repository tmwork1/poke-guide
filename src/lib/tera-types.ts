// テラスタイプの選択肢一覧(19タイプ、jpokeの型定義と同じ順序)。
// src/pages/box/[id].astro に重複定義されていた配列を切り出し、共用モジュール化した。
// フロントマター(サーバー側)はこのファイルを直接importできるが、ブラウザ側の<script>は
// モジュールscriptとしてimportしている(define:varsは使っていないため通常のTS importが効く)。
export const TERA_TYPES = [
  "ノーマル", "ほのお", "みず", "でんき", "くさ", "こおり", "かくとう", "どく", "じめん",
  "ひこう", "エスパー", "むし", "いわ", "ゴースト", "ドラゴン", "あく", "はがね", "フェアリー", "ステラ",
] as const;

const TERA_TYPE_RANK = new Map<string, number>(TERA_TYPES.map((type, index) => [type, index]));

/** テラスタル選択モーダルの表示順でタイプ名を比較する。未知のタイプは末尾に置く。 */
export function compareTypesByTeraOrder(a: string, b: string): number {
  const rankA = TERA_TYPE_RANK.get(a) ?? TERA_TYPES.length;
  const rankB = TERA_TYPE_RANK.get(b) ?? TERA_TYPES.length;
  return rankA - rankB || a.localeCompare(b, "ja");
}

/** 複合タイプを第1タイプ、第2タイプの順にテラスタル選択モーダルの表示順で比較する。 */
export function compareTypeListsByTeraOrder(a: readonly string[], b: readonly string[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.length) return -1;
    if (index >= b.length) return 1;
    const result = compareTypesByTeraOrder(a[index], b[index]);
    if (result !== 0) return result;
  }
  return 0;
}
