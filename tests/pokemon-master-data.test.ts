// imageId(画像用PokeAPI ID)を使ったURL組み立てと、メガシンカ等の特殊フォルムが
// ベース種族の画像にフォールバックしてしまう不具合の回帰テスト。
// 期待値は仕様(imageIdはまずvendor/jpokeのja_to_id_map.json (sections.pokemon.by_ja_name) から
// 解決し、それでも解決できないものはscripts/build-master-data/extract_autocomplete.pyの
// 手書き上書き表 _IMAGE_ID_OVERRIDES を試し、それも無ければdexNo(本来の全国図鑑番号)に
// フォールバックする)から導いたもので、src/lib/pokemon-master-data.ts /
// scripts/build-master-data/extract_autocomplete.py の実装をそのまま転記したものではない。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  spriteUrl,
  officialArtworkUrl,
  loadMultiHitMoveMap,
  loadMegaStoneMap,
} from '../src/lib/pokemon-master-data.ts';

const SPRITES_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';

describe('spriteUrl', () => {
  it('imageIdからスプライト画像URLを組み立てる(通常種)', () => {
    assert.equal(spriteUrl(1), `${SPRITES_BASE}/pokemon/1.png`);
  });

  it('10000番台のimageId(メガシンカ等の特殊フォルム専用ID)も同じ規則でURLを組み立てる', () => {
    assert.equal(spriteUrl(10034), `${SPRITES_BASE}/pokemon/10034.png`);
  });
});

describe('officialArtworkUrl', () => {
  it('imageIdから公式絵URLを組み立てる(通常種)', () => {
    assert.equal(officialArtworkUrl(1), `${SPRITES_BASE}/pokemon/other/official-artwork/1.png`);
  });

  it('10000番台のimageId(メガシンカ等の特殊フォルム専用ID)も同じ規則でURLを組み立てる', () => {
    assert.equal(
      officialArtworkUrl(10034),
      `${SPRITES_BASE}/pokemon/other/official-artwork/10034.png`,
    );
  });
});

