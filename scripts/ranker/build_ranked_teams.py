"""上位入賞チームの静的データ docs/ranker/derived/ranked-teams.json を組み立てる。

入力(すべてリポジトリ内かキャッシュ):
  docs/ranker/*.json                  公式ランキング(種族/フォルム/持ち物/レート)。これが常に正。
  docs/ranker/derived/articles-index.json  構築記事の索引(season/rank/URL/タイトル/プレイヤー)
  <cache>/pokesol.json                pokesol.app の構造化カードから機械抽出した個体情報
  <cache>/llm/*.json                  それ以外の記事からLLMが抽出した個体情報

出力:
  docs/ranker/derived/ranked-teams.json   投入用データ(scripts/db/seed-ranked-teams.mjs が読む)
  docs/ranker/derived/extraction-report.json  どこから何件取れたか/何を弾いたかの記録

方針: 公式ランキング由来の列は絶対に上書きしない。記事由来の列だけを載せる。
LLMの出力はそのまま信じず、名称をマスタデータ(public/master-data/autocomplete)と照合し、
努力値はチャンピオンズの制約(各項目0〜32・合計66)で検証してから採用する。

各メンバーには公式ランキングの表記(species_name / form_name)に加えて、アプリ内の正式な
種族名 species_key を付ける。サジェスト集計(refresh_popular_builds)が owned_pokemon と
同じキーで突き合わせるために必要。詳細は species_key_of() を参照。
"""
import argparse, glob, json, os, re, sys, unicodedata
from collections import Counter

NATURES = {
    'さみしがり', 'いじっぱり', 'やんちゃ', 'ゆうかん', 'ずぶとい', 'わんぱく', 'のうてんき',
    'のんき', 'ひかえめ', 'おっとり', 'うっかりや', 'れいせい', 'おだやか', 'おとなしい',
    'しんちょう', 'なまいき', 'おくびょう', 'せっかち', 'ようき', 'むじゃき', 'まじめ',
    'がんばりや', 'すなお', 'きまぐれ', 'てれや',
}
TYPES = {
    'ノーマル', 'ほのお', 'みず', 'でんき', 'くさ', 'こおり', 'かくとう', 'どく', 'じめん',
    'ひこう', 'エスパー', 'むし', 'いわ', 'ゴースト', 'ドラゴン', 'あく', 'はがね',
    'フェアリー', 'ステラ',
}
EV_MAX, EV_TOTAL = 32, 66

# 記事は性格を漢字で書くことが多い(「陽気」「意地っ張り」)。ゲーム内表記のひらがなに寄せる。
NATURE_ALIASES = {
    '寂しがり': 'さみしがり', '意地っ張り': 'いじっぱり', '意地': 'いじっぱり',
    'やんちゃ': 'やんちゃ', '勇敢': 'ゆうかん', '図太い': 'ずぶとい', 'ずぶとい': 'ずぶとい',
    '腕白': 'わんぱく', '能天気': 'のうてんき', '呑気': 'のんき', 'のんき': 'のんき',
    '控えめ': 'ひかえめ', 'おっとり': 'おっとり', 'うっかり屋': 'うっかりや',
    '冷静': 'れいせい', '穏やか': 'おだやか', '大人しい': 'おとなしい',
    '慎重': 'しんちょう', '生意気': 'なまいき', '臆病': 'おくびょう', 'せっかち': 'せっかち',
    '陽気': 'ようき', '無邪気': 'むじゃき', '真面目': 'まじめ', '照れ屋': 'てれや',
    '頑張り屋': 'がんばりや', '素直': 'すなお', '気まぐれ': 'きまぐれ',
}

