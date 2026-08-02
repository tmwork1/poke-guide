"""blog.naver.com は本文を iframe(PostView.naver) で読み込むため、外側のHTMLには本文が無い。
記事URL(blog.naver.com/<blogId>/<logNo>)から PostView.naver を組み立てて取り直す。
"""
import json, os, re, sys, time
import requests
from common import key_of, HEADERS

idx_path, cache = sys.argv[1], sys.argv[2]
idx = {key_of(a['season'], a['rank']): a
       for a in json.load(open(idx_path, encoding='utf-8'))}

n = 0
for key, a in idx.items():
    m = re.match(r'https?://blog\.naver\.com/([^/]+)/(\d+)', a['url'])
    if not m:
        continue
    url = f'https://blog.naver.com/PostView.naver?blogId={m.group(1)}&logNo={m.group(2)}'
    r = requests.get(url, headers=HEADERS, timeout=30)
    if r.status_code == 200 and len(r.content) > 1000:
        open(os.path.join(cache, key + '.html'), 'wb').write(r.content)
        n += 1
        print('ok', key, len(r.content))
    else:
        print('fail', key, r.status_code)
    time.sleep(0.4)
print(f'refetched {n} naver posts')
