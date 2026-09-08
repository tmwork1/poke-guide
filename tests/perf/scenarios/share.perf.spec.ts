import { expect, perfScenario, test, timeNav } from "../lib/perf";

test("共有ページの読み込み", async ({ page, request }, testInfo) => {
	// 使い捨ての空個体を作り、共有をONにしてから計測し、終わったら削除する
	// (既存フィクスチャのis_publicを書き換えない: safety-rules.mdの使い捨てデータ運用に従う)。
	const createResponse = await request.post("/api/owned-pokemon", {
		headers: { Origin: "http://localhost:4321" },
		data: {},
	});
	await expect(createResponse).toBeOK();
	const createBody = (await createResponse.json()) as { data: { id: string } };
	const disposableId = createBody.data.id;

	try {
		const shareResponse = await request.put(`/api/owned-pokemon/${encodeURIComponent(disposableId)}/share`, {
			headers: { Origin: "http://localhost:4321" },
			data: { is_public: true },
		});
		await expect(shareResponse).toBeOK();
		const shareBody = (await shareResponse.json()) as { data: { share_slug: string } };
		const shareSlug = shareBody.data.share_slug;

		await perfScenario(
			testInfo,
			{
				id: "share-page-load",
				label: "共有ページを表示",
				category: "page-load",
				targetMs: 1500,
				note: "SSRのみで完結する読み取り専用ページ(自動保存なし)。計測用に使い捨て個体を作成し共有をONにして参照する。",
			},
			() => timeNav(page, `/share/${shareSlug}`, ".share-identity"),
		);
	} finally {
		const deleteResponse = await request.delete(`/api/owned-pokemon/${encodeURIComponent(disposableId)}`, {
			headers: { Origin: "http://localhost:4321" },
		});
		expect(deleteResponse.status()).toBe(200);

		const getResponse = await request.get(`/api/owned-pokemon/${encodeURIComponent(disposableId)}`);
		expect(getResponse.status()).toBe(404);
	}
});
