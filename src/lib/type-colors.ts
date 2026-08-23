// タイプごとの慣習的な16進カラー(タイプ画像/テラスタイプ画像が取得できない場合の色ボックス
// フォールバック表示、および技チップ・入力欄の枠色付けに使う)。ステラは公式に単色が無いため近似値。
// box/[id].astro のブラウザ側スクリプト内にローカル定義されていた TYPE_COLORS を値そのまま移した。

export const TYPE_COLORS: Record<string, string> = {
  ノーマル: "#9FA19F",
  ほのお: "#E62829",
  みず: "#2980EF",
  でんき: "#FAC000",
  くさ: "#3FA129",
  こおり: "#3FD8FF",
  かくとう: "#FF8000",
  どく: "#9040CC",
  じめん: "#915121",
  ひこう: "#81B9EF",
  エスパー: "#EF4179",
  むし: "#91A119",
  いわ: "#AFA981",
  ゴースト: "#704170",
  ドラゴン: "#5061E1",
  あく: "#50413F",
  はがね: "#60A1B8",
  フェアリー: "#EF71EF",
  ステラ: "#5BAFB1",
};

/** global.css に定義したタイプアイコン由来の色トークン。 */
export const TYPE_COLOR_CSS_VARIABLES: Record<string, string> = {
  ノーマル: "var(--color-type-normal)",
  ほのお: "var(--color-type-fire)",
  みず: "var(--color-type-water)",
  でんき: "var(--color-type-electric)",
  くさ: "var(--color-type-grass)",
  こおり: "var(--color-type-ice)",
  かくとう: "var(--color-type-fighting)",
  どく: "var(--color-type-poison)",
  じめん: "var(--color-type-ground)",
  ひこう: "var(--color-type-flying)",
  エスパー: "var(--color-type-psychic)",
  むし: "var(--color-type-bug)",
  いわ: "var(--color-type-rock)",
  ゴースト: "var(--color-type-ghost)",
  ドラゴン: "var(--color-type-dragon)",
  あく: "var(--color-type-dark)",
  はがね: "var(--color-type-steel)",
  フェアリー: "var(--color-type-fairy)",
  ステラ: "var(--color-type-stellar)",
};

// タイプ不明時(スプライト取得失敗時と同様、非機能要件)のフォールバック色。
export const DEFAULT_TYPE_COLOR = "#c7cad6";
