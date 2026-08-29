// OP.GGの使用率データは技名・種族名の数字を全角(「１０まんボルト」)で表記するが、
// アプリ内のマスターデータ(vendor/jpoke由来)は半角(「10まんボルト」)で統一されている。
// 突き合わせ・表示の両方をマスターデータ側の表記(半角)に揃えるための正規化。
export function normalizeDigits(name: string): string {
  return name.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}
