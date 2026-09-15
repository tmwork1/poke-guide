"""champs.pokedb.tokyo から公式ランキングJSONと構築記事検索HTMLを取り、記事索引を作り直す。

`docs/ranker/derived/README.md` の再生成手順のうち、外部サイト(記事本文)に触らず
pokedb だけで完結する 0〜1 をまとめたもの。GitHub Actions (.github/workflows/ranker-fetch.yml)
から毎日叩く前提なので、シーズン番号は引数で与えずに opendata の存在で自動判定する。

進行中の最新シーズンは日々順位が増えるため必ず取り直し(force)、確定済みの過去シーズンは
キャッシュ(=リポジトリにコミット済みのファイル)をそのまま使う。
"""
import argparse
import os
import subprocess
import sys

import requests

from common import HEADERS
import fetch_search_pages
import fetch_team_json

MAX_SEASON = 30
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def season_exists(season, rule):
    url = f'https://champs.pokedb.tokyo/opendata/s{season}_{rule}_ranked_teams.json'
    r = requests.head(url, headers=HEADERS, timeout=30, allow_redirects=True)
    if r.status_code == 405:  # HEAD非対応なら本体を取って判定する
        r = requests.get(url, headers=HEADERS, timeout=30, stream=True)
        r.close()
    return r.status_code == 200


def detect_seasons(rule):
    seasons = []
    for season in range(1, MAX_SEASON + 1):
        if not season_exists(season, rule):
            break
        seasons.append(season)
    if not seasons:
        raise SystemExit(f'rule={rule}: シーズンが1つも見つからない(pokedb側の仕様変更を疑う)')
    if len(seasons) == MAX_SEASON:
        raise SystemExit(f'rule={rule}: {MAX_SEASON}シーズン読んでも終端に来ない')
    return seasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rule', choices=['single', 'double'], default='single')
    ap.add_argument('--seasons', default='auto',
                    help="'auto'(既定) か '1,2,3' のようなカンマ区切り")
    ap.add_argument('--teams-dir', default='docs/ranker')
    ap.add_argument('--html-dir', default='docs/ranker/pokedb_html')
    ap.add_argument('--index', default='docs/ranker/derived/articles-index.json')
    args = ap.parse_args()

    seasons = (detect_seasons(args.rule) if args.seasons == 'auto'
               else [int(s) for s in args.seasons.split(',')])
    latest = max(seasons)
    print(f'seasons={seasons} (latest={latest} は毎回取り直す) rule={args.rule}', flush=True)

    os.makedirs(args.teams_dir, exist_ok=True)
    os.makedirs(args.html_dir, exist_ok=True)
    for season in seasons:
        force = season == latest
        fetch_team_json.fetch_one(season, args.rule, args.teams_dir, force)
        fetch_search_pages.fetch_season(season, args.rule, args.html_dir, force)

    os.makedirs(os.path.dirname(args.index), exist_ok=True)
    subprocess.run([sys.executable, os.path.join('scripts', 'ranker', 'extract_articles.py'), args.index, args.html_dir],
                   cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
