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
});
