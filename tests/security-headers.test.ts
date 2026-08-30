import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applySecurityHeaders, SECURITY_HEADERS } from '../src/lib/security-headers.ts';

describe('SECURITY_HEADERS', () => {
	it('CSPがクリックジャッキングとプラグインコンテンツを禁止する', () => {
		const contentSecurityPolicy = SECURITY_HEADERS['Content-Security-Policy'];

		assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
		assert.match(contentSecurityPolicy, /object-src 'none'/);
	});

	it('CSPがPyodideの読込元をscript-srcとconnect-srcの両方で許可する', () => {
		const contentSecurityPolicy = SECURITY_HEADERS['Content-Security-Policy'];

		assert.match(contentSecurityPolicy, /script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
		assert.match(contentSecurityPolicy, /connect-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
	});
});

describe('applySecurityHeaders', () => {
	it('既存値を統一した4つのセキュリティヘッダで上書きする', () => {
		const response = new Response('ok', {
			headers: { 'X-Frame-Options': 'SAMEORIGIN' },
		});

		const updatedResponse = applySecurityHeaders(response);

		assert.equal(updatedResponse, response);
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			assert.equal(updatedResponse.headers.get(name), value);
		}
	});

	for (const pathname of ['/speed-chart', '/data/speed-chart']) {
		it(`${pathname} は自オリジンのiframe埋め込み(すばやさ調整モーダル)を許可する`, () => {
			const response = applySecurityHeaders(new Response('ok'), pathname);

			assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
			assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'self'/);
		});
	}

	it('対象外のパスは引き続きフレーム化を全面禁止する', () => {
		const response = applySecurityHeaders(new Response('ok'), '/box/123');

		assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
		assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
	});
});
