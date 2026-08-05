import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const clientSource = await readFile(new URL('../src/lib/box-id/left-panel.ts', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../migrations/019_archetype_popular_move.sql', import.meta.url), 'utf8');

describe('型レベル技人気のsubject_key契約', () => {
  it('クライアントは型規制別→型横断→種族規制別→種族横断の順で候補を作る', () => {
    const functionSource = clientSource.match(/export function popularMoveSubjectKeys[\s\S]*?\n\}/)?.[0] ?? '';
    const positions = [
      'popular_move_archetype\", subjectKey: `${base}|${regulation}`',
      'popular_move_archetype\", subjectKey: base',
      'popular_move\", subjectKey: `${speciesName}|${regulation}`',
      'popular_move\", subjectKey: speciesName',
    ].map((fragment) => functionSource.indexOf(fragment));
    assert.ok(positions.every((position) => position >= 0), '4段の候補がすべて実装されている');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, '要件どおりの優先順である');
  });

  it('型キーは種族名|持ち物名|role|任意の規制でDBとクライアントが一致する', () => {
    assert.match(clientSource, /const base = `\$\{archetype\.speciesName\}\|\$\{archetype\.itemName\}\|\$\{archetype\.role\}`/);
    assert.match(migrationSource, /species_name \|\| '\|' \|\| item_name \|\| '\|' \|\| role/);
    assert.match(migrationSource, /CASE WHEN scope = '' THEN '' ELSE '\|' \|\| scope END/);
  });

  it('k未満の型キーを出さず、技はmove_top_n件までに制限する', () => {
    assert.match(migrationSource, /WHERE ss\.sample_size >= min_sample_size/);
    assert.match(migrationSource, /WHERE rn <= move_top_n/);
  });
});
