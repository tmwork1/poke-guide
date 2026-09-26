// reloadOnBfcacheRestore が「離れている間にユーザーデータが書き換わった復帰」だけで
// reload を呼ぶことを検証する(headless Chromium は自動化時に bfcache が無効なので probe では測れない)。
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bumpUserDataRevision, reloadOnBfcacheRestore } from '../src/lib/shared/reload-on-bfcache-restore.ts';

type PageShowListener = (event: { persisted: boolean }) => void;

let listeners: PageShowListener[];
let storage: Map<string, string> | null;

function installWindow(): void {
  listeners = [];
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, listener: PageShowListener) => {
      if (type === 'pageshow') listeners.push(listener);
    },
    get localStorage() {
      if (!storage) throw new Error('SecurityError');
      const store = storage;
      return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      };
    },
  };
}

function pageshow(persisted: boolean): void {
  for (const listener of listeners) listener({ persisted });
}

describe('reloadOnBfcacheRestore', () => {
  beforeEach(() => {
    storage = new Map();
    installWindow();
  });

  it('データが変わっていないbfcache復帰では reload しない', () => {
    let calls = 0;
    reloadOnBfcacheRestore(() => { calls += 1; });
    pageshow(true);
    assert.equal(calls, 0);
  });

  it('離れている間に書き込みがあれば1回だけ reload する', () => {
    let calls = 0;
    reloadOnBfcacheRestore(() => { calls += 1; });
    bumpUserDataRevision();
    pageshow(true);
    pageshow(true);
    assert.equal(calls, 1);
  });

  it('通常ロード(persisted=false)では reload しない', () => {
    let calls = 0;
    reloadOnBfcacheRestore(() => { calls += 1; });
    bumpUserDataRevision();
    pageshow(false);
    assert.equal(calls, 0);
  });

  it('localStorage が使えない環境では従来どおり毎回 reload する', () => {
    storage = null;
    let calls = 0;
    reloadOnBfcacheRestore(() => { calls += 1; });
    pageshow(true);
    pageshow(true);
    assert.equal(calls, 2);
  });
});
