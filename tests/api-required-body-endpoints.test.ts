// 書き込み系APIエンドポイント7箇所(PUT /api/owned-pokemon/:id, POST /api/owned-pokemon,
// PUT /api/opponent-notes/:id, POST /api/opponent-notes, PUT /api/owned-pokemon/:id/share,
// POST /api/events, POST /api/damage-calcs, POST /api/search)が、空ボディを一貫して400で
// 拒否することを検証する回帰テスト。
//
// ##### 背景(データ消失バグ) #####
// readJsonBody() は空ボディを「JSONでない入力とは違うエラー無しの null」として返す設計になっている。
// これを各エンドポイントが `body.data ?? {}` で穴埋めしていたため、全フィールドが任意項目の
// validateOwnedPokemonRequestBody (owned-pokemon-validation.ts) では {} がそのまま検証を通過し、
// PUT /api/owned-pokemon/:id では既存個体の species_name/nature/ability_name/item_name/evs/
// move_names 等が軒並み空/既定値で上書きされてデータが消失していた(POST /api/owned-pokemon では
// 空レコードが作られていた)。
//
// この修正では readRequiredJsonBody (src/pages/api/_shared.ts) を追加し、7箇所すべてで
// readJsonBody の代わりに使うことで、空ボディを「JSONオブジェクトでないボディ」と同じ
// 400クラスのエラーに合流させた(各バリデータの既存メッセージ 'Request body must be a JSON object'
// と統一)。
//
// ##### 調査で判明した前提の修正 #####
// owned-pokemon.ts(PUT/POST)以外の5エンドポイントは、実際には空ボディでも「もともと」400を
// 返していたことが分かった(必須フィールドがバリデータ内に存在するため): opponent-notes.ts POSTは
// owned_pokemon_id必須、opponent-notes/[id].ts PUTはopponent_build必須、share.tsはis_public必須、
// events.tsはevent_type必須、damage-calcs.tsはattacker_name等必須。owned-pokemon-validation.tsだけが
// 全フィールド任意(PUTの「全項目を毎回送る」自動保存設計のため)という特殊な形をしており、
// これが {} を素通りさせる唯一のバリデータだった。とはいえ「同じ穴のパターンを一貫して塞ぐ」
// という方針どおり、7箇所とも同じ readRequiredJsonBody に統一してあり、以下のテストは
// 各エンドポイントのソースに実際に書かれている「readRequiredJsonBody → validator」の組み合わせを
// そのまま再現して検証する(node --testではAstroのAPIContext全体を模擬するよりこの粒度の方が
// 既存の *-validation.test.ts の流儀に合う。認証・DBアクセスを経ないため、DBへの影響が
// そもそも起こり得ないことを構造的に保証する)。
//
// ##### ラウンド2の追加修正(このコメント自体が見落としていた穴) #####
// 上の段落は「readRequiredJsonBodyが空ボディ(未送信)を弾く」ことしか検証しておらず、
// body: '{}' (有効なJSONオブジェクトなので readRequiredJsonBody は普通に通す) は範囲外だった。
// Coordinatorが実測したところ、PUT /api/owned-pokemon/:id に {} を投げると実際に200が返り、
// 既存個体の species_name/nature/ability_name/item_name/evs/move_names 等が全消去された
// (フィクスチャが1回消え、手で復元した)。原因は validateOwnedPokemonRequestBody が全フィールドを
// 任意項目として扱っていたため(PUTの「全項目上書き」契約なのに検証側は「全項目あってもなくても可」
// のままだった)。owned-pokemon-validation.ts に mode: 'replace' オプションを追加し、
// PUTハンドラ(owned-pokemon/[id].ts)だけそれを渡すことで塞いだ(POSTは従来どおり)。
// opponent-notes/[id].ts PUT と share.ts PUT は {} を実際に投げて確認したところ、既存の
// 必須フィールドチェック(opponent_build.name / is_public)がすでに {} を拒否しており、
// 追加修正は不要だった(下の該当describe内のテストで実測結果をそのまま固定する)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { badRequest, readRequiredJsonBody } from '../src/pages/api/_shared.ts';
import { validateOwnedPokemonRequestBody } from '../src/lib/owned-pokemon-validation.ts';
import { validateOpponentNoteRequestBody } from '../src/lib/opponent-notes-validation.ts';
import { validateEventRequestBody } from '../src/lib/event-validation.ts';
import { validateDamageCalcRequestBody } from '../src/lib/damage-calc-validation.ts';
import { validateSearchRequestBody } from '../src/lib/search-validation.ts';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