# 公式ランキングのフォルム表記 → アプリ内の正式な種族名
# (public/master-data/autocomplete/pokemon.json の name。owned_pokemon.species_name と同じ語彙)。
# 「ヒスイのすがた」→「(ヒスイ)」のような機械的な変換規則は作らない ── 「ばけたすがた」のように
# アプリ側にフォルムの区別が無いもの、「パルデアのすがた・ブレイズしゅ」→「(パルデア炎)」のように
# 語が対応しないものがあり、規則にすると黙って間違った種族に寄せてしまう。
# (図鑑番号, フォルム番号) で明示し、表に無いフォルムが出てきたらエラーで落とす。
FORM_SPECIES_KEYS = {
    (38, 1): 'キュウコン(アローラ)',
    (59, 1): 'ウインディ(ヒスイ)',
    (80, 2): 'ヤドラン(ガラル)',
    (128, 2): 'ケンタロス(パルデア炎)',  # 「ブレイズしゅ」= Blaze Breed。かくとう/ほのおで一致
    (199, 1): 'ヤドキング(ガラル)',
    (479, 1): 'ヒートロトム',
    (479, 2): 'ウォッシュロトム',
    (479, 5): 'カットロトム',
    (503, 1): 'ダイケンキ(ヒスイ)',
    (571, 1): 'ゾロアーク(ヒスイ)',
    (666, 18): 'ビビヨン',  # 模様違いはアプリ側に区別が無い
    (670, 5): 'フラエッテ(えいえん)',
    (681, 0): 'ギルガルド(シールド)',
    (706, 1): 'ヌメルゴン(ヒスイ)',
    (724, 1): 'ジュナイパー(ヒスイ)',
    (778, 0): 'ミミッキュ',  # ばけた/ばれたの区別はアプリ側に無い
    (855, 0): 'ポットデス',  # がんさく/しんさくの区別はアプリ側に無い
    (877, 0): 'モルペコ(まんぷく)',
    (902, 0): 'イダイトウ(オス)',
    (902, 1): 'イダイトウ(メス)',
    (925, 0): 'イッカネズミ',  # 家族の数の区別はアプリ側に無い
    (964, 0): 'イルカマン(ナイーブ)',
    (1013, 0): 'ヤバソチャ',  # ボンサク/ケイセキの区別はアプリ側に無い
}


def key_of(season, rank):
    return f"{season.replace('-', '')}_{rank:05d}"


def norm(s):
    """全角英数字・記号ゆらぎを潰す(「１０まんボルト」→「10まんボルト」)。"""
    if not isinstance(s, str):
        return None
    return unicodedata.normalize('NFKC', s).strip()


def load_master(root):
    """技名・特性名の語彙と、表記ゆれ→正式名のエイリアスを読む。

    public/master-data/autocomplete だけでは足りない: チャンピオンズで追加された
    パラパラチャージ / ひけんちえなみ / ルミナコリドー / わざわいのかぎ 等が入っておらず、
    それだけで検証すると実在する技を捨ててしまう。pokesol.app のマスタ由来の語彙
    (scripts/ranker/champions-vocab.json)と和集合を取る。
    """
    def names(f):
        p = os.path.join(root, 'public/master-data/autocomplete', f)
        return {e['name'] for e in json.load(open(p, encoding='utf-8'))}

    moves, abils = names('moves.json'), names('abilities.json')
    vocab_path = os.path.join(root, 'scripts/ranker/champions-vocab.json')
    if os.path.exists(vocab_path):
        v = json.load(open(vocab_path, encoding='utf-8'))
        moves |= set(v.get('moves') or [])
        abils |= set(v.get('abilities') or [])

    # 漢字表記・略称→正式名のエイリアス(「地震」→「じしん」「ステロ」→「ステルスロック」)。
    alias_path = os.path.join(root, 'scripts/ranker/name-aliases.json')
    aliases = json.load(open(alias_path, encoding='utf-8')) if os.path.exists(alias_path) else {}
    return moves, abils, aliases


def resolve(value, master, aliases):
    """記事の表記を正式名に解決する。マスタに無い名前は採用しない(捏造を通さないため)。"""
    v = norm(value)
    if not v:
        return None
    if v in master:
        return v
    a = aliases.get(v)
    return a if a in master else None


def load_species_knowledge(root):
    """dexNo → 覚える技の集合 / 特性の集合 を作る(フォルム違いは合算する)。

    LLMが個体を**記事に出てくる順**で番号付けしてしまい、公式ランキングの並び順とずれる事故が
    実際に起きている(例: M-1 2位でアーマーガアとハラバリーの技が入れ替わっていた)。
    種族が覚えられない技かどうかで検算するために使う。
    フォルム間の差はここでの判別(別種族どうしの区別)には効かないので合算で十分。
    """
    base = os.path.join(root, 'vendor/jpoke/src/jpoke/data/ps-champ-ja')
    pokedex = json.load(open(os.path.join(base, 'pokedex.json'), encoding='utf-8'))
    learnsets = json.load(open(os.path.join(base, 'learnsets.json'), encoding='utf-8'))
    moves_by_dex, abils_by_dex = {}, {}
    for name, e in pokedex.items():
        num = e.get('num')
        if not num:
            continue
        moves_by_dex.setdefault(num, set()).update(learnsets.get(name) or [])
        abils_by_dex.setdefault(num, set()).update(e.get('abilities') or [])
    return moves_by_dex, abils_by_dex


