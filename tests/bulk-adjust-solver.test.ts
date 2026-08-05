// 耐久調整ソルバーの高速探索が、契約を直接表す総当たり探索と一致することを担保する。
// ブラウザ専用のPyodideを使わず、単調な偽エンジンを注入することでAPI境界・枝刈り・中断もNode単体で検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  solveDurability,
  type DurabilityRequirement,
  type SolverEngine,
  type SolveOptions,
} from '../src/lib/box-id/bulk-adjust-solver.ts';
import { NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from '../src/lib/stats.ts';
import type {
  CalcLethalSequenceResult,
  PokemonSpec,
  SequenceAttack,
} from '../src/lib/pyodide-engine.ts';

const BASE = [80, 80, 80, 80, 80, 80];
const NATURES = Object.keys(NATURE_STAT_MODIFIERS);
type Kind = 'physical' | 'special' | 'fixed';
type ModelAttack = SequenceAttack & { kind: Kind; power: number; spread?: number };

function attack(kind: Kind, power: number, spread = 0): ModelAttack {
  return { moveName: `${kind}:${power}:${spread}`, kind, power, spread };
}

function stats(spec: PokemonSpec) {
  const evs = spec.evs!;
  const mod = NATURE_STAT_MODIFIERS[spec.nature!]!;
  return {
    hp: calcHpStat(50, BASE[0], 31, evs[0]),
    def: calcOtherStat(50, BASE[2], 31, evs[2], mod.up === 'def' ? 1.1 : mod.down === 'def' ? 0.9 : 1),
    spd: calcOtherStat(50, BASE[4], 31, evs[4], mod.up === 'spd' ? 1.1 : mod.down === 'spd' ? 0.9 : 1),
  };
}

function damageRolls(a: ModelAttack, s: ReturnType<typeof stats>): number[] {
  if (a.kind === 'fixed') return [a.power];
  const defense = a.kind === 'physical' ? s.def : s.spd;
  return Array.from({ length: a.spread ? 16 : 1 }, (_, i) => Math.max(1, Math.floor((a.power + i * (a.spread ?? 0)) / defense)));
}

function model(spec: PokemonSpec, attacks: ModelAttack[]): CalcLethalSequenceResult {
  const s = stats(spec);
  const rolls = attacks.map((a) => damageRolls(a, s));
  let totals = [0];
  const lethal = attacks.map((_, index) => {
    totals = totals.flatMap((total) => rolls[index].map((roll) => total + roll));
    return { attackCount: index + 1, probability: totals.filter((total) => total >= s.hp).length / totals.length };
  });
  return {
    lethal,
    cumulativeDamage: { min: Math.min(...totals), max: Math.max(...totals) },
    perAttackDamages: rolls,
    perAttackLethal: attacks.map(() => []),
  };
}

class FakeEngine implements SolverEngine {
  calls = 0;
  private readonly onCall?: (count: number) => void;
  constructor(onCall?: (count: number) => void) { this.onCall = onCall; }
  async calcLethalSequence(_attacker: PokemonSpec, defender: PokemonSpec, attacks: SequenceAttack[]) {
    this.calls++;
    this.onCall?.(this.calls);
    return model(defender, attacks as ModelAttack[]);
  }
  isEngineFatal() { return false; }
  async resetEngine() {}
}

function requirement(rowId: string, attacks: ModelAttack[], n = attacks.length, m = 100): DurabilityRequirement {
  return { rowId, attackerSpec: { name: 'fake-attacker' }, attacks, n, m };
}

function options(engine: SolverEngine, extra: Partial<SolveOptions> = {}): SolveOptions {
  return {
    engine,
    baseStats: BASE,
    fixedEvs: { atk: 0, spa: 0, spe: 0 },
    buildDefenderSpec: (nature, evs) => ({ name: 'fake-defender', nature, evs }),
    maxCandidates: 2000,
    ...extra,
  };
}

function passes(req: DurabilityRequirement, nature: string, hp: number, def: number, spd: number): boolean {
  const spec = { name: 'fake-defender', nature, evs: [hp, 0, def, 0, spd, 0] };
  const attacks = Array.from({ length: req.n }, (_, i) => req.attacks[i % req.attacks.length]) as ModelAttack[];
  const probability = model(spec, attacks).lethal[req.n - 1].probability;
  return 1 - probability >= req.m / 100 - 1e-9;
}

function reference(requirements: DurabilityRequirement[]) {
  const mixed = requirements.some((r) => {
    const kinds = new Set((r.attacks as ModelAttack[]).map((a) => a.kind));
    return kinds.has('physical') && kinds.has('special');
  });
  const result: { nature: string; evs: { hp: number; def: number; spd: number } }[] = [];
  for (const nature of NATURES) {
    for (let hp = 0; hp <= 32; hp++) {
      if (mixed) {
        let found = false;
        for (let def = 0; def <= 32 && !found; def++) for (let spd = 0; spd <= 32; spd++) {
          if (requirements.every((r) => passes(r, nature, hp, def, spd))) {
            result.push({ nature, evs: { hp, def, spd } }); found = true; break;
          }
        }
      } else {
        const bReqs = requirements.filter((r) => (r.attacks as ModelAttack[]).some((a) => a.kind === 'physical'));
        const dReqs = requirements.filter((r) => (r.attacks as ModelAttack[]).some((a) => a.kind === 'special'));
        const fixedReqs = requirements.filter((r) => (r.attacks as ModelAttack[]).every((a) => a.kind === 'fixed'));
        if (!fixedReqs.every((r) => passes(r, nature, hp, 0, 0))) continue;
        const def = bReqs.length ? Array.from({ length: 33 }, (_, i) => i).find((v) => bReqs.every((r) => passes(r, nature, hp, v, 0))) : 0;
        const spd = dReqs.length ? Array.from({ length: 33 }, (_, i) => i).find((v) => dReqs.every((r) => passes(r, nature, hp, 0, v))) : 0;
        if (def !== undefined && spd !== undefined) result.push({ nature, evs: { hp, def, spd } });
      }
    }
  }
  return result.sort((a, b) => (a.evs.hp + a.evs.def + a.evs.spd) - (b.evs.hp + b.evs.def + b.evs.spd));
}

function compact(candidates: Awaited<ReturnType<typeof solveDurability>>['candidates']) {
  return candidates.map(({ nature, evs }) => ({ nature, evs }));
}

function canonical(candidates: { nature: string; evs: { hp: number; def: number; spd: number } }[]) {
  return candidates.map((c) => `${c.nature}|${c.evs.hp}|${c.evs.def}|${c.evs.spd}`).toSorted();
}

async function agrees(name: string, requirements: DurabilityRequirement[], limit: number, boundaryStat: 'def' | 'spd') {
  const engine = new FakeEngine();
  const result = await solveDurability(requirements, options(engine));
  assert.ok(result.candidates.length > 0, `${name}: candidates must not be empty`);
  assert.ok(result.candidates.some((candidate) => candidate.evs[boundaryStat] === 0), `${name}: expected an ${boundaryStat}=0 candidate`);
  assert.ok(result.candidates.some((candidate) => candidate.evs[boundaryStat] !== 0), `${name}: expected an ${boundaryStat}>0 candidate`);
  // 同一searchedEvTotal内の順序は契約外なので、候補集合として正規化して比較する。
  assert.deepEqual(canonical(compact(result.candidates)), canonical(reference(requirements)), name);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.map((c) => c.searchedEvTotal), result.candidates.map((c) => c.searchedEvTotal).toSorted((a, b) => a - b));
  assert.ok(result.engineCallCount < limit, `${name}: ${result.engineCallCount} calls`);
  assert.equal(result.engineCallCount, engine.calls);
  return result.engineCallCount;
}

