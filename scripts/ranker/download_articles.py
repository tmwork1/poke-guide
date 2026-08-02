"""構築記事300本をローカルにダウンロードする。

pokesol.app は React Router の `.data`(turbo-stream) を取ると、記事本文だけでなく
ポケモン/技/持ち物/性格/特性のID→日本語名マスタまで一括で得られるため、そちらを取る。
それ以外のホストは素のHTMLを保存し、後段でHaiku subagentに読ませる。
"""
import json, os, sys, time, urllib.parse
import requests
from common import key_of, HEADERS

idx_path, cache_dir = sys.argv[1], sys.argv[2]
os.makedirs(cache_dir, exist_ok=True)
articles = json.load(open(idx_path, encoding='utf-8'))

results = []
for n, a in enumerate(articles, 1):
    key = key_of(a['season'], a['rank'])
    host = urllib.parse.urlparse(a['url']).netloc
    is_pokesol = host == 'pokesol.app'
    url = a['url'] + '.data' if is_pokesol else a['url']
    ext = 'data' if is_pokesol else 'html'
    dest = os.path.join(cache_dir, f'{key}.{ext}')
    rec = {'key': key, 'season': a['season'], 'rank': a['rank'], 'host': host,
           'url': a['url'], 'fetch_url': url, 'path': dest, 'kind': ext}

    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        rec['status'] = 'cached'
        results.append(rec)
        continue
    try:
        r = requests.get(url, headers=HEADERS, timeout=30, allow_redirects=True)
        rec['http_status'] = r.status_code
        if r.status_code == 200 and r.content:
            with open(dest, 'wb') as f:
                f.write(r.content)
            rec['status'] = 'ok'
            rec['bytes'] = len(r.content)
        else:
            rec['status'] = 'http_error'
    except Exception as e:
        rec['status'] = 'error'
        rec['error'] = f'{type(e).__name__}: {e}'
    results.append(rec)
    print(f"[{n}/{len(articles)}] {rec['status']:10} {host:30} {key}", flush=True)
    time.sleep(0.4)

json.dump(results, open(os.path.join(cache_dir, '_manifest.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
ok = sum(1 for r in results if r['status'] in ('ok', 'cached'))
print(f'done: {ok}/{len(results)} fetched')
