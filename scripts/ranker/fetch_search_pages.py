"""構築記事検索(/article/search)のHTMLをシーズン・ページごとに保存する。

以前は手動でブラウザから1ページ目だけ保存していた(docs/ranker/season_M{n}_1.html)。
ページングして全ページ分を docs/ranker/pokedb_html/ に保存する。
"""
import argparse, os, time
import requests
from common import HEADERS

CARD = '<article class="card article-card">'
RULE_CODE = {'single': '0', 'double': '1'}
MAX_PAGES = 40


def fetch_page(season, rule, page, out_dir, force):
    dest = os.path.join(out_dir, f'M{season}_{rule}_p{page}.html')
    if not force and os.path.exists(dest) and os.path.getsize(dest) > 0:
        html = open(dest, encoding='utf-8').read()
        return html, True

    params = {
        'rule': RULE_CODE[rule],
        'season_start': season,
        'season_end': season,
        'per_page': 100,
        'page': page,
    }
    r = requests.get('https://champs.pokedb.tokyo/article/search', params=params,
                      headers=HEADERS, timeout=30)
    r.raise_for_status()
    html = r.text
    time.sleep(0.4)
    return html, False


def fetch_season(season, rule, out_dir, force):
    for page in range(1, MAX_PAGES + 1):
        html, cached = fetch_page(season, rule, page, out_dir, force)
        n = html.count(CARD)
        print(f'season={season} rule={rule} page={page} cards={n}'
              f'{" (cached)" if cached else ""}')
        if n == 0:
            return
        if not cached:
            dest = os.path.join(out_dir, f'M{season}_{rule}_p{page}.html')
            with open(dest, 'w', encoding='utf-8') as f:
                f.write(html)
    raise SystemExit(f'season={season} rule={rule}: {MAX_PAGES}ページ読んでも空ページが来ない')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', default='1,2,3')
    ap.add_argument('--rule', choices=['single', 'double'], default='single')
    ap.add_argument('--out-dir', default='docs/ranker/pokedb_html')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    seasons = [int(s) for s in args.seasons.split(',')]
    for season in seasons:
        fetch_season(season, args.rule, args.out_dir, args.force)


if __name__ == '__main__':
    main()
