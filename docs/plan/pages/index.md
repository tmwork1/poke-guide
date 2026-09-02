# 未作成ページのバックログ(索引)

**このファイルは索引専用。** 各ページの仕様・設計・受け入れ基準・実施結果は `docs/plan/pages/<slug>.md` に書く(このファイル本体に追記しない)。

過去に完了したページの記録は `docs/plan/completed/pages/index.md` にアーカイブ済み。

`new-page` skill の P0(現在地把握)がこの表を読む。**着手・完了したら必ずこの表を更新すること。** 更新を怠ると次回P0で見つけられない。

## 状態

- **直近の完了: ダメージ(`/damage-calc`)**(2026-09-02〜2026-09-03。ユーザー指示によりCoordinatorが完走。P1〜P6完了、受け入れ基準13件をCoordinatorが実測でpass判定(1件はdev環境の制約でコード確認のみ)。実装はcodexに2段階委任し、Coordinatorが基盤実装のバグ(`formatDamageCalcResult()`のmoveIndex取り違え)を発見・修正。`docs/plan/pages/damage-calc.md`)。**見た目の磨き込みは`ui` skillに引き渡し可能**

## バックログ

| 優先 | ページ | URL | 根拠 | ワイヤーフレーム | 状態 | ファイル |
|---|---|---|---|---|---|---|
| 1 | ダメージ | `/damage-calc` | ユーザー指示(2026-09-02)。`AppBottomNav`に`is-disabled`で「ダメージ」項目が既にあり、`src/pages/damage-calc/`は空ディレクトリのみ存在 | `docs/ui/33.png`〜`36.png` | ✅ 完了(2026-09-03) | `damage-calc.md` |

## 参照

- `.claude/skills/new-page/SKILL.md` — このバックログを消化する手順
- `.claude/skills/new-page/references/stack.md` — 層構造・規約・落とし穴
- `docs/plan/00-foundation.md` — ページ構成・レイアウト原則(**現行仕様の唯一の正**)
- `docs/plan/completed/pages/index.md` — 完了済みページのアーカイブ
