"""キャッシュした記事HTMLを、subagentに読ませるためのプレーンテキストに落とす。

生HTMLのままではブログのナビ/広告/スクリプトでトークンを食い潰すため、本文らしき部分だけ残す。
表(<table>)は行区切りを保持する — 構築記事は個体情報を表で書くことが多く、
セルの区切りが消えると努力値の読み取りが壊れるため。
画像しか無い記事は alt / img src を残しておき、「本文に情報が無い」ことを後段が判定できるようにする。
"""
import json, os, re, sys, glob
from bs4 import BeautifulSoup

DROP = ['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'header', 'footer',
        'aside', 'form', 'button', 'select']
# 本文コンテナの候補(はてな/note/naver/独自CMSでよく使われるもの)を優先度順に試す
BODY_SELECTORS = [
    'div.entry-content', 'div.hatenablog-entry', 'article.entry',
    'div.note-common-styles__textnote-body', 'div#note-body',
    'div.se-main-container', 'div#postViewArea',
    'article', 'main', 'div#content', 'body',
]


def to_text(html):
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(DROP):
        t.decompose()

    root = None
    for sel in BODY_SELECTORS:
        found = soup.select(sel)
        if found:
            root = max(found, key=lambda e: len(e.get_text()))
            if len(root.get_text(strip=True)) > 200 or sel == 'body':
                break
    if root is None:
        root = soup

    # 表とリストの構造を壊さないよう、セル/行の区切りを明示的な記号に置換してから text 化する
    for td in root.find_all(['td', 'th']):
        td.insert_after(' | ')
    for tr in root.find_all(['tr', 'li', 'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4']):
        tr.insert_after('\n')
    for img in root.find_all('img'):
        alt = (img.get('alt') or '').strip()
        img.replace_with(f'\n[IMG{" alt=" + alt if alt else ""}]\n')

    text = root.get_text()
    text = re.sub(r'[ \t　]+', ' ', text)
    text = re.sub(r' *\n *', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


if __name__ == '__main__':
    cache, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    rows = []
    for p in sorted(glob.glob(os.path.join(cache, '*.html'))):
        key = os.path.splitext(os.path.basename(p))[0]
        raw = open(p, encoding='utf-8', errors='replace').read()
        try:
            txt = to_text(raw)
        except Exception as e:
            txt = ''
            print('FAIL', key, e)
        dest = os.path.join(outdir, key + '.txt')
        open(dest, 'w', encoding='utf-8').write(txt)
        rows.append({'key': key, 'chars': len(txt), 'imgs': txt.count('[IMG')})
    rows.sort(key=lambda r: r['chars'])
    json.dump(rows, open(os.path.join(outdir, '_sizes.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    total = sum(r['chars'] for r in rows)
    print(f'{len(rows)} files, total {total:,} chars, median '
          f'{rows[len(rows) // 2]["chars"]:,}, max {rows[-1]["chars"]:,}')
    print('smallest 10:', [(r['key'], r['chars']) for r in rows[:10]])