def load_app_species(root):
    """アプリ内の正式な種族名 → 図鑑番号 と、メガストーン名 → メガ後の種族名 を読む。

    公式ランキングはメガシンカを「進化前の種族 + メガストーン」で表現する
    (例: ギャラドス@ギャラドスナイト)が、アプリ側は owned_pokemon.species_name に
    「メガギャラドス」を入れ、持ち物欄はメガストーンに固定する
    (src/lib/box-id/shared-core.ts の resolveMegaStoneItem)。同じ個体を指す表現が
    違うので、サジェストの集計キーとして使うにはアプリ側の表現に寄せる必要がある。

    メガストーン→メガ後種族の逆引きは、1アイテムに複数のメガ後フォルムが対応する
    「ニャオニクスナイト」(オス/メス)だけ曖昧になるので落とす
    (extract_autocomplete.py の build_mega_stones が前向きの表を作っている理由と同じ)。
    """
    p = os.path.join(root, 'public/master-data/autocomplete')
    dex_of_name = {e['name']: e['dexNo']
                   for e in json.load(open(os.path.join(p, 'pokemon.json'), encoding='utf-8'))}
    by_item = {}
    for e in json.load(open(os.path.join(p, 'mega-stones.json'), encoding='utf-8')):
        by_item.setdefault(e['item'], []).append(e['species'])
    mega_by_stone = {item: names[0] for item, names in by_item.items() if len(names) == 1}
    return dex_of_name, mega_by_stone


def species_key_of(m, dex_of_name, mega_by_stone, stats):
    """メンバー1体を、アプリ内の正式な種族名(サジェストの集計キー)に対応づける。

    解決できない種族/フォルムは黙って捨てずに例外にする ── 新シーズンで未知のフォルムが
    増えたときに、サジェストから静かに漏れるより落ちたほうがよい。
    """
    if m['form_name']:
        key = FORM_SPECIES_KEYS.get((m['dex_no'], m['form_no']))
        if key is None:
            raise SystemExit(
                f"未知のフォルム: dex={m['dex_no']} form={m['form_no']} "
                f"{m['species_name']}({m['form_name']}) — FORM_SPECIES_KEYS に追加してください")
        stats['species_key_from_form_table'] += 1
    else:
        key = m['species_name']
        if dex_of_name.get(key) != m['dex_no']:
            raise SystemExit(
                f"種族名がマスタと一致しません: dex={m['dex_no']} {key} — "
                f"public/master-data/autocomplete/pokemon.json を確認してください")
        stats['species_key_from_species_name'] += 1

    # メガストーンを持っているならメガ後の種族が実体。図鑑番号が一致するときだけ寄せる
    # (ヒヤッキー@ゴルーグナイトのように、使えないメガストーンを持った個体が実在する)。
    mega = mega_by_stone.get(m['item_name'])
    if mega:
        if dex_of_name.get(mega) == m['dex_no']:
            stats['species_key_mega'] += 1
            return mega
        stats['unusable_mega_stone'] += 1
    return key


