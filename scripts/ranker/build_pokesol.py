"""pokesol.app の記事(.data)から個体情報を機械抽出する。

記事本文に <div data-type="pokemon-card" data-...> として持ち物/性格/特性/テラス/技/努力値が
埋め込まれており、同じペイロードに ID→日本語名のマスタ(masterData)も入っている。
LLMを介さず決定的に抽出できるので、この95本はここで処理し切る。
"""
import json, os, re, sys, html, glob
from turbo import decode

TYPE_JA = {
    'NORMAL': 'ノーマル', 'FIRE': 'ほのお', 'WATER': 'みず', 'ELECTRIC': 'でんき',
    'GRASS': 'くさ', 'ICE': 'こおり', 'FIGHTING': 'かくとう', 'POISON': 'どく',
    'GROUND': 'じめん', 'FLYING': 'ひこう', 'PSYCHIC': 'エスパー', 'BUG': 'むし',
    'ROCK': 'いわ', 'GHOST': 'ゴースト', 'DRAGON': 'ドラゴン', 'DARK': 'あく',
    'STEEL': 'はがね', 'FAIRY': 'フェアリー', 'STELLAR': 'ステラ',
}
EV_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed']
CARD_RE = re.compile(r'<div data-type="pokemon-card"([^>]*)>')
ATTR_RE = re.compile(r'data-([a-z-]+)="([^"]*)"')
ICON_RE = re.compile(r'pokemons/(\d{4})(?:_(\d{2}))?\.png')


def route_data(decoded):
    for k, v in decoded.items():
        if k.startswith('routes/') and isinstance(v, dict) and 'data' in v:
            return v['data']
    return None


def build(path):
    d = route_data(decode(path))
    if not d or not d.get('article'):
        return {'ok': False, 'reason': 'no article payload'}
    md, art = d['masterData'], d['article']
    P = {p['id']: p for p in md['pokemons']}
    M = {m['id']: m['name'] for m in md['moves']}
    I = {i['id']: i['name'] for i in md['items']}
    N = {n['id']: n['name'] for n in md['natures']}
    A = {a['id']: a['name'] for a in md['abilities']}

    members = []
    for m in CARD_RE.finditer(art.get('body') or ''):
        a = {k: html.unescape(v) for k, v in ATTR_RE.findall(m.group(1))}
        p = P.get(int(a['pokemon-id'])) if a.get('pokemon-id') else None
        if not p:
            continue
        icon = ICON_RE.search(p.get('icon') or '')
        ev = json.loads(a['evs']) if a.get('evs') else None
        mv = [M.get(x) for x in json.loads(a['move-ids'])] if a.get('move-ids') else []
        ab = [A.get(x) for x in json.loads(a['ability-ids'])] if a.get('ability-ids') else []
        members.append({
            'pokesol_name': p['name'],
            'dex_no': int(icon.group(1)) if icon else None,
            'form_no': int(icon.group(2)) if icon and icon.group(2) else 0,
            'item_name': I.get(int(a['item-id'])) if a.get('item-id') else None,
            'nature': N.get(int(a['nature-id'])) if a.get('nature-id') else None,
            # メガの場合 [メガ後の特性, メガ前の特性] の順で入るため先頭を採用する
            'ability': next((x for x in ab if x), None),
            'tera_type': TYPE_JA.get(a['tera-type']) if a.get('tera-type') else None,
            'move_names': [x for x in mv if x],
            'evs': [ev[k] for k in EV_KEYS] if ev else None,
        })
    return {'ok': True, 'title': art.get('title'), 'season': art.get('season'),
            'battle_format': art.get('battleFormat'), 'members': members}


if __name__ == '__main__':
    cache, out = sys.argv[1], sys.argv[2]
    res = {}
    for p in sorted(glob.glob(os.path.join(cache, '*.data'))):
        key = os.path.splitext(os.path.basename(p))[0]
        try:
            res[key] = build(p)
        except Exception as e:
            res[key] = {'ok': False, 'reason': f'{type(e).__name__}: {e}'}
    json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    ok = [k for k, v in res.items() if v.get('ok')]
    full = [k for k in ok if len(res[k]['members']) >= 6]
    print(f'pokesol: {len(res)} files, ok={len(ok)}, >=6 cards={len(full)}')
    for k, v in res.items():
        if not v.get('ok'):
            print('  FAIL', k, v.get('reason'))
        elif len(v['members']) < 6:
            print('  PARTIAL', k, len(v['members']), 'cards')
