"""Haiku subagent に渡す抽出タスクを1記事1ファイルで書き出し、文字数が均等になるようバッチに割る。

各タスクには「公式ランキング由来の6体(種族名/フォルム/持ち物)」を必ず添える。
記事本文の表記はメガ名だったり韓国語だったり略称だったりするので、
agentには新しく名前を起こさせず**この6体のどれかに割り当てさせる**。後段のマージが安定する。
"""
import json, os, sys, glob, math

MAX_CHARS = 24000   # 極端に長い記事は末尾を落とす(個体紹介は前〜中盤に来るのが通例)
N_BATCHES = int(sys.argv[4]) if len(sys.argv) > 4 else 14

sp, teams_dir, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)

idx = {f"{a['season'].replace('-', '')}_{a['rank']:05d}": a
       for a in json.load(open(os.path.join(teams_dir, 'derived/articles-index.json'), encoding='utf-8'))}

teams = {}
for f in sorted(glob.glob(os.path.join(teams_dir, '*.json'))):
    d = json.load(open(f, encoding='utf-8'))
    for t in d['teams']:
        teams[(d['season'], t['rank'])] = t

# pokesol の構造化カードで6体そろっている記事はLLM不要
done = {k for k, v in json.load(open(os.path.join(sp, 'pokesol.json'), encoding='utf-8')).items()
        if len(v.get('members', [])) >= 6}

tasks = []
for path in sorted(glob.glob(os.path.join(sp, 'text', '*.txt'))):
    key = os.path.splitext(os.path.basename(path))[0]
    if key in done or key not in idx:
        continue
    a = idx[key]
    t = teams.get((a['season'], a['rank']))
    if not t:
        continue
    text = open(path, encoding='utf-8').read()
    truncated = len(text) > MAX_CHARS
    body = text[:MAX_CHARS]

    roster = '\n'.join(
        f"{i}. {p['pokemon']}"
        + (f"（{p['form']}）" if p['form'] else '')
        + f" / 持ち物: {p['item'] or '不明'}"
        for i, p in enumerate(t['team'], 1))

    md = f"""# 抽出タスク {key}

- 記事URL: {a['url']}
- 記事タイトル: {a['title']}
- シーズン: {a['season']} / 順位: {a['rank']}位 / プレイヤー: {a['trainer']}

## このチームの6体（公式ランキング由来。これが正。増やさない・減らさない）

{roster}

## 記事本文{'（長いため先頭' + str(MAX_CHARS) + '文字に切り詰め）' if truncated else ''}

```
{body}
```
"""
    open(os.path.join(outdir, key + '.md'), 'w', encoding='utf-8').write(md)
    tasks.append({'key': key, 'chars': len(md)})

# 文字数の大きい順に、いちばん軽いバッチへ詰める(LPT法)。1バッチが極端に重くならないように。
tasks.sort(key=lambda r: -r['chars'])
batches = [[] for _ in range(N_BATCHES)]
loads = [0] * N_BATCHES
for t in tasks:
    i = loads.index(min(loads))
    batches[i].append(t['key'])
    loads[i] += t['chars']

json.dump({'batches': batches, 'loads': loads},
          open(os.path.join(outdir, '_batches.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print(f'{len(tasks)} tasks -> {N_BATCHES} batches')
print('sizes:', [len(b) for b in batches])
print('chars:', loads)
