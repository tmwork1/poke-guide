# 委任テンプレート

## 記事抽出者テンプレート(P3、バッチ数だけ並列起動)

```
Agent({
  subagent_type: "general-purpose",
  model: "haiku",
  description: "構築記事から個体情報を抽出(バッチ<N>)",
  prompt: `
ポケモンの構築記事から個体情報を抽出する。まず以下を読み、記載の仕様に厳密に従うこと。

  C:\\Users\\tmtmp\\Documents\\pokemon\\poke-guide\\scripts\\ranker\\EXTRACTION_SPEC.md

担当するタスクファイル(<CACHE>\\tasks\\ 配下、計<バッチ件数>件):
  <KEY1>.md
  <KEY2>.md
  ...

各ファイルについて次を行う:
  1. <CACHE>\\tasks\\<KEY>.md を読む
  2. EXTRACTION_SPEC.md の出力スキーマ・厳守ルールに従って本文から個体情報を読み取る
  3. <CACHE>\\llm\\<KEY>.json を書く(出力先ディレクトリが無ければ作る)

厳守:
  - git操作(add/commit/push含む)は一切行わない。ファイルのRead/Writeのみ。
  - 推測で埋めない。読み取れない項目は null(技は空配列)。
  - 全ファイルの処理が終わったら、処理したKEYの一覧と has_content:false にしたKEYを報告する。
`
})
```

- 1回のAgent呼び出しにつき1バッチ(`_batches.json` の1要素)を丸ごと担当させる。バッチをまたいで分割しない(文字数バランスが崩れる)。
- 欠けKEYの再回収は、同じテンプレートの担当リストを欠けKEY分だけに絞って1体起動すればよい。

## 表記ゆれ辞書テンプレート(P4、必要になった回だけ)

```
Agent({
  subagent_type: "general-purpose",
  model: "haiku",
  description: "name-aliases.jsonへの追記候補を作成",
  prompt: `
ポケモン構築記事の技名/特性名の表記ゆれ辞書を更新する。

以下を読む:
  - C:\\Users\\tmtmp\\Documents\\pokemon\\poke-guide\\scripts\\ranker\\name-aliases.json (既存の辞書。フォーマットはこれに合わせる)
  - C:\\Users\\tmtmp\\Documents\\pokemon\\poke-guide\\docs\\ranker\\derived\\extraction-report.json の rejected_by_validation
    (LLM出力の中で語彙照合に失敗して却下された生の文字列と件数)

やること:
  - rejected_by_validation に出てくる文字列のうち、表記ゆれ(略称・漢字表記・全角半角・送り仮名違い等)が原因で
    実在の技/特性に対応づけられるものを name-aliases.json に追記する候補を JSON で示す。
  - 右辺(正式名)は、以下のいずれかに実在する文字列でなければならない。実在しない技/特性を右辺に置かない。
      - public/master-data/autocomplete/moves.json
      - public/master-data/autocomplete/abilities.json
      - scripts/ranker/champions-vocab.json
  - 対応が分からない/複数候補があって確信が持てないものは候補に入れない(捏造しない)。
  - name-aliases.json そのものは編集せず、追記候補を {"左辺":"右辺", ...} の形で報告する。

厳守:
  - git操作は一切行わない。
`
})
```

Coordinatorが報告された候補をレビューしてから `name-aliases.json` に自分で追記する(辞書は誤りが混入するとサイレントに誤った技へ寄せてしまうため、機械的に丸呑みしない)。
