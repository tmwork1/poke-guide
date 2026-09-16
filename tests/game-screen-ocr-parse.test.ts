import assert from "node:assert/strict";
import test from "node:test";
import { isSameOwnedPokemon, mergeGameScreenOcrResults, nearestName, parseGameScreenLines } from "../src/lib/game-screen-ocr-parse.ts";

const lines = [
	"カイリュー", // ニックネーム
	"カイリュー",
	"ドラゴン ひこう",
	"HP 167 1",
	"こうげき 204 32",
	"ぼうぎょ 116 1",
	"とくこう 108 0",
	"とくぼう 120 0",
	"すばやさ 132 32",
	"スケイルショット 20",
	"じしん 12",
	"かみなりパンチ 16",
	"しんそく 8",
	"特性 マルチスケイル",
];

test("ゲーム画面の行をチャンピオンズ形式でパースする", () => {
	const result = parseGameScreenLines(lines, {
		master: [{ name: "カイリュー", types: ["ドラゴン", "ひこう"] }, { name: "ミニリュウ", types: ["ドラゴン"] }],
		baseStats: [91, 134, 95, 100, 100, 80],
		learnset: ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"],
		abilities: ["せいしんりょく", "マルチスケイル"],
	});
	assert.equal(result.species, "カイリュー");
	assert.equal(result.nature, "いじっぱり");
	assert.deepEqual(result.stats.map((stat) => stat.actual), [167, 204, 116, 108, 120, 132]);
	assert.deepEqual(result.stats.map((stat) => stat.ev), [1, 32, 1, 0, 0, 32]);
	assert.deepEqual(result.stats.map((stat) => stat.verified), [true, true, true, true, true, true]);
	assert.deepEqual(result.moves, ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"]);
	assert.equal(result.ability, "マルチスケイル");
});

test("数字文脈のOCR誤読を補正する", () => {
	const result = parseGameScreenLines(["カイリュー", "ドラゴン", "HP l66 O"], {
		master: [{ name: "カイリュー", types: [] }], baseStats: [91, 134, 95, 100, 100, 80], learnset: [], abilities: [],
	});
	assert.deepEqual(result.stats[0], { key: "hp", actual: 166, ev: 0, verified: true });
});

test("実測したノイズを含むOCR行でも、読めた数値と名前を取り出す", () => {
	const result = parseGameScreenLines([
		"カイリュー", "疹 HP              167             1", "素 こうげき       代 204            32 :", "層3 ほうぎょ            116                 1",
		"《 とくこう       党 108             0", "9 こ<ほうぅ             120          多", "宇: すばやさ      132        32ま",
		"二華クタショット 20", "二議 < じしん 12", "粒逢 ひみなりバンテ 16", "米 〇 しんそ< 8", "特性 マルナスリィ",
	], {
		master: [{ name: "カイリュー", types: [] }], baseStats: [91, 134, 95, 100, 100, 80],
		learnset: ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"], abilities: ["マルチスケイル"],
	});
	assert.equal(result.species, "カイリュー");
	assert.deepEqual(result.stats.map((stat) => stat.actual), [167, 204, 116, 108, 120, 132]);
	assert.deepEqual(result.stats.map((stat) => stat.ev), [1, 32, 1, 0, null, 32]);
	assert.deepEqual(result.moves, ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"]);
	assert.equal(result.ability, "マルチスケイル");
});

test("複数閾値のマージは種族値と整合する実数値・努力値を優先する", () => {
	const data = {
		master: [{ name: "カイリュー", types: [] }],
		baseStats: [91, 134, 95, 100, 100, 80],
		learnset: ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"],
		abilities: ["マルチスケイル"],
	};
	const complete = parseGameScreenLines(lines, data);
	const inconsistent = {
		...complete,
		stats: complete.stats.map((stat) => (stat.key === "atk" ? { ...stat, actual: 203 } : stat)),
		confidence: { ...complete.confidence, species: 0.5 },
	};
	const merged = mergeGameScreenOcrResults([inconsistent, complete], data);
	assert.equal(merged.species, "カイリュー");
	assert.equal(merged.stats[1].actual, 204);
	assert.equal(merged.stats[1].ev, 32);
	assert.equal(merged.nature, "いじっぱり");
	assert.deepEqual(merged.moves, ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"]);
	assert.equal(merged.ability, "マルチスケイル");
});

test("短い候補が部分一致で勝っても、行に文字が余っていれば長い候補(かみなりパンチ)を採る", () => {
	const candidates = ["かみなり", "かみなりパンチ", "じしん"];
	assert.equal(nearestName("「移1 かみなりバンチ 16", candidates), "かみなりパンチ");
	// 本当に短い名前の行は長い候補へ伸びない
	assert.equal(nearestName("かみなり 10", candidates), "かみなり");
});

test("登録済み判定は種族・性格・努力値・わざ(順不同)の一致で同一とみなし、特性は読めたときだけ比べる", () => {
	const result = {
		species: "カイリュー",
		nature: "いじっぱり",
		stats: [1, 32, 1, 0, 0, 32].map((ev, i) => ({ key: ["hp", "atk", "def", "spa", "spd", "spe"][i] as never, actual: null, ev, verified: true })),
		moves: ["スケイルショット", "じしん", "かみなりパンチ", "しんそく"],
		ability: null,
		confidence: { species: 1, stats: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, moves: [1, 1, 1, 1], ability: 0 },
	};
	const owned = {
		species_name: "カイリュー",
		nature: "いじっぱり",
		ability_name: "マルチスケイル",
		evs: [1, 32, 1, 0, 0, 32],
		move_names: ["しんそく", "じしん", "スケイルショット", "かみなりパンチ"],
	};
	assert.equal(isSameOwnedPokemon(result, owned), true);
	assert.equal(isSameOwnedPokemon({ ...result, ability: "せいしんりょく" }, owned), false);
	assert.equal(isSameOwnedPokemon({ ...result, nature: "ようき" }, owned), false);
	assert.equal(isSameOwnedPokemon(result, { ...owned, evs: [1, 32, 1, 0, 1, 31] }), false);
	assert.equal(isSameOwnedPokemon({ ...result, moves: ["スケイルショット", "じしん", "かみなりパンチ", null] }, owned), false);
	assert.equal(isSameOwnedPokemon(result, { ...owned, move_names: ["しんそく", "じしん", "スケイルショット", "りゅうのまい"] }), false);
});