describe('public/master-data/autocomplete/pokemon.json のimageId(回帰テスト)', () => {
  // 「メガシンカ等の別フォルムのポケモン画像がベース種族の画像になってしまう」不具合の
  // 再発を検知する。生成済みの静的JSONを直接読んで検証する(ビルド済み成果物の検証のため、
  // このテストはビルドスクリプト実行後にのみ意味を持つ)。
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pokemonJsonPath = path.join(
    __dirname,
    '..',
    'public',
    'master-data',
    'autocomplete',
    'pokemon.json',
  );
  const pokemonList = JSON.parse(readFileSync(pokemonJsonPath, 'utf-8')) as Array<{
    name: string;
    dexNo: number;
    imageId: number;
    forme: string | null;
    types: string[];
  }>;

  function findByName(name: string) {
    const entry = pokemonList.find((p) => p.name === name);
    assert.ok(entry, `${name} が pokemon.json に見つかりません`);
    return entry as NonNullable<typeof entry>;
  }

  it('メガリザードンXはベース種族(リザードン)とは異なる専用imageIdを持ち、dexNoは書き換わらない', () => {
    const megaX = findByName('メガリザードンX');
    const base = findByName('リザードン');
    assert.equal(megaX.dexNo, 6, 'dexNoは本来の全国図鑑番号(ベース種族)のままであるべき');
    assert.notEqual(megaX.imageId, megaX.dexNo, 'imageIdはdexNoとは別の専用IDに解決されるべき');
    assert.notEqual(megaX.imageId, base.imageId, 'メガシンカの画像はベース種族の画像と異なるべき');
  });

  it('メガリザードンXとメガリザードンYは同じdexNoでも互いに異なるimageIdを持つ', () => {
    const megaX = findByName('メガリザードンX');
    const megaY = findByName('メガリザードンY');
    assert.equal(megaX.dexNo, megaY.dexNo);
    assert.notEqual(megaX.imageId, megaY.imageId);
  });

  it('リザードン(キョダイ)もベース種族(リザードン)とは異なる専用imageIdを持つ', () => {
    const gmax = findByName('リザードン(キョダイ)');
    const base = findByName('リザードン');
    assert.equal(gmax.dexNo, base.dexNo);
    assert.notEqual(gmax.imageId, gmax.dexNo);
    assert.notEqual(gmax.imageId, base.imageId);
  });

  it('メガフシギバナはベース種族(フシギバナ)とは異なる専用imageIdを持つ', () => {
    const mega = findByName('メガフシギバナ');
    assert.notEqual(mega.imageId, mega.dexNo);
  });

  it('ヌメルゴン(ヒスイ)はベース種族(ヌメルゴン)とは異なる専用imageIdを持つ', () => {
    const hisui = findByName('ヌメルゴン(ヒスイ)');
    const base = findByName('ヌメルゴン');
    assert.notEqual(hisui.imageId, hisui.dexNo);
    assert.notEqual(hisui.imageId, base.imageId);
  });

  it('forme が null の通常種は imageId が dexNo と一致する(フォルムが無ければベース種族の画像でよい)', () => {
    const base = findByName('リザードン');
    assert.equal(base.forme, null);
    assert.equal(base.imageId, base.dexNo);
  });

  it('ヒヒダルマ(ガラル)はextract_autocomplete.pyの上書き表(_IMAGE_ID_OVERRIDES)で解決され、dexNoにフォールバックしない', () => {
    // vendor/jpoke の ja_to_id_map.json 側ではPokeAPI名が見つからない(pokeapi_name_not_found)
    // ため、以前はdexNoへのフォールバックが既知の残課題だった。
    // scripts/build-master-data/extract_autocomplete.py の _IMAGE_ID_OVERRIDES に
    // darmanitan-galar-standard (id=10177) を手書きで追加して解決した。
    const entry = findByName('ヒヒダルマ(ガラル)');
    assert.notEqual(entry.imageId, entry.dexNo);
  });

  it('PokeAPI側に専用画像が存在しないフォルムは、既知どおりdexNoにフォールバックする(ミノムッチ(すなち))', () => {
    // burmyのフォルム(すなち/ゴミ)はPokeAPIにフォルム別idが存在しない
    // (pokemon-species/burmy の varieties が "burmy" 1件のみ)ため、
    // _IMAGE_ID_OVERRIDES にも意図的に追加していない、既知の残課題。
    const entry = findByName('ミノムッチ(すなち)');
    assert.equal(entry.imageId, entry.dexNo);
  });

  it('ネクロズマ(たそがれ)とネクロズマ(あかつき)は互いに異なる専用imageIdを持ち、いずれもdexNoとは別(_IMAGE_ID_OVERRIDESの回帰テスト)', () => {
    const dusk = findByName('ネクロズマ(たそがれ)');
    const dawn = findByName('ネクロズマ(あかつき)');
    assert.notEqual(dusk.imageId, dusk.dexNo);
    assert.notEqual(dawn.imageId, dawn.dexNo);
    assert.notEqual(dusk.imageId, dawn.imageId, 'たそがれとあかつきの画像は互いに異なるべき');
  });

  it('オーガポンの各仮面(いど・かまど・いしずえ)は互いに異なる専用imageIdを持ち、いずれもdexNoとは別(_IMAGE_ID_OVERRIDESの回帰テスト)', () => {
    const wellspring = findByName('オーガポン(いど)');
    const hearthflame = findByName('オーガポン(かまど)');
    const cornerstone = findByName('オーガポン(いしずえ)');
    for (const mask of [wellspring, hearthflame, cornerstone]) {
      assert.notEqual(mask.imageId, mask.dexNo);
    }
    const imageIds = new Set([wellspring.imageId, hearthflame.imageId, cornerstone.imageId]);
    assert.equal(imageIds.size, 3, '仮面ごとのimageIdは互いに異なるべき');
  });

  it('オーガポンのテラスタル状態は、対応する仮面の非テラスタル版と同じimageIdになる(専用アートワークがPokeAPIに存在しないため)', () => {
    const wellspring = findByName('オーガポン(いど)');
    const wellspringTera = findByName('オーガポン(いど,テラスタル)');
    assert.equal(wellspringTera.imageId, wellspring.imageId);
  });
});

