// OP.GGの使用率データは技名・種族名の数字を全角(「１０まんボルト」)で表記するが、
// アプリ内のマスターデータ(vendor/jpoke由来)は半角(「10まんボルト」)で統一されている。
// 突き合わせ・表示の両方をマスターデータ側の表記(半角)に揃えるための正規化。
export function normalizeDigits(name: string): string {
  return name.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

// OP.GGは技名の英字も全角で表記することがある(例:「ＤＤラリアット」)。数字と同じく
// マスターデータ側の表記(半角)へ揃える。
export function normalizeLatin(name: string): string {
  return name.replace(/[Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

/** OP.GG由来の技名・アイテム名・特性名を、マスターデータ側の表記へ揃える。 */
export function normalizeTermName(name: string): string {
  return normalizeLatin(normalizeDigits(name));
}
