// src/pages/api/_shared.ts の共通ヘルパーの回帰テスト。
// 特に「JSONが壊れている場合は400を返す」ことを検証する
// (開発プラン §3 Phase1-4: POST /api/events のリクエストバリデーション要件)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
  readRequiredJsonBody,
  MAX_REQUEST_BODY_LENGTH,
} from '../src/pages/api/_shared.ts';

describe('readJsonBody', () => {
  it('正しいJSONはパースされたデータを返す', async () => {
    const request = new Request('http://localhost/api/events', {
      method: 'POST',
      body: JSON.stringify({ event_type: 'search', payload: {} }),
    });
    const result = await readJsonBody<{ event_type: string }>(request);
    assert.deepEqual(result.data, { event_type: 'search', payload: {} });
    assert.equal(result.response, undefined);
  });

  it('壊れたJSONは400のレスポンスを返す', async () => {
    const request = new Request('http://localhost/api/events', {
      method: 'POST',
      body: '{not valid json',
    });
    const result = await readJsonBody(request);
    assert.equal(result.data, null);
    assert.ok(result.response);
    assert.equal(result.response?.status, 400);
    const body = await result.response!.json();
    assert.equal(body.error, 'Invalid JSON payload');
  });

  it('空ボディはエラーにせずnullを返す', async () => {
    const request = new Request('http://localhost/api/events', { method: 'POST', body: '' });
    const result = await readJsonBody(request);
    assert.equal(result.data, null);
    assert.equal(result.response, undefined);
  });

  it('MAX_REQUEST_BODY_LENGTHちょうどのJSONは受け入れる', async () => {
    // { payload: "aaa...a" } の形で、全体がちょうど上限文字数になるよう長さを調整する。
    const overhead = '{"payload":""}'.length;
    const value = 'a'.repeat(MAX_REQUEST_BODY_LENGTH - overhead);
    const body = JSON.stringify({ payload: value });
    assert.equal(body.length, MAX_REQUEST_BODY_LENGTH);
    const request = new Request('http://localhost/api/events', { method: 'POST', body });
    const result = await readJsonBody<{ payload: string }>(request);
    assert.equal(result.response, undefined);
    assert.equal(result.data?.payload, value);
  });

  it('MAX_REQUEST_BODY_LENGTHを超えるJSONは413相当ではなく400で拒否する', async () => {
    const value = 'a'.repeat(MAX_REQUEST_BODY_LENGTH);
    const body = JSON.stringify({ payload: value });
    const request = new Request('http://localhost/api/events', { method: 'POST', body });
    const result = await readJsonBody(request);
    assert.equal(result.data, null);
    assert.ok(result.response);
    assert.equal(result.response?.status, 400);
    const responseBody = await result.response!.json();
    assert.equal(responseBody.error, 'Request body too large');
  });
});

// readRequiredJsonBody: 空ボディが書き込み系APIの「全フィールド任意」なバリデータを素通りして
// 既存データを消してしまうバグ(owned-pokemon/[id].ts PUT で発生)の修正で追加したヘルパー。
// 空ボディを「JSONオブジェクトでないボディ」と同じ400に合流させる。
describe('readRequiredJsonBody', () => {
  it('正しいJSONはパースされたデータを返す(readJsonBodyと同じ)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon', {
      method: 'POST',
      body: JSON.stringify({ species_name: 'ピカチュウ' }),
    });
    const result = await readRequiredJsonBody<{ species_name: string }>(request);
    assert.deepEqual(result.data, { species_name: 'ピカチュウ' });
    assert.equal(result.response, undefined);
  });

  it('空ボディは400を返し、dataはnullのまま(readJsonBodyと異なりエラー無し扱いにしない)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/some-id', { method: 'PUT', body: '' });
    const result = await readRequiredJsonBody(request);
    assert.equal(result.data, null);
    assert.ok(result.response);
    assert.equal(result.response?.status, 400);
    const body = await result.response!.json();
    // 各バリデータが非オブジェクトボディに対して返すメッセージと揃える
    // (owned-pokemon-validation.ts 等の 'Request body must be a JSON object' と同じ)。
    assert.equal(body.error, 'Request body must be a JSON object');
  });

  it('空白のみのボディも400を返す(trim後に空と判定されるケース)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/some-id', { method: 'PUT', body: '   \n  ' });
    const result = await readRequiredJsonBody(request);
    assert.equal(result.data, null);
    assert.equal(result.response?.status, 400);
  });

  it('壊れたJSONは従来どおり "Invalid JSON payload" の400を返す(空ボディと区別する)', async () => {
    const request = new Request('http://localhost/api/owned-pokemon/some-id', {
      method: 'PUT',
      body: '{not valid json',
    });
    const result = await readRequiredJsonBody(request);
    assert.equal(result.data, null);
    assert.equal(result.response?.status, 400);
    const body = await result.response!.json();
    assert.equal(body.error, 'Invalid JSON payload');
  });

  it('サイズ超過は従来どおり "Request body too large" の400を返す', async () => {
    const value = 'a'.repeat(MAX_REQUEST_BODY_LENGTH);
    const body = JSON.stringify({ payload: value });
    const request = new Request('http://localhost/api/owned-pokemon/some-id', { method: 'PUT', body });
    const result = await readRequiredJsonBody(request);
    assert.equal(result.data, null);
    assert.equal(result.response?.status, 400);
    const responseBody = await result.response!.json();
    assert.equal(responseBody.error, 'Request body too large');
  });

  it('JSONの null リテラル("null"という文字列)も400にする(空ボディと同じdata:null経路)', async () => {
    // "null" は構文としては有効なJSONだが、パース結果がnullになる点は空ボディ(readJsonBodyがdata:nullを
    // 返す)と区別が付かない。readRequiredJsonBodyはこの2つを同じ扱いにする(どちらもJSONオブジェクトでは
    // ないため、後段のバリデータに通しても同じ 'Request body must be a JSON object' で拒否されるだけ)。
    const request = new Request('http://localhost/api/owned-pokemon/some-id', { method: 'PUT', body: 'null' });
    const result = await readRequiredJsonBody(request);
    assert.equal(result.data, null);
    assert.equal(result.response?.status, 400);
    const body = await result.response!.json();
    assert.equal(body.error, 'Request body must be a JSON object');
  });
});

describe('badRequest / jsonResponse / methodNotAllowed', () => {
  it('badRequestは400とエラーメッセージを返す', async () => {
    const response = badRequest('invalid');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid' });
  });

  it('jsonResponseはContent-Typeヘッダーを付与する', () => {
    const response = jsonResponse({ ok: true });
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.status, 200);
  });

  it('methodNotAllowedは405と許可メソッド一覧を返す', async () => {
    const response = methodNotAllowed(['POST']);
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: 'Method not allowed', allowed: ['POST'] });
  });
});
