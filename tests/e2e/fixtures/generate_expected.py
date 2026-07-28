#!/usr/bin/env python3
"""Phase 2-5 / UI改善ラウンド22 22-E E2E回帰テスト用の期待値(ネイティブjpoke実行結果)を生成する
スクリプト。

`cases.json` / `stats-cases.json` / `lethal-sequence-cases.json` に定義した各テストケースを、
`src/lib/pyodide-engine.ts` の BOOTSTRAP_PYTHON (`calc_damages_json` / `calc_stats_json` /
`calc_lethal_sequence_json`) と**全く同じPythonソース**で実行し、結果をそれぞれ
`expected.json` / `expected-stats.json` / `expected-lethal-sequence.json` に書き出す。

ブラウザ(Pyodide)側は BOOTSTRAP_PYTHON という固定のPythonコードを介して
`Battle.calc_damages()` / `Battle.calc_lethal()` / `Pokemon.stats` を呼ぶ。このスクリプトは
BOOTSTRAP_PYTHON を pyodide-engine.ts から直接抽出して実行することで、「ブラウザで動かした
結果」と「ネイティブで動かした結果」が構造的に同一ロジックになるようにしている
(以前は BOOTSTRAP_PYTHON を手書きで複製していたが、boosts(ランク補正)等の反映漏れによる
乖離が見つかったため、UI改善ラウンド22 22-E-2でこの方式に変更した。詳細は
`_extract_bootstrap_python()` のdocstring参照)。実際の一致検証は Playwright
(tests/e2e/damage-calc.spec.ts, tests/e2e/stats-lethal-sequence.spec.ts) が
ブラウザ側の calcDamages()/calcStats()/calcLethalSequence() 呼び出し結果とこれらの
expected-*.json を突き合わせて行う。

再生成方法(jpoke 更新時など):
    python tests/e2e/fixtures/generate_expected.py
    (npm run test:e2e:update-fixtures と同一)

既定では `vendor/jpoke/src` を jpoke の実装として使う(public/master-data の wheel と
同じソース)。`../jpoke/src` 等、別の jpoke ソースで試したい場合は JPOKE_SRC_DIR
環境変数で上書きできる。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = Path(__file__).resolve().parent
PYODIDE_ENGINE_TS = REPO_ROOT / "src" / "lib" / "pyodide-engine.ts"

DEFAULT_JPOKE_SRC = REPO_ROOT / "vendor" / "jpoke" / "src"
JPOKE_SRC_DIR = Path(os.environ.get("JPOKE_SRC_DIR", str(DEFAULT_JPOKE_SRC)))

if not JPOKE_SRC_DIR.is_dir():
    raise SystemExit(f"jpokeのソースが見つかりません: {JPOKE_SRC_DIR}")

sys.path.insert(0, str(JPOKE_SRC_DIR))


def _extract_bootstrap_python() -> str:
    """`src/lib/pyodide-engine.ts` の `const BOOTSTRAP_PYTHON = \\`...\\`;` テンプレート
    リテラルから、埋め込まれたPythonソースをそのまま切り出す。

    背景(UI改善ラウンド22 22-E-2): このスクリプトは元々 `_build_pokemon`/`_apply_field`/
    `calc_damages_json` を BOOTSTRAP_PYTHON から手書きで複製していた。しかし
    BOOTSTRAP_PYTHON側にランク補正(boosts)・状態異常(ailment)・テラスタル
    (terastallized)・揮発性状態(volatiles)・連続ヒット(hitCount)対応が追加された後も
    複製側は追随しておらず、`boosts` を使うケースを追加した瞬間に「期待値が実際の
    ブラウザ実行結果とずれたまま一致と誤判定される」欠陥があった(`.claude/skills/jpoke/
    references/integration.md` §6に記録済み)。

    複製をやめ、ブラウザ側(Pyodide)が実行するのと**全く同じPythonソース文字列**を
    ネイティブPythonでも実行することで、この種の乖離を構造的に起こらなくする
    (「片方はPyodide用・片方はネイティブ用」という制約自体は残るが、ロジックの
    二重管理は解消する)。

    前提: BOOTSTRAP_PYTHON文字列の中にバッククォート(`)は1文字も使われていない
    (pyodide-engine.ts側のコメントに「テンプレートリテラル内でバッククォートを使うと
    ビルドが壊れる」という明記があり、実際に本文中に出現しないことを確認済み)。
    そのため開始マーカー直後から最初のバッククォートまでを単純に切り出せば、
    テンプレートリテラルの終端と一致する。
    """
    text = PYODIDE_ENGINE_TS.read_text(encoding="utf-8")
    marker = "const BOOTSTRAP_PYTHON = `"
    marker_idx = text.index(marker)
    body_start = marker_idx + len(marker)
    body_end = text.index("`", body_start)
    return text[body_start:body_end]


def _load_bootstrap_namespace() -> dict:
    source = _extract_bootstrap_python()
    namespace: dict = {"__name__": "pyodide_engine_bootstrap"}
    code = compile(source, f"{PYODIDE_ENGINE_TS}::BOOTSTRAP_PYTHON", "exec")
    exec(code, namespace)  # noqa: S102 - 固定ファイルから抽出した信頼済みソースのみを実行する
    return namespace


_BOOTSTRAP = _load_bootstrap_namespace()
_calc_damages_json = _BOOTSTRAP["calc_damages_json"]
_calc_stats_json = _BOOTSTRAP["calc_stats_json"]
_calc_lethal_sequence_json = _BOOTSTRAP["calc_lethal_sequence_json"]


def calc_damages_json(case: dict) -> dict:
    """`src/lib/pyodide-engine.ts` の `calcDamages()` と同じ引数組み立て・既定値解決を行い、
    BOOTSTRAP_PYTHONから抽出したネイティブ関数 `calc_damages_json` を呼ぶ。
    既定値は `calcDamages()` 本体(`pyodide-engine.ts` の `options.xxx ?? yyy` 群)と揃えている。
    """
    attacker_spec = case["attacker"]
    defender_spec = case["defender"]
    move_name = case["moveName"]
    seed = case.get("seed")
    critical = case.get("critical", False)
    field_spec = case.get("field") or {}
    max_lethal_attack_count = case.get("maxLethalAttackCount", 6)
    hit_count = case.get("hitCount", 1)

    result_json = _calc_damages_json(
        attacker_spec, defender_spec, move_name, seed, critical, field_spec,
        max_lethal_attack_count, hit_count,
    )
    return json.loads(result_json)


def calc_stats_json(spec: dict) -> dict:
    """`calcStats()` と同じ引数組み立てで、ネイティブ関数 `calc_stats_json` を呼ぶ。"""
    return json.loads(_calc_stats_json(spec))


def calc_lethal_sequence_json(case: dict) -> dict:
    """`calcLethalSequence()` と同じ引数組み立て・既定値解決を行い、
    ネイティブ関数 `calc_lethal_sequence_json` を呼ぶ。
    """
    attacker_spec = case["attacker"]
    defender_spec = case["defender"]
    attacks = case["attacks"]
    seed = case.get("seed")
    critical = case.get("critical", False)
    field_spec = case.get("field") or {}

    result_json = _calc_lethal_sequence_json(
        attacker_spec, defender_spec, attacks, seed, critical, field_spec,
    )
    return json.loads(result_json)


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _generate(fixture_filename: str, expected_filename: str, compute) -> int:
    cases = json.loads((FIXTURES_DIR / fixture_filename).read_text(encoding="utf-8"))
    expected: dict[str, dict] = {}
    for case in cases:
        case_id = case["id"]
        print(f"  計算中: {case_id} ({case['description']})")
        expected[case_id] = compute(case)
    _write_json(FIXTURES_DIR / expected_filename, expected)
    print(f"  書き出し完了: {FIXTURES_DIR / expected_filename} ({len(expected)}件)")
    return len(expected)


def main() -> None:
    print("[1/3] calcDamages() 用の期待値 (cases.json -> expected.json)")
    n_damages = _generate("cases.json", "expected.json", calc_damages_json)

    print("\n[2/3] calcStats() 用の期待値 (stats-cases.json -> expected-stats.json)")
    n_stats = _generate(
        "stats-cases.json", "expected-stats.json",
        lambda case: calc_stats_json(case["spec"]),
    )

    print("\n[3/3] calcLethalSequence() 用の期待値 "
          "(lethal-sequence-cases.json -> expected-lethal-sequence.json)")
    n_lethal_seq = _generate(
        "lethal-sequence-cases.json", "expected-lethal-sequence.json",
        calc_lethal_sequence_json,
    )

    print(f"\n全て完了: damages={n_damages}件 / stats={n_stats}件 / lethalSequence={n_lethal_seq}件")


if __name__ == "__main__":
    main()