function emptyBodyRequest(url: string, method: string): Request {
  return new Request(url, { method, body: '' });
}

describe('PUT /api/owned-pokemon/:id (owned-pokemon/[id].ts) のボディ処理', () => {
  it('空ボディは400になり、validateOwnedPokemonRequestBodyには到達しない(データ消失バグの直接的な回帰テスト)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/owned-pokemon/x', 'PUT'));
    // ここで response が無ければ、続くコードは `validateOwnedPokemonRequestBody(body.data)` を
    // {} 相当の入力で呼び出してしまい、修正前は ok:true(全項目既定値)を返していた。
    assert.ok(body.response, 'body.responseが設定され、後続のvalidateOwnedPokemonRequestBody呼び出しに到達しないこと');
    assert.equal(body.response?.status, 400);
    const json = await body.response!.json();
    assert.equal(json.error, 'Request body must be a JSON object');
  });

  it('修正前の実装(body.data ?? {})を模した場合、空ボディがok:true(全項目既定値)を通してしまうことを確認する(退行検知用の対照実験)', () => {
    // このテスト自体は「修正前がどれだけ危険だったか」を明示するためのものであり、
    // 現在のコード(owned-pokemon/[id].ts)はこの `?? {}` パターンを使っていない。
    const bodyDataAfterEmptyRead: unknown = null; // readJsonBody('') は { data: null } を返す
    const validation = validateOwnedPokemonRequestBody(bodyDataAfterEmptyRead ?? {});
    assert.equal(validation.ok, true, '全フィールド任意のバリデータは {} を素通りさせる(これが今回のバグの核心)');
    if (validation.ok) {
      assert.equal(validation.value.species_name, '');
      assert.equal(validation.value.nature, null);
      assert.equal(validation.value.ability_name, null);
      assert.equal(validation.value.item_name, null);
      assert.deepEqual(validation.value.evs, [0, 0, 0, 0, 0, 0]);
      assert.deepEqual(validation.value.move_names, []);
    }
  });

  it('正常なボディは従来どおり200相当(ok:true)で更新値を返す(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x', {
      method: 'PUT',
      body: JSON.stringify({
        nickname: 'エース',
        species_name: 'リザードン',
        level: 50,
        nature: 'いじっぱり',
        ability_name: 'かたいツメ',
        item_name: 'こだわりハチマキ',
        tera_type: 'ほのお',
        evs: [0, 32, 0, 0, 0, 16],
        ivs: [31, 31, 31, 31, 31, 31],
        move_names: ['フレアドライブ', 'がんせきふうじ'],
        memo: '',
        tags: [],
        is_pinned: false,
      }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOwnedPokemonRequestBody(body.data);
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.value.species_name, 'リザードン');
      assert.equal(validation.value.ability_name, 'かたいツメ');
      assert.deepEqual(validation.value.evs, [0, 32, 0, 0, 0, 16]);
      assert.deepEqual(validation.value.move_names, ['フレアドライブ', 'がんせきふうじ']);
    }
  });

  it('壊れたJSONは従来どおり400(Invalid JSON payload)で、空ボディと同じ経路にはならない', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x', { method: 'PUT', body: '{broken' });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response?.status, 400);
    const json = await body.response!.json();
    assert.equal(json.error, 'Invalid JSON payload');
  });

  // ##### ラウンド2の修正: {} (readRequiredJsonBodyは通すが全フィールド未送信) #####
  // 直前の修正(readRequiredJsonBody追加、上のdescribeの各テスト)は「ボディが無い」ケースしか
  // 塞げておらず、body: '{}' は readRequiredJsonBody を通過してしまう(有効なJSONオブジェクトの
  // ため)。実際にCoordinatorが `PUT { body: "{}" }` を投げたところ200が返り、既存個体の
  // species_name/nature/ability_name/item_name/evs/move_names 等が全消去された
  // (フィクスチャが1回消え、手で復元した実測結果)。この穴は owned-pokemon/[id].ts が
  // validateOwnedPokemonRequestBody(body.data, { mode: 'replace' }) を呼ぶことで塞いだ
  // (owned-pokemon/[id].ts の実装をそのまま再現する)。
  it('{} は readRequiredJsonBody を通過するが、mode: "replace" のバリデータが400で拒否する', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x', { method: 'PUT', body: '{}' });
    const body = await readRequiredJsonBody<unknown>(request);
    // readRequiredJsonBody自体は {} を正当なJSONオブジェクトとして通す
    // (「ボディが無い」わけではないため、ここでは400にならない)。
    assert.equal(body.response, undefined);
    assert.deepEqual(body.data, {});

    const validation = validateOwnedPokemonRequestBody(body.data, { mode: 'replace' });
    assert.equal(validation.ok, false, 'mode: "replace" は{}(全フィールド未送信)を拒否しなければならない');
  });

  it('一部キー(move_names)だけ欠けたPUTペイロードも、mode: "replace" のバリデータが400で拒否する', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x', {
      method: 'PUT',
      body: JSON.stringify({
        nickname: null,
        species_name: 'リザードン',
        level: null,
        nature: 'いじっぱり',
        ability_name: 'かたいツメ',
        item_name: 'こだわりハチマキ',
        tera_type: null,
        evs: [0, 32, 0, 0, 0, 16],
        ivs: [31, 31, 31, 31, 31, 31],
        // move_names を意図的に省略する。
        memo: null,
        tags: [],
        is_pinned: false,
      }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOwnedPokemonRequestBody(body.data, { mode: 'replace' });
    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.match(validation.error, /move_names/);
    }
  });

  it('完全なペイロードのPUTは mode: "replace" でも従来どおり200相当(ok:true)で更新値を返す(退行なし)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x', {
      method: 'PUT',
      body: JSON.stringify({
        nickname: 'エース',
        species_name: 'リザードン',
        level: 50,
        nature: 'いじっぱり',
        ability_name: 'かたいツメ',
        item_name: 'こだわりハチマキ',
        tera_type: 'ほのお',
        evs: [0, 32, 0, 0, 0, 16],
        ivs: [31, 31, 31, 31, 31, 31],
        move_names: ['フレアドライブ', 'がんせきふうじ'],
        memo: '',
        tags: [],
        is_pinned: false,
      }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOwnedPokemonRequestBody(body.data, { mode: 'replace' });
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.value.species_name, 'リザードン');
      assert.deepEqual(validation.value.evs, [0, 32, 0, 0, 0, 16]);
      assert.deepEqual(validation.value.move_names, ['フレアドライブ', 'がんせきふうじ']);
    }
  });
});

