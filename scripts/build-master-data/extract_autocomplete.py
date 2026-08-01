"""jpoke のマスタデータ(POKEDEX / MOVES / ABILITIES / ITEMS)から、
オートコンプリート用の軽量 JSON と、検索結果の詳細表示用の JSON を抽出するスクリプト。

jpoke の `src/` を直接 sys.path に追加して読み込む(jpoke はランタイム依存ゼロの
純 Python パッケージのため pip install 不要)。ITEMS/ABILITIES は Python コード内で
定義されており JSON 化されていないため、jpoke を import してランタイム上の辞書
(POKEDEX/MOVES/ABILITIES/ITEMS)を単一の情報源として利用する。

使い方:
    python extract_autocomplete.py <jpoke_src_dir> <autocomplete_output_dir> <detail_output_dir>

出力:
    <autocomplete_output_dir>/pokemon.json   (名前・図鑑番号・画像ID・フォルム・タイプのみ)
    <autocomplete_output_dir>/moves.json     (名前・タイプ・分類のみ)
    <autocomplete_output_dir>/abilities.json (名前のみ)
    <autocomplete_output_dir>/items.json     (名前・sprite画像相対パス(spritePath, 解決不可ならnull))
    <autocomplete_output_dir>/regulations.json (レギュレーション名のみ。jpoke.types.Regulation が唯一の情報源)
    <detail_output_dir>/pokemon.json         (検索結果の詳細表示用: 種族値・特性・技・進化前など)
    <detail_output_dir>/moves.json           (検索結果の詳細表示用: 威力・命中率・PPなど)

特性(abilities.json)・持ち物(items.json)は jpoke に日本語の説明文データが無い
(AbilityData/ItemData は技術的なフラグ情報しか持たない)ため、詳細データの生成は見送る
(開発プラン Phase 4-1、YAGNI)。オートコンプリート用の名前のみのJSONをそのまま
検索対象データとしても使う。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def _is_real_name(name: str) -> bool:
    """空文字センチネル("特性なし"等)や内部専用の擬似エントリ("_"始まり)を除外する。"""
    return bool(name) and not name.startswith("_")


def _load_pokemon_image_id_map(jpoke_src_dir: Path) -> dict[str, int]:
    """ポケモン和名(フォルム名込み) -> PokeAPI画像ID のマップを作る。

    vendor/jpoke/src/jpoke/utils/pokeapi.py の get_pokemon_image_url() が参照する
    ja_to_id_map.json の sections.pokemon.by_ja_name をそのまま使う(アイテムの
    _load_item_sprite_paths と異なり、ポケモンには item_jpoke に相当する専用マップが無いため
    二段階フォールバックは不要)。"メガリザードンX" のようなフォルム名込みの表記で、
    ベース種族とは異なる10000番台のIDが引ける場合がある。
    """
    pokeapi_data_dir = jpoke_src_dir / "jpoke" / "data" / "pokeapi"
    with (pokeapi_data_dir / "ja_to_id_map.json").open(encoding="utf-8") as f:
        ja_to_id_map = json.load(f)
    return ja_to_id_map["sections"]["pokemon"]["by_ja_name"]


# jpoke の ja_to_id_map.json (pokemon_image_id_map) が解決できないフォルムのみを
# 手当てする上書き表。優先順位は必ず次の順で、この表が ja_to_id_map.json を上書きすることはない:
#   1. pokemon_image_id_map (ja_to_id_map.json 由来)
#   2. この _IMAGE_ID_OVERRIDES
#   3. dexNo へのフォールバック(スプライトはベース種族の画像になる)
# 値はすべて PokeAPI に実アクセスして得た id 実測値(2026-07-25 時点)。
# 由来は基本的に GET /api/v2/pokemon/{slug} の id、フォルムのslugが分からないものは
# GET /api/v2/pokemon-species/{基礎種族slug} の varieties から突き止めた。
# jpoke 側 (ja_to_id_map.json) が対応したら、この表の該当行は削除してよい。
#
# 以下は意図的にこの表へ入れていない(PokeAPI側に専用アートワークが存在しないため、
# dexNoへのフォールバックがそのまま正しい値になっている):
#   - "ミノムッチ(すなち)" / "ミノムッチ(ゴミ)":
#     PokeAPIには burmy のフォルム別variety自体が存在しない(pokemon-species/burmy の
#     varieties が "burmy" 1件のみ)。
#   - "メテノ(りゅうせい)":
#     PokeAPIの種族デフォルトvariety(pokemon-species/minior)が既に
#     "minior-red-meteor"(id=774)であり、国内図鑑番号774と一致する。
#   - "オーガポン(みどり,テラスタル)":
#     テラスタル専用アートワークはPokeAPIに存在せず、既定フォルム(みどり/dexNo=1017)と
#     同じ絵で正しい。
_IMAGE_ID_OVERRIDES: dict[str, int] = {
    # ケンタロス(パルデアの姿, Breed forme): tauros-paldea-*-breed
    "ケンタロス(パルデア闘)": 10250,  # tauros-paldea-combat-breed
    "ケンタロス(パルデア炎)": 10251,  # tauros-paldea-blaze-breed
    "ケンタロス(パルデア水)": 10252,  # tauros-paldea-aqua-breed
    # ヒヒダルマ(ガラルのすがた): darmanitan-galar-standard
    "ヒヒダルマ(ガラル)": 10177,  # darmanitan-galar-standard
    # ニャオニクス: meowstic-female / meowstic-male-mega / meowstic-female-mega
    # (male-megaとfemale-megaはLegends Z-Aで追加されたメガシンカ。PokeAPIに実在するslug)
    "ニャオニクス(メス)": 10025,  # meowstic-female
    "メガニャオニクス(オス)": 10314,  # meowstic-male-mega
    "メガニャオニクス(メス)": 10326,  # meowstic-female-mega
    # オドリドリ(ふらふらスタイル): oricorio-pau
    "オドリドリ(ふらふら)": 10124,  # oricorio-pau
    # ネクロズマ: necrozma-dusk(たそがれのたてがみ) / necrozma-dawn(あかつきのつばさ)
    "ネクロズマ(たそがれ)": 10155,  # necrozma-dusk
    "ネクロズマ(あかつき)": 10156,  # necrozma-dawn
    # ストリンダー(ハイ・キョダイマックス): toxtricity-amped-gmax
    "ストリンダー(ハイ,キョダイ)": 10219,  # toxtricity-amped-gmax
    # イエッサン(メス): indeedee-female
    "イエッサン(メス)": 10186,  # indeedee-female
    # ウーラオス(いちげきの型・キョダイマックス): urshifu-single-strike-gmax
    "ウーラオス(いちげき,キョダイ)": 10226,  # urshifu-single-strike-gmax
    # イダイトウ(メス): basculegion-female
    "イダイトウ(メス)": 10248,  # basculegion-female
    # パフュートン(メス): oinkologne-female
    "パフュートン(メス)": 10254,  # oinkologne-female
    # イキリンコ: squawkabilly-{blue,yellow,white}-plumage
    "イキリンコ(ブルー)": 10260,  # squawkabilly-blue-plumage
    "イキリンコ(イエロー)": 10261,  # squawkabilly-yellow-plumage
    "イキリンコ(ホワイト)": 10262,  # squawkabilly-white-plumage
    # オーガポン(各仮面): ogerpon-{wellspring,hearthflame,cornerstone}-mask
    "オーガポン(いど)": 10273,  # ogerpon-wellspring-mask
    "オーガポン(かまど)": 10274,  # ogerpon-hearthflame-mask
    "オーガポン(いしずえ)": 10275,  # ogerpon-cornerstone-mask
    # オーガポン(テラスタル): テラスタル専用アートワークはPokeAPIに無いため、
    # 同じ仮面の非テラスタル版と同一の画像ID(仮面の見た目はテラスタルでも変わらない)。
    "オーガポン(いど,テラスタル)": 10273,  # ogerpon-wellspring-mask と同一
    "オーガポン(かまど,テラスタル)": 10274,  # ogerpon-hearthflame-mask と同一
    "オーガポン(いしずえ,テラスタル)": 10275,  # ogerpon-cornerstone-mask と同一
}


def build_pokemon(pokedex: dict, raw_pokedex: dict, pokemon_image_id_map: dict[str, int]) -> list[dict]:
    """POKEDEX から最低限の識別情報(図鑑番号・フォルム・タイプ・画像ID)付きの一覧を作る。

    PokemonData オブジェクト自体には図鑑番号・フォルム名が保持されていないため、
    生の ps-champ-ja/pokedex.json (num/forme) を突き合わせて補完する。

    dexNo は「本来の全国図鑑番号」であり、メガシンカ/キョダイマックス等の特殊フォルムでも
    ベース種族の番号のまま変えない。画像取得には別途 imageId(PokeAPIの画像ID、特殊フォルムは
    10000番台になりうる)を使う。imageId は pokemon_image_id_map(ja_to_id_map.json由来)から
    引き、それでも解決できなければ _IMAGE_ID_OVERRIDES(手書きの上書き表)を試し、
    それも無ければ dexNo にフォールバックする(この場合スプライトはベース種族の画像になる)。
    """
    result = []
    unresolved: list[str] = []
    used_override_names: set[str] = set()
    real_names: set[str] = set()
    for name, data in pokedex.items():
        if not _is_real_name(name):
            continue
        real_names.add(name)
        raw = raw_pokedex.get(name, {})
        dex_no = raw.get("num")
        image_id = pokemon_image_id_map.get(name)
        if image_id is None:
            image_id = _IMAGE_ID_OVERRIDES.get(name)
            if image_id is not None:
                used_override_names.add(name)
        if image_id is None:
            image_id = dex_no
            unresolved.append(name)
        result.append(
            {
                "name": name,
                "dexNo": dex_no,
                "imageId": image_id,
                "forme": raw.get("forme") or None,
                "types": list(data.types),
            }
        )

    if unresolved:
        sample = ", ".join(unresolved[:5])
        print(
            f"警告: ポケモンの画像ID(imageId)を解決できずdexNoにフォールバックしました: {len(unresolved)}件"
            f" (例: {sample})",
            file=sys.stderr,
        )

    # _IMAGE_ID_OVERRIDES にタイポ等で存在しない名前を書いてしまい、
    # 死んだエントリとして黙って放置されるのを防ぐ。
    dead_override_names = sorted(set(_IMAGE_ID_OVERRIDES) - real_names)
    if dead_override_names:
        sample = ", ".join(dead_override_names[:5])
        print(
            f"警告: _IMAGE_ID_OVERRIDES に pokemon.json 側に存在しない名前があります(タイポの可能性): "
            f"{len(dead_override_names)}件 (例: {sample})",
            file=sys.stderr,
        )

    return result


def build_moves(moves: dict) -> list[dict]:
    """MOVES から最低限の識別情報(タイプ・分類)付きの一覧を作る。

    連続技(1ターンに複数回ヒットする技)だけ、ヒット回数の範囲を [最小, 最大] の
    2要素配列として "hits" キーに入れる。単発技は "hits" キー自体を付けない
    (datalistのオートコンプリートに使う軽量JSONのサイズを増やさないため)。

    ヒット回数の情報源は data.multi_hit (MoveData.multi_hit、`{"min": int, "max": int, ...}`)。
    これは vendor/jpoke/src/jpoke/data/moves/move_*.py に技ごとに手書きされた値で、
    jpoke のダメージ計算エンジン自体(core/move_executor.py の _resolve_hit_count 等)が
    参照する一次情報源のため、これをそのまま正とする。
    ps-champ-ja/moves.json (Pokemon Showdown 由来のスナップショット)にも `multihit` フィールドが
    あるが、そちらは全716技中14技分しかカバーしておらず(トリプルキック・トリプルアクセル・
    タキオンカッター・ふくろだたき・ネズミざん等、威力が変化したり技ごとの特殊処理が必要な技は
    ps-champ-ja側で `multihit: []` のまま個別にmove_*.py側で上書きされているため)、
    data.multi_hit の方が広くかつ実際の挙動と一致する。
    """
    result = []
    for name, data in moves.items():
        if not _is_real_name(name):
            continue
        entry = {
            "name": name,
            "type": data.type or None,
            "category": data.category or None,
        }
        if data.multi_hit is not None:
            entry["hits"] = [data.multi_hit["min"], data.multi_hit["max"]]
        result.append(entry)
    return result


def build_pokemon_detail(pokedex: dict) -> list[dict]:
    """POKEDEX から検索結果の詳細表示用データ(種族値・特性・技・進化前)を作る。"""
    result = []
    for name, data in pokedex.items():
        if not _is_real_name(name):
            continue
        result.append(
            {
                "name": name,
                "types": list(data.types),
                # PokemonData.base は [HP, 攻撃, 防御, 特攻, 特防, 素早さ] の順で保持されている。
                "baseStats": list(data.base),
                "abilities": [a for a in data.abilities if _is_real_name(a)],
                "learnset": [m for m in data.learnset if _is_real_name(m)],
                "preEvolution": data.pre_evolution or None,
            }
        )
    return result


def build_moves_detail(moves: dict) -> list[dict]:
    """MOVES から検索結果の詳細表示用データ(威力・命中率・PPなど)を作る。"""
    result = []
    for name, data in moves.items():
        if not _is_real_name(name):
            continue
        result.append(
            {
                "name": name,
                "type": data.type or None,
                "category": data.category or None,
                "power": data.power,
                "accuracy": data.accuracy,
                "pp": data.pp,
                "priority": data.priority,
                "critRatio": data.crit_ratio,
                "target": data.target or None,
            }
        )
    return result


def build_abilities(abilities: dict) -> list[dict]:
    """ABILITIES から名前一覧を作る(jpoke には特性の説明文データが無いため名前のみ)。"""
    return [{"name": name} for name in abilities if _is_real_name(name)]


def build_mega_stones(raw_pokedex: dict, items: dict) -> list[dict]:
    """ps-champ-ja/pokedex.json の forme(``"Mega"`` を含む)+ requiredItem から、
    「メガ後種族名 -> メガストーン名」の前向き対応表を直接構築する
    (jpoke.data.megaevol.MEGA_STONES の反転ではない。UI改善ラウンド23 23-G3で調査確定)。

    MEGA_STONES は「メガストーン -> (進化前種族名, メガ後種族名)」の逆引きで再構築されており、
    1アイテムに複数のメガ後フォルムが対応する場合(メガニャオニクスの性別違い「(オス)」
    「(メス)」が同じアイテム「ニャオニクスナイト」を使う)は曖昧になるため、
    megaevol.py の _build_mega_stones() は該当アイテムを丸ごと除外する
    (``if len(mega_names) != 1: continue``。実測: 両方とも MEGA_STONES から漏れており、
    「片方だけ入る」ではなく「両方とも入らない」)。前向き(種族 -> アイテム)に作れば
    曖昧性が無いため両方カバーできる。

    除外するもの:
      - requiredItem が空文字のフォルム(メガレックウザ。技「ガリョウテンセイ」が条件で
        メガストーン自体を必要としない)。
      - forme に "Mega" を含まないフォルム(原始回帰 forme="Primal" のゲンシカイオーガ/
        ゲンシグラードンは対象外。メガニウム・メガヤンマは forme が空文字でそもそも
        該当しない。名前の「メガ」プレフィックスでは判定しない)。

    ⚠️ 実データで確認した既知の不整合(このスクリプトの範囲では解決できない):
    「ニャオニクスナイト」は上記の理由で MEGA_STONES に無く、item.py の _add_mega_stones() は
    MEGA_STONES を単一の情報源にして jpoke.data.ITEMS へメガストーンを登録しているため、
    「ニャオニクスナイト」自体が jpoke の ITEMS に存在せず、autocomplete/items.json にも
    出てこない。つまりメガニャオニクス(オス)/(メス)の2件は、この対応表には前向きに
    含まれるが、対応する持ち物名自体がUIの持ち物オートコンプリートに存在しないという
    非対称が残る(jpoke側のデータギャップであり、名前を書き換えて辻褄を合わせないこと)。
    """
    result = []
    unmatched_items: list[str] = []
    for name, entry in raw_pokedex.items():
        forme = entry.get("forme") or ""
        if "Mega" not in forme:
            continue
        item = entry.get("requiredItem") or ""
        if not item:
            continue
        if item not in items:
            unmatched_items.append(f"{name}->{item}")
        result.append({"species": name, "item": item})

    if unmatched_items:
        sample = ", ".join(unmatched_items[:5])
        print(
            f"警告: メガストーン名がjpokeのITEMS(=items.json)に存在しません: {len(unmatched_items)}件"
            f" (例: {sample})",
            file=sys.stderr,
        )

    return result


def _load_item_sprite_paths(jpoke_src_dir: Path) -> dict[str, str]:
    """アイテム和名 -> sprite相対パス(例 "choice-band" / "gen9/booster-energy")のマップを作る。

    vendor/jpoke/src/jpoke/utils/pokeapi.py の get_item_image_url() と同じ規則(
    ja_to_id_map.json → id_map.json → item_sprite_subdir_map.json の順に引く)で解決する。
    和名 -> PokeAPI item ID の変換は、jpoke実装対象(item_jpoke)を優先し、無ければ
    全量マップ(item)にフォールバックする(pokeapi.py の _resolve_pokeapi_id と同じ優先順位)。
    """
    pokeapi_data_dir = jpoke_src_dir / "jpoke" / "data" / "pokeapi"

    with (pokeapi_data_dir / "ja_to_id_map.json").open(encoding="utf-8") as f:
        ja_to_id_map = json.load(f)
    with (pokeapi_data_dir / "id_map.json").open(encoding="utf-8") as f:
        id_map = json.load(f)
    with (pokeapi_data_dir / "item_sprite_subdir_map.json").open(encoding="utf-8") as f:
        subdir_map = json.load(f)["slug_to_subdir"]

    item_jpoke_by_ja_name = ja_to_id_map["sections"]["item_jpoke"]["by_ja_name"]
    item_by_ja_name = ja_to_id_map["sections"]["item"]["by_ja_name"]
    item_by_id = id_map["sections"]["item"]["by_id"]

    def resolve(name_ja: str) -> str | None:
        entity_id = item_jpoke_by_ja_name.get(name_ja)
        if entity_id is None:
            entity_id = item_by_ja_name.get(name_ja)
        if entity_id is None:
            return None

        slug = item_by_id.get(str(entity_id))
        if slug is None:
            return None

        subdir = subdir_map.get(slug)
        return f"{subdir}/{slug}" if subdir else slug

    return {name_ja: resolve(name_ja) for name_ja in set(item_jpoke_by_ja_name) | set(item_by_ja_name)}


def build_items(items: dict, jpoke_src_dir: Path) -> list[dict]:
    """ITEMS から名前一覧を作る(jpoke には道具の説明文データが無いため名前のみ)。

    加えて、PokeAPI sprites リポジトリの画像パス解決に使う spritePath を付与する
    (src/lib/sprite-urls.ts の loadItemSpriteMap が読む)。解決できなかったアイテムは
    エラーにせず spritePath: null とし、件数と代表例をビルドログに出力する。
    """
    sprite_paths = _load_item_sprite_paths(jpoke_src_dir)

    result = []
    unresolved: list[str] = []
    for name in items:
        if not _is_real_name(name):
            continue
        sprite_path = sprite_paths.get(name)
        if sprite_path is None:
            unresolved.append(name)
        result.append({"name": name, "spritePath": sprite_path})

    if unresolved:
        sample = ", ".join(unresolved[:5])
        print(
            f"警告: アイテムのsprite画像パスを解決できませんでした: {len(unresolved)}件"
            f" (例: {sample})",
            file=sys.stderr,
        )

    return result


def build_regulations() -> list[dict]:
    """レギュレーション一覧(個体・チームの regulation 列の値域)を jpoke から取り出す。

    唯一の情報源は `jpoke.types.Regulation`(Literal)。data/regulation/{pokemon,item}.csv の
    ヘッダ列も同じ集合だが、CSVヘッダを読むと「実装済み(implemented)」列のような
    レギュレーション以外の列を除外するルールを二重に持つことになるため、型定義側を採る。

    並び順は Literal の定義順(= 新しいレギュレーションが後ろに足される想定)をそのまま保つ。
    UI(選択ボックス)の並びもこの順になる。
    """
    from typing import get_args  # noqa: PLC0415  (jpoke 読み込み後に呼ばれるためここで import)

    from jpoke.types import Regulation  # noqa: E402

    return [{"name": name} for name in get_args(Regulation)]


def main() -> None:
    if len(sys.argv) != 4:
        print(
            "usage: python extract_autocomplete.py <jpoke_src_dir> <autocomplete_output_dir> <detail_output_dir>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    jpoke_src_dir = Path(sys.argv[1]).resolve()
    autocomplete_output_dir = Path(sys.argv[2]).resolve()
    detail_output_dir = Path(sys.argv[3]).resolve()

    if not jpoke_src_dir.is_dir():
        print(f"jpoke のソースディレクトリが見つかりません: {jpoke_src_dir}", file=sys.stderr)
        raise SystemExit(1)

    sys.path.insert(0, str(jpoke_src_dir))

    from jpoke.data import ABILITIES, ITEMS, MOVES, POKEDEX  # noqa: E402

    # PokemonData には図鑑番号・フォルム名が保持されていないため、生の pokedex.json から補完する。
    with (jpoke_src_dir / "jpoke" / "data" / "ps-champ-ja" / "pokedex.json").open(encoding="utf-8") as f:
        raw_pokedex = json.load(f)
    pokemon_image_id_map = _load_pokemon_image_id_map(jpoke_src_dir)

    autocomplete_output_dir.mkdir(parents=True, exist_ok=True)
    detail_output_dir.mkdir(parents=True, exist_ok=True)

    autocomplete_datasets = {
        "pokemon.json": build_pokemon(POKEDEX, raw_pokedex, pokemon_image_id_map),
        "moves.json": build_moves(MOVES),
        "abilities.json": build_abilities(ABILITIES),
        "items.json": build_items(ITEMS, jpoke_src_dir),
        "mega-stones.json": build_mega_stones(raw_pokedex, ITEMS),
        "regulations.json": build_regulations(),
    }
    detail_datasets = {
        "pokemon.json": build_pokemon_detail(POKEDEX),
        "moves.json": build_moves_detail(MOVES),
    }

    for output_dir, datasets in (
        (autocomplete_output_dir, autocomplete_datasets),
        (detail_output_dir, detail_datasets),
    ):
        for filename, records in datasets.items():
            path = output_dir / filename
            with path.open("w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, separators=(",", ":"))
            print(f"wrote {path} ({len(records)} records)")


if __name__ == "__main__":
    main()
