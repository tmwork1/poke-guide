import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveActiveTabIndex } from '../src/lib/data-hub-tabs.ts';

describe('resolveActiveTabIndex', () => {
	it('scrollLeft が0pxのとき先頭タブを返す', () => {
		assert.equal(resolveActiveTabIndex(0, 320, 2), 0);
	});

	it('ちょうど1パネル分の位置では2つ目のタブを返す', () => {
		assert.equal(resolveActiveTabIndex(320, 320, 2), 1);
	});

	it('負の scrollLeft は先頭タブへクランプする', () => {
		assert.equal(resolveActiveTabIndex(-80, 320, 2), 0);
	});

	it('panelWidth が0以下なら先頭タブを返す', () => {
		assert.equal(resolveActiveTabIndex(120, 0, 2), 0);
	});

	it('範囲を超えた位置は最後のタブへクランプする', () => {
		assert.equal(resolveActiveTabIndex(1280, 320, 2), 1);
	});
});
