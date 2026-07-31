import re, json, glob, os, sys, html as _html

CARD = re.compile(r'<article class="card article-card">(.*?)</article>', re.S)

def parse(path):
    html = open(path, encoding='utf-8').read()
    out = []
    for m in CARD.finditer(html):
        c = m.group(1)
        season = re.search(r'tag is-primary marginless">シーズン([^<]+)</span>', c)
        rank = re.search(r'<span>(\d+)位</span>', c)
        ri = re.search(r'rating-integer">(\d+)</span><span class="rating-decimal">\.(\d+)', c)
        trainer = re.search(r'title is-6 has-text-weight-normal">([^<]*)</p>', c)
        url = re.search(r'<a href="(https?://[^"]+)" class="card-footer-item', c)
        title = re.search(r'card-footer-item[^>]*>\s*<span>([^<]*)</span>', c, re.S)
        pokes = re.findall(r'poke-icon-96 poke-icon-48 dex-([0-9]{4})-([0-9]{2})-96"\s*\n?\s*title="([^"]*)"', c)
        out.append({
            'season': season.group(1) if season else None,
            'rank': int(rank.group(1)) if rank else None,
            'rating': float(f'{ri.group(1)}.{ri.group(2)}') if ri else None,
            # href/テキストはHTMLエスケープされたまま(クエリ文字列の & が &amp; になっている)なので
            # 必ず unescape する。しないと ?id=x&amp;no=y を実URLとして叩いて404になる。
            'trainer': _html.unescape(trainer.group(1).strip()) if trainer else None,
            'url': _html.unescape(url.group(1)) if url else None,
            'title': _html.unescape(title.group(1).strip()) if title else None,
            'pokemons': [{'dex': p[0], 'form': p[1], 'name': _html.unescape(p[2])} for p in pokes],
        })
    return out

if __name__ == '__main__':
    allrows = []
    for f in sorted(glob.glob('docs/ranker/season_M*_*.html')):
        rows = parse(f)
        print(f, len(rows), 'cards;', sum(1 for r in rows if r['url']), 'with url', file=sys.stderr)
        allrows += rows
    json.dump(allrows, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('total', len(allrows), file=sys.stderr)