def assign_slots(payloads, members, moves_by_dex, abils_by_dex):
    """LLMの roster_index を鵜呑みにせず、覚える技・特性との整合で割り当て直す。

    payloads は (roster_index, cleaned_values) のリスト。
    戻り値は [(payload の添字, members の添字), ...]。
    候補が6体以下なので全順列を試して総得点が最大の割り当てを採る。
    同点なら元の roster_index を優先する(信号が無い個体を無闇に動かさないため)。

    payload のほうが空きスロットより多いことがある(pokesolのカードで一部が既に埋まっていて、
    LLMは6体分返している場合)。そのときは全payloadから空きスロット数だけを選ぶ
    ── 余った分を丸ごと捨てるのではなく、いちばん整合する組を残す。
    """
    import itertools

    def score(p, m):
        s = 0.0
        for mv in (p.get('moves') or []):
            s += 1.0 if mv in moves_by_dex.get(m['dex_no'], ()) else -1.0
        if p.get('ability'):
            s += 2.0 if p['ability'] in abils_by_dex.get(m['dex_no'], ()) else -2.0
        return s

    n, k = len(members), len(payloads)
    if not k or not n:
        return None
    # 得点表を先に作る(同じ組の得点を順列の中で何度も計算しないため)
    tbl = [[score(p, m) + (0.1 if p.get('roster_index') == mi + 1 else 0.0)
            for mi, m in enumerate(members)] for p in payloads]

    take = min(n, k)
    # payload が空きスロット以下なら「どの payload を使うか」は自明なので順列は1重で足りる
    chosen_sets = ([tuple(range(k))] if k <= n
                   else list(itertools.permutations(range(k), take)))
    best, best_score = None, None
    for chosen in chosen_sets:
        for combo in itertools.permutations(range(n), take):
            total = sum(tbl[pi][mi] for pi, mi in zip(chosen, combo))
            if best_score is None or total > best_score:
                best, best_score = list(zip(chosen, combo)), total
    return best


def clean_evs(evs):
    """努力値をチャンピオンズの制約(各項目0〜32・合計66)で検証する。

    6項目すべてが数値なら合計66以下であればよい(実データにも合計65や64の振り残しがあり、
    使い切らない配分は正当。ここで66ちょうどを要求すると本物を捨ててしまう)。

    一部の項目しか書かれていない出力(例 [2, 32, null, null, null, 32])は、
    残りを0とみなした合計が**ちょうど66**になるときだけ0で埋める。66に届かない場合は
    「書かれていない項目に0以外が入っていた」可能性を否定できず復元できないので不採用にする。
    """
    if not isinstance(evs, list) or len(evs) != 6:
        return None
    vals = [v if isinstance(v, int) else None for v in evs]
    if any(v is not None and not 0 <= v <= EV_MAX for v in vals):
        return None
    if None in vals:
        return [v or 0 for v in vals] if sum(v for v in vals if v) == EV_TOTAL else None
    return vals if sum(vals) <= EV_TOTAL else None