describe('public/master-data/autocomplete/moves.json の hits(連続技の回帰テスト)', () => {
  // 連続技(1ターンに複数回ヒットする技)だけ "hits": [最小, 最大] を持つ静的JSONの
  // 生成結果を検証する。ヒット回数の一次情報源は vendor/jpoke の
  // data/moves/move_*.py に書かれた MoveData.multi_hit であり
  // (scripts/build-master-data/extract_autocomplete.py の build_moves 参照)、
  // このテストはビルドスクリプト実行後にのみ意味を持つ(前掲の pokemon.json 回帰テストと同様)。
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const movesJsonPath = path.join(
    __dirname,
    '..',
    'public',
    'master-data',
    'autocomplete',
    'moves.json',
  );
  const movesList = JSON.parse(readFileSync(movesJsonPath, 'utf-8')) as Array<{
    name: string;
    type: string | null;
    category: string | null;
    hits?: [number, number];
  }>;

  function findMoveByName(name: string) {
    const entry = movesList.find((m) => m.name === name);
    assert.ok(entry, `${name} が moves.json に見つかりません`);
    return entry as NonNullable<typeof entry>;
  }

  it('タネマシンガン・ロックブラスト・ミサイルばりは2〜5回のhitsを持つ', () => {
    assert.deepEqual(findMoveByName('タネマシンガン').hits, [2, 5]);
    assert.deepEqual(findMoveByName('ロックブラスト').hits, [2, 5]);
    assert.deepEqual(findMoveByName('ミサイルばり').hits, [2, 5]);
  });

  it('ダブルアタック・ドラゴンアローは2回固定のhitsを持つ', () => {
    assert.deepEqual(findMoveByName('ダブルアタック').hits, [2, 2]);
    assert.deepEqual(findMoveByName('ドラゴンアロー').hits, [2, 2]);
  });

  it('みずしゅりけんは2〜5回のhitsを持つ', () => {
    assert.deepEqual(findMoveByName('みずしゅりけん').hits, [2, 5]);
  });

  it('ネズミざんは10回固定、ふくろだたきは1〜6回のhitsを持つ(通常の2〜5回とは異なる特殊な連続技)', () => {
    assert.deepEqual(findMoveByName('ネズミざん').hits, [10, 10]);
    assert.deepEqual(findMoveByName('ふくろだたき').hits, [1, 6]);
  });

  it('連続技でない技(10まんボルト)には hits キー自体が存在しない', () => {
    const entry = findMoveByName('10まんボルト');
    assert.equal('hits' in entry, false);
  });
});

describe('public/master-data/autocomplete/mega-stones.json(メガストーン対応表の回帰テスト)', () => {
  // メガ後種族名 -> メガストーン名の前向き対応表(scripts/build-master-data/extract_autocomplete.py
  // の build_mega_stones を参照)。「メガXXX」→「XXXナイト」という命名規則では
  // 85件中32件(約38%)が不一致になることが実測で分かっている(例: メガゲンガー→ゲンガナイト、
  // メガリザードンX→リザードナイトX)ため、この静的JSONを唯一の情報源として扱う必要がある。
  // このテストはビルドスクリプト実行後にのみ意味を持つ(前掲の pokemon.json 回帰テストと同様)。
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const megaStonesJsonPath = path.join(
    __dirname,
    '..',
    'public',
    'master-data',
    'autocomplete',
    'mega-stones.json',
  );
  const megaStonesList = JSON.parse(readFileSync(megaStonesJsonPath, 'utf-8')) as Array<{
    species: string;
    item: string;
  }>;

  function findBySpecies(species: string) {
    return megaStonesList.find((m) => m.species === species);
  }

  it('メガリザードンX -> リザードナイトX(サフィックスの位置が命名規則と異なる例)', () => {
    assert.equal(findBySpecies('メガリザードンX')?.item, 'リザードナイトX');
  });

  it('命名規則(「メガXXX」→「XXXナイト」)では導出できない例', () => {
    // 規則どおりなら「ゲンガーナイト」「スターミーナイト」になるはずだが、実際は長音が
    // 省略される。
    assert.equal(findBySpecies('メガゲンガー')?.item, 'ゲンガナイト');
    assert.equal(findBySpecies('メガスターミー')?.item, 'スターミナイト');
    assert.equal(findBySpecies('メガフーディン')?.item, 'フーディナイト');
    assert.equal(findBySpecies('メガピクシー')?.item, 'ピクシナイト');
  });

  it('メガニャオニクス(オス)/(メス)は両方とも含まれ、同じアイテム名を持つ(前向き対応表なので曖昧にならない)', () => {
    // jpoke.data.megaevol.MEGA_STONES(逆引き)では、1アイテムに複数のメガ後フォルムが
    // 対応するため両方とも除外される。前向きに作ることでこの欠落を回避している。
    assert.equal(findBySpecies('メガニャオニクス(オス)')?.item, 'ニャオニクスナイト');
    assert.equal(findBySpecies('メガニャオニクス(メス)')?.item, 'ニャオニクスナイト');
  });

  it('メガレックウザは含まれない(メガストーン不要。技「ガリョウテンセイ」が条件)', () => {
    assert.equal(findBySpecies('メガレックウザ'), undefined);
  });

  it('メガニウム・メガヤンマは含まれない(名前が「メガ」で始まるがメガシンカではない)', () => {
    assert.equal(findBySpecies('メガニウム'), undefined);
    assert.equal(findBySpecies('メガヤンマ'), undefined);
  });

  it('原始回帰(ゲンシカイオーガ・ゲンシグラードン)は含まれない(forme="Primal"で"Mega"を含まないため対象外)', () => {
    assert.equal(findBySpecies('ゲンシカイオーガ'), undefined);
    assert.equal(findBySpecies('ゲンシグラードン'), undefined);
  });
});

