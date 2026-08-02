"""公式ランキングJSON(docs/ranker/s{season}_{rule}_ranked_teams.json)を取得する。

champs.pokedb.tokyo の opendata エンドポイントを叩くだけ。以前は手動でcurl/ブラウザ保存していた。
"""
import argparse, json, os, time
import requests
from common import HEADERS

REQUIRED_KEYS = ('season', 'season_number', 'rule', 'teams')


def fetch_one(season, rule, out_dir, force):
    dest = os.path.join(out_dir, f's{season}_{rule}_ranked_teams.json')
    if not force and os.path.exists(dest) and os.path.getsize(dest) > 0:
        doc = json.load(open(dest, encoding='utf-8'))
        print(f'season={season} rule={rule} status=cached teams={len(doc["teams"])}')
        return

    url = f'https://champs.pokedb.tokyo/opendata/s{season}_{rule}_ranked_teams.json'
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    doc = r.json()
    missing = [k for k in REQUIRED_KEYS if k not in doc]
    if missing:
        raise SystemExit(f'season={season} rule={rule}: レスポンスに必須キーが無い {missing} (url={url})')

    json.dump(doc, open(dest, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'season={season} rule={rule} status=ok teams={len(doc["teams"])}')
    time.sleep(0.4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', default='1,2,3')
    ap.add_argument('--rule', choices=['single', 'double'], default='single')
    ap.add_argument('--out-dir', default='docs/ranker')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    seasons = [int(s) for s in args.seasons.split(',')]
    for season in seasons:
        fetch_one(season, args.rule, args.out_dir, args.force)


if __name__ == '__main__':
    main()