describe('solveDurability: 総当たりとの一致', () => {
  it('物理カードだけ(B依存)', async () => { await agrees('physical', [requirement('p', [attack('physical', 17000)])], 300, 'def'); });
  it('特殊カードだけ(D依存)', async () => { await agrees('special', [requirement('s', [attack('special', 17000)])], 300, 'spd'); });
  it('物理+特殊の独立な高速経路は全探索より十分少ない', async () => {
    // 全探索なら25×33×33×33点だが、統合実数値グリッドと二分探索により300回未満になる。
    await agrees('independent', [requirement('p', [attack('physical', 17000)]), requirement('s', [attack('special', 16500)])], 300, 'def');
  });
  it('物理技と特殊技が同じカードにあるフォールバック経路', async () => {
    // 旧探索は約7×33×66≒15,000回のため、支配メモ込みで2,000回未満を要求する。
    await agrees('mixed', [requirement('mix', [attack('physical', 8500), attack('special', 8000)])], 2000, 'spd');
  });
  it('フォールバック経路でB努力値の上界がHP段ごとに下がる', async () => {
    // 上の'mixed'は全HP段で最小B努力値が0になるため、フォールバック経路の
    // 「evBUpperをHP段ごとに単調に下げる」ロジックが実質未検証だった。
    // このモデルでは 実数値HP = 155 + evH、B/D実数値 = (100 + ev) × 性格補正 なので、
    // 物理13000・特殊6000・n=2・m=100 だと生存条件は
    //   floor(13000/B) + floor(6000/D) < 155 + evH
    // となる。D努力値を上限(32→D=132)まで積んでも floor(6000/132)=45 残るため、
    // 補正なし性格では evH=0 で B>=119(=evB 19)が必要、evH=32 では B=100(=evB 0)で足りる。
    // → def=0 の候補と def>0 の候補が同居し、evBUpper の降下が実際に走る。
    await agrees('mixed-b-descends', [requirement('mix2', [attack('physical', 13000), attack('special', 6000)])], 2000, 'def');
  });
  it('B/Dに依存しない固定ダメージカードを含む', async () => {
    await agrees('fixed', [requirement('fixed', [attack('fixed', 160)]), requirement('p', [attack('physical', 15000)])], 300, 'def');
  });
  it('解が存在しない場合はinfeasible', async () => {
    const reqs = [requirement('impossible', [attack('fixed', 999)])];
    const engine = new FakeEngine();
    const result = await solveDurability(reqs, options(engine));
    assert.deepEqual(compact(result.candidates), reference(reqs));
    assert.equal(result.infeasible, true);
  });
  it('m<100では16段階の中間致死率が境界に効く', async () => {
    await agrees('probability', [requirement('random', [attack('physical', 15000, 120)], 1, 50)], 300, 'def');
  });
});

describe('solveDurability: 実行制御とメモ', () => {
  it('AbortSignalで途中中断するとAbortErrorをthrowする', async () => {
    const controller = new AbortController();
    const engine = new FakeEngine((count) => { if (count === 4) controller.abort(); });
    await assert.rejects(solveDurability([requirement('p', [attack('physical', 17000)])], options(engine, { signal: controller.signal })),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  });
  it('支配メモは呼び出し間で漏れず同じ引数なら同じ結果になる', async () => {
    const reqs = [requirement('mix', [attack('physical', 8500), attack('special', 8000)])];
    const first = await solveDurability(reqs, options(new FakeEngine()));
    const second = await solveDurability(reqs, options(new FakeEngine()));
    assert.deepEqual(second, first);
  });
});
