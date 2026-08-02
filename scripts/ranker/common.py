"""ranker パイプライン共通のキー生成・HTTPヘッダー。"""

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
# champs.pokedb.tokyo はブラウザ以外のUAを403で弾くため、必ずこのUAを使う。
HEADERS = {'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8'}


def key_of(season, rank):
    """記事/チームのキャッシュキー。season は 'M-1' 形式、戻り値は 'M1_00001' 形式。"""
    return f"{season.replace('-', '')}_{rank:05d}"