describe('POST /api/owned-pokemon (owned-pokemon.ts) のボディ処理', () => {
  it('空ボディは400になり、空レコード作成には至らない', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/owned-pokemon', 'POST'));
    assert.equal(body.response?.status, 400);
  });

  it('「＋ 個体を追加」相当の最小ボディ(空文字species_name等)は従来どおり受け入れる(仕様の意図的な許容)', async () => {
    // src/pages/box/index.astro の createEmptyPokemon() は空ボディではなく、
    // 全項目を明示したJSONボディ(species_name: "" 等)を送る。これはバリデータが意図的に
    // 許容している「空個体の自動登録」であり、今回の修正対象(未送信のボディ)とは別物。
    const request = new Request('http://localhost/api/owned-pokemon', {
      method: 'POST',
      body: JSON.stringify({
        nickname: '',
        species_name: '',
        level: null,
        nature: '',
        ability_name: '',
        item_name: '',
        tera_type: '',
        evs: [0, 0, 0, 0, 0, 0],
        ivs: [31, 31, 31, 31, 31, 31],
        move_names: [],
        memo: '',
        tags: [],
        is_pinned: false,
      }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOwnedPokemonRequestBody(body.data);
    assert.equal(validation.ok, true);
  });

  it('POSTは {} でも従来どおり通す(mode: "replace" を渡さないため、空個体の自動登録を壊さない)', async () => {
    // src/pages/api/owned-pokemon.ts の POST は validateOwnedPokemonRequestBody(body.data) を
    // オプション無しで呼ぶ(owned-pokemon.ts の実装をそのまま再現する)。PUTの穴を塞ぐ
    // mode: 'replace' はPUTハンドラ(owned-pokemon/[id].ts)にしか渡していないことの確認。
    const request = new Request('http://localhost/api/owned-pokemon', { method: 'POST', body: '{}' });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOwnedPokemonRequestBody(body.data);
    assert.equal(validation.ok, true, 'POSTは{}を引き続き受け入れ、空個体を作成できなければならない');
  });
});

describe('PUT /api/opponent-notes/:id (opponent-notes/[id].ts) のボディ処理', () => {
  it('空ボディは400になる(opponent_build必須のため修正前から400ではあったが、メッセージが統一される)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/opponent-notes/x', 'PUT'));
    assert.equal(body.response?.status, 400);
    const json = await body.response!.json();
    assert.equal(json.error, 'Request body must be a JSON object');
  });

  // Coordinatorの指摘(owned-pokemon/[id].tsと同じ「置換契約なのに{}を許してしまう」穴が
  // 他のPUTエンドポイントにも無いか)を受けて実測した結果: opponent-notes/[id].ts の
  // validateOpponentNoteRequestBody は opponent_build.name を必須にしているため、
  // {} (readRequiredJsonBodyは通す)は validateOpponentNoteRequestBody 側で拒否される。
  // owned-pokemon-validation.ts のような追加の mode オプションは不要(既存のバリデータ構造で
  // すでに閉じている)。
  it('{} は readRequiredJsonBody を通過するが、opponent_build必須のバリデータが400で拒否する(実測で確認済み、追加修正は不要)', async () => {
    const request = new Request('http://localhost/api/opponent-notes/x', { method: 'PUT', body: '{}' });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    assert.deepEqual(body.data, {});

    const validation = validateOpponentNoteRequestBody(body.data, { requireOwnedPokemonId: false });
    assert.equal(validation.ok, false, 'opponent_build必須のため{}は拒否されなければならない');
  });

  it('正常なボディは従来どおり更新値を返す(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/opponent-notes/x', {
      method: 'PUT',
      body: JSON.stringify({ opponent_build: { name: 'カイリュー' }, memo: 'メモ' }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOpponentNoteRequestBody(body.data, { requireOwnedPokemonId: false });
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.value.opponent_build.name, 'カイリュー');
      assert.equal(validation.value.memo, 'メモ');
    }
  });
});

