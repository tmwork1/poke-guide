import json, sys

def decode(path):
    """React Router turbo-stream flat-array payload -> plain python objects."""
    raw = open(path, encoding='utf-8').read().split('\n')[0]
    flat = json.loads(raw)
    memo = {}

    def res(i):
        # turbo-stream は負のインデックスを undefined/null/NaN/Infinity の番兵に使う。
        # pokesol のペイロードでは -5 が「値なし」(単タイプの type2、abilityId 未指定 等)として
        # 現れるため、番兵は一律 None に潰す(NaN/Infinity を必要とする値は含まれない)。
        if isinstance(i, int) and i < 0:
            return None
        if i in memo:
            return memo[i]
        v = flat[i]
        if isinstance(v, dict):
            out = {}
            memo[i] = out
            for k, vi in v.items():
                out[res(int(k[1:]))] = res(vi)
            return out
        if isinstance(v, list):
            # 先頭が文字列の配列は ["D", 1778677582386] のような型タグ付きの特殊値
            # (通常の配列の要素は必ず整数インデックス)。ペイロードはインデックスではなく
            # リテラル値なので、解決せずそのまま返す(Date=epoch ms 等)。
            if v and isinstance(v[0], str):
                lit = v[1] if len(v) > 1 else None
                memo[i] = lit
                return lit
            out = []
            memo[i] = out
            for vi in v:
                out.append(res(vi))
            return out
        memo[i] = v
        return v

    return res(0)

if __name__ == '__main__':
    d = decode(sys.argv[1])
    json.dump(d, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, default=str)
    print('ok')