describe('loadMultiHitMoveMap', () => {
  it('連続技のみを抽出し、技名 -> [最小, 最大] のMapを返す(単発技はキーに含まれない)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { name: '10まんボルト', type: 'でんき', category: 'special' },
          { name: 'タネマシンガン', type: 'くさ', category: 'physical', hits: [2, 5] },
          { name: 'ダブルアタック', type: 'ノーマル', category: 'physical', hits: [2, 2] },
        ]),
      )) as unknown as typeof fetch;

    try {
      const map = await loadMultiHitMoveMap();
      assert.equal(map.size, 2);
      assert.deepEqual(map.get('タネマシンガン'), [2, 5]);
      assert.deepEqual(map.get('ダブルアタック'), [2, 2]);
      assert.equal(map.has('10まんボルト'), false, '単発技はMapに含まれるべきではない');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('loadMegaStoneMap', () => {
  // ⚠️ loadMegaStoneMap はモジュールスコープの Promise キャッシュ(megaStoneCache)を持つ。
  // 成功時はキャッシュを保持し続けるが、失敗時は catch 内で null に戻して次回の再取得を
  // 許すため(他の load*Map と同じ挙動)、「fetch失敗」のテストを先に実行しないと、
  // 後続の「成功」テストで作られたキャッシュ済みMapがそのまま返ってしまい、
  // 2件目のfetchモックが一度も呼ばれずに検証が成立しなくなる。この順序は意図的。
  it('fetch失敗時は空のMapを返す(loadMultiHitMoveMap等と同じエラー時の挙動)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    try {
      const map = await loadMegaStoneMap();
      assert.equal(map.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('メガ後種族名 -> メガストーン名のMapを返す(命名規則では導出できない例を含む)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { species: 'メガリザードンX', item: 'リザードナイトX' },
          { species: 'メガゲンガー', item: 'ゲンガナイト' },
          { species: 'メガニャオニクス(オス)', item: 'ニャオニクスナイト' },
          { species: 'メガニャオニクス(メス)', item: 'ニャオニクスナイト' },
        ]),
      )) as unknown as typeof fetch;

    try {
      const map = await loadMegaStoneMap();
      assert.equal(map.size, 4);
      assert.equal(map.get('メガリザードンX'), 'リザードナイトX');
      assert.equal(map.get('メガゲンガー'), 'ゲンガナイト');
      assert.equal(map.get('メガニャオニクス(オス)'), 'ニャオニクスナイト');
      assert.equal(map.get('メガニャオニクス(メス)'), 'ニャオニクスナイト');
      assert.equal(map.has('メガレックウザ'), false, '一覧に無い種族はMapに含まれるべきではない');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