describe('POST /api/opponent-notes (opponent-notes.ts) のボディ処理', () => {
  it('空ボディは400になる(owned_pokemon_id必須のため修正前から400ではあったが、メッセージが統一される)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/opponent-notes', 'POST'));
    assert.equal(body.response?.status, 400);
  });

  it('正常なボディは従来どおり作成値を返す(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/opponent-notes', {
      method: 'POST',
      body: JSON.stringify({ owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' } }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateOpponentNoteRequestBody(body.data, { requireOwnedPokemonId: true });
    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.value.owned_pokemon_id, VALID_UUID);
    }
  });
});

describe('PUT /api/owned-pokemon/:id/share (share.ts) のボディ処理', () => {
  // share.ts はバリデータ関数を使わず、is_public の型を直接チェックするインラインロジックのため、
  // ここでは実装(src/pages/api/owned-pokemon/[id]/share.ts)と同じ手順を再現する。
  async function runShareBodyCheck(request: Request): Promise<{ status: 400; message: string } | { isPublic: boolean }> {
    const body = await readRequiredJsonBody<unknown>(request);
    if (body.response) {
      const json = await body.response.json();
      return { status: 400, message: json.error };
    }
    const payload = body.data as Record<string, unknown>;
    if (typeof payload.is_public !== 'boolean') {
      const response = badRequest('is_public must be a boolean');
      const json = await response.json();
      return { status: 400, message: json.error };
    }
    return { isPublic: payload.is_public };
  }

  it('空ボディは400になる(is_public必須のため修正前から400ではあったが、メッセージが "Request body must be a JSON object" に統一される)', async () => {
    const result = await runShareBodyCheck(emptyBodyRequest('http://localhost/api/owned-pokemon/x/share', 'PUT'));
    assert.deepEqual(result, { status: 400, message: 'Request body must be a JSON object' });
  });

  it('is_publicを指定した正常なボディは従来どおり受け入れる(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x/share', {
      method: 'PUT',
      body: JSON.stringify({ is_public: true }),
    });
    const result = await runShareBodyCheck(request);
    assert.deepEqual(result, { isPublic: true });
  });

  // Coordinatorの指摘を受けて実測: share.tsは is_public の型を直接チェックするインライン
  // ロジックのため、{} では payload.is_public が undefined になり `typeof undefined !== 'boolean'`
  // で400になる。owned-pokemon-validation.tsのような専用バリデータを持たないぶん、
  // むしろ元から{}に対して脆弱ではない(実測で確認済み、追加修正は不要)。
  it('{} は readRequiredJsonBody を通過するが、is_public必須のインラインチェックが400で拒否する(実測で確認済み、追加修正は不要)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/x/share', { method: 'PUT', body: '{}' });
    const result = await runShareBodyCheck(request);
    assert.deepEqual(result, { status: 400, message: 'is_public must be a boolean' });
  });
});