def clean_llm_member(m, moves_master, abil_master, aliases, rej):
    """LLMの1個体分の出力を検証して、採用できる値だけに絞る。"""
    nature = norm(m.get('nature'))
    nature = NATURE_ALIASES.get(nature, nature)
    if nature not in NATURES:
        if nature:
            rej['nature'][nature] += 1
        nature = None

    ability = resolve(m.get('ability'), abil_master, aliases)
    if m.get('ability') and not ability:
        rej['ability'][norm(m['ability'])] += 1

    # チャンピオンズにテラスタルは無い(メガシンカ主体のルール)。公式ランキングの
    # テラスアイコン1800枠もpokesolの構造化カードも例外なく空なので、LLMが「テラスタイプ」
    # として返した値は記事の読み違いでしかない(実測でも全件が根拠の無い「ノーマル」だった)。
    # 記録だけ残して採用しない。将来テラスタルのあるルールを取り込むときはここを戻す。
    tera = norm(m.get('tera_type'))
    if tera:
        rej['tera'][tera] += 1
    tera = None

    moves = []
    for mv in (m.get('moves') or []):
        r = resolve(mv, moves_master, aliases)
        if r:
            if r not in moves:
                moves.append(r)
        elif mv:
            rej['move'][norm(mv) or str(mv)] += 1
    moves = moves[:4] or None

    evs = clean_evs(m.get('evs'))
    if m.get('evs') is not None and evs is None:
        rej['evs'][str(m['evs'])] += 1

    conf = m.get('confidence')
    if conf not in ('high', 'medium', 'low'):
        conf = 'low'
    return nature, ability, tera, moves, evs, conf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--cache', required=True, help='pokesol.json と llm/ があるディレクトリ')
    args = ap.parse_args()
    root, cache = args.root, args.cache
    derived = os.path.join(root, 'docs/ranker/derived')

    moves_master, abil_master, aliases = load_master(root)
    moves_by_dex, abils_by_dex = load_species_knowledge(root)
    dex_of_name, mega_by_stone = load_app_species(root)
    articles = {key_of(a['season'], a['rank']): a
                for a in json.load(open(os.path.join(derived, 'articles-index.json'), encoding='utf-8'))}
    pokesol = json.load(open(os.path.join(cache, 'pokesol.json'), encoding='utf-8'))
    llm = {}
    for p in glob.glob(os.path.join(cache, 'llm', '*.json')):
        try:
            llm[os.path.splitext(os.path.basename(p))[0]] = json.load(open(p, encoding='utf-8'))
        except Exception as e:
            print(f'  WARN unreadable llm output {p}: {e}', file=sys.stderr)

    rej = {k: Counter() for k in ('nature', 'ability', 'tera', 'move', 'evs')}
    stats = Counter()
    unmatched = []
    out_teams = []
    seen = set()

    for f in sorted(glob.glob(os.path.join(root, 'docs/ranker/*.json'))):
        doc = json.load(open(f, encoding='utf-8'))
        season, rule = doc['season'], doc['rule']
        for t in doc['teams']:
            ident = (season, rule, t['rank'])
            if ident in seen:
                stats['duplicate_team_skipped'] += 1
                continue
            seen.add(ident)

            members = []
            for slot, p in enumerate(t['team'], 1):
                # 全項目が空のプレースホルダが混じる(M-1 106位は1体しか開示されていない)。
                # 種族不明の枠を作っても意味が無いので、そのスロットごと落とす。
                if not p['id']:
                    stats['empty_member_slot_skipped'] += 1
                    continue
                dex, form = p['id'].split('-')
                member = {
                    'slot': slot,
                    'dex_no': int(dex), 'form_no': int(form),
                    'species_name': p['pokemon'],
                    'form_name': p['form'] or None,
                    'species_key': None,
                    'type1': p['type1'] or None, 'type2': p['type2'] or None,
                    'category': p['category'] or None,
                    'item_name': p['item'] or None,
                    'tera_type': None, 'nature': None, 'ability': None,
                    'move_names': None, 'evs': None,
                    'extraction_source': None, 'extraction_confidence': None,
                }
                member['species_key'] = species_key_of(member, dex_of_name, mega_by_stone, stats)
                members.append(member)

            k = key_of(season, t['rank'])
            a = articles.get(k)
            ps = pokesol.get(k)

            # ① 構造化カード(pokesol)を先に反映する。6体そろっていない記事でも、
            #    取れているカードは常にLLMより正確なので必ず優先する。
            if ps and ps.get('members'):
                # dex_no でスロットに割り当てる(同種族2体はルール上ありえない)
                by_dex = {m['dex_no']: m for m in members}
                for c in ps['members']:
                    tgt = by_dex.get(c['dex_no'])
                    if not tgt:
                        # 記事に「不採用にした個体」もカードで載っている場合がある
                        unmatched.append({'key': k, 'source': 'pokesol', 'name': c['pokesol_name']})
                        continue
                    if tgt['extraction_source'] == 'pokesol':
                        # 同じ種族のカードが2枚ある(型違いの併記)。後勝ちで上書きする。
                        stats['pokesol_duplicate_card_overwrote'] += 1
                    tgt.update({
                        'nature': c['nature'], 'ability': c['ability'],
                        'tera_type': c['tera_type'],
                        'move_names': c['move_names'] or None, 'evs': c['evs'],
                        'extraction_source': 'pokesol', 'extraction_confidence': 'high',
                    })
                    stats['members_from_pokesol'] += 1
                stats['teams_from_pokesol'] += 1

            # ② LLM由来は、pokesolで埋まらなかったスロットにだけ入れる。
            open_slots = [m for m in members if m['extraction_source'] is None]
            if open_slots and k in llm and llm[k].get('has_content'):
                payloads = []
                for c in (llm[k].get('members') or []):
                    nature, ability, tera, mv, evs, conf = clean_llm_member(
                        c, moves_master, abil_master, aliases, rej)
                    if not any([nature, ability, tera, mv, evs]):
                        continue  # 全項目が検証で落ちたら「抽出できなかった」と同じ
                    payloads.append({'roster_index': c.get('roster_index'), 'nature': nature,
                                     'ability': ability, 'tera': tera, 'moves': mv,
                                     'evs': evs, 'conf': conf})
                # roster_index は全6スロット基準の番号なので、空きスロットだけに絞った
                # 並びでの位置に読み替えてから割り当て直す
                slot_pos = {m['slot']: i for i, m in enumerate(open_slots)}
                for p in payloads:
                    p['roster_index'] = slot_pos.get(p['roster_index'], -1) + 1
                combo = assign_slots(payloads, open_slots, moves_by_dex, abils_by_dex)
                if combo is None:
                    unmatched.append({'key': k, 'source': 'llm',
                                      'reason': f'{len(payloads)} payloads vs {len(open_slots)} open slots'})
                else:
                    if len(combo) < len(payloads):
                        stats['llm_payloads_dropped_no_slot'] += len(payloads) - len(combo)
                    for pi, mi in combo:
                        p, tgt = payloads[pi], open_slots[mi]
                        if p['roster_index'] != mi + 1:
                            stats['llm_slot_reassigned'] += 1
                        conf = p['conf']
                        # 割り当て直してもなお半分以上の技をその種族が覚えられないなら、
                        # どの個体の記述なのかを読み違えている可能性が高い。値は残すが信頼度を落とす。
                        if p['moves']:
                            learn = moves_by_dex.get(tgt['dex_no'], ())
                            if sum(1 for x in p['moves'] if x not in learn) * 2 >= len(p['moves']):
                                conf = 'low'
                                stats['llm_low_confidence_by_learnset'] += 1
                        tgt.update({
                            'nature': p['nature'], 'ability': p['ability'], 'tera_type': p['tera'],
                            'move_names': p['moves'], 'evs': p['evs'],
                            'extraction_source': 'llm', 'extraction_confidence': conf,
                        })
                        stats['members_from_llm'] += 1
                stats['teams_from_llm'] += 1

            if a and not any(m['extraction_source'] for m in members):
                # 構築記事はあるが、そこから1件も個体情報が取れなかったチーム
                # (本文が画像だけ / Xのツイート / YouTube 等)
                stats['teams_with_article_no_data'] += 1

            out_teams.append({
                'season': season,
                'season_number': doc['season_number'],
                'rule': rule,
                'rank': t['rank'],
                'rating': t['rating_value'],
                'trainer_name': a['trainer'] if a else None,
                'article_url': a['url'] if a else None,
                'article_title': a['title'] if a else None,
                'article_host': re.sub(r'^https?://([^/]+).*', r'\1', a['url']) if a else None,
                'source_updated_at': doc.get('updated_at'),
                'members': members,
            })
            stats['teams'] += 1

    out_teams.sort(key=lambda t: (t['season_number'], t['rank']))
    doc = {
        'generated_by': 'scripts/ranker/build_ranked_teams.py',
        'sources': {
            'ranking': sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, 'docs/ranker/*.json'))),
            'articles': 'docs/ranker/derived/articles-index.json',
        },
        'ev_scale': {'per_stat_max': EV_MAX, 'total': EV_TOTAL,
                     'note': 'チャンピオンズは努力値0〜32・合計66。旧作の0〜252スケールではない。'},
        'teams': out_teams,
    }
    os.makedirs(derived, exist_ok=True)
    json.dump(doc, open(os.path.join(derived, 'ranked-teams.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    report = {
        'stats': dict(stats),
        'members_total': sum(len(t['members']) for t in out_teams),
        'members_with_moves': sum(1 for t in out_teams for m in t['members'] if m['move_names']),
        'members_with_evs': sum(1 for t in out_teams for m in t['members'] if m['evs']),
        'members_with_nature': sum(1 for t in out_teams for m in t['members'] if m['nature']),
        'members_with_ability': sum(1 for t in out_teams for m in t['members'] if m['ability']),
        'rejected_by_validation': {k: v.most_common() for k, v in rej.items()},
        'unmatched': unmatched[:100],
        'unmatched_count': len(unmatched),
    }
    json.dump(report, open(os.path.join(derived, 'extraction-report.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    print(json.dumps({k: report[k] for k in report if k != 'rejected_by_validation'},
                     ensure_ascii=False, indent=1))
    for k, v in rej.items():
        if v:
            print(f'rejected {k}: {sum(v.values())} ({v.most_common(5)})')


if __name__ == '__main__':
    main()