describe('POST /api/events (events.ts) のボディ処理', () => {
  it('空ボディは400になる(event_type必須のため修正前から400ではあったが、メッセージが統一される)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/events', 'POST'));
    assert.equal(body.response?.status, 400);
  });

  it('正常なボディは従来どおり受け入れる(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/events', {
      method: 'POST',
      body: JSON.stringify({ event_type: 'search', payload: { query: 'ピカチュウ' } }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateEventRequestBody(body.data);
    assert.equal(validation.ok, true);
  });
});

describe('POST /api/damage-calcs (damage-calcs.ts) のボディ処理', () => {
  it('空ボディは400になる(attacker_name等必須のため修正前から400ではあったが、メッセージが統一される)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/damage-calcs', 'POST'));
    assert.equal(body.response?.status, 400);
  });

  it('正常なボディは従来どおり受け入れる(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/damage-calcs', {
      method: 'POST',
      body: JSON.stringify({
        attacker_name: 'リザードン',
        defender_name: 'カイリュー',
        move_name: 'じしん',
        attacker_build: {},
        defender_build: {},
      }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateDamageCalcRequestBody(body.data);
    assert.equal(validation.ok, true);
  });
});

describe('POST /api/search (search.ts) のボディ処理', () => {
  it('空ボディは400になる(query必須のため修正前から400ではあったが、メッセージが統一される)', async () => {
    const body = await readRequiredJsonBody<unknown>(emptyBodyRequest('http://localhost/api/search', 'POST'));
    assert.equal(body.response?.status, 400);
  });

  it('正常なボディは従来どおり受け入れる(退行がないことの確認)', async () => {
    const request = new Request('http://localhost/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'ピカチュウ' }),
    });
    const body = await readRequiredJsonBody<unknown>(request);
    assert.equal(body.response, undefined);
    const validation = validateSearchRequestBody(body.data);
    assert.equal(validation.ok, true);
  });
});
