// docs/ranker/derived/ranked-teams.json を ranked_teams / ranked_team_members
// (migrations/010_ranked_teams.sql) に投入する。
//
// 静的ファイルを唯一の入力とし、DBの中身は常にそこから再現できる状態に保つ
// (元の docs/ranker/*.json と *.html からこのファイルを作り直す手順は
//  scripts/ranker/build-ranked-teams.mjs 側ではなく docs/ranker/derived/README.md に書いてある)。
//
// 冪等: (season, rule, rank) で upsert し、メンバーはチーム単位で全DELETE→全INSERT。
// 1041チーム×6体=6252行と小さいため、全体を1トランザクションで流す。
import fs from 'fs/promises';
import path from 'path';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

const dataPath = process.argv[2] ?? path.join(process.cwd(), 'docs/ranker/derived/ranked-teams.json');

async function main() {
  const doc = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  const teams = doc.teams;
  console.log(`loaded ${teams.length} teams from ${path.relative(process.cwd(), dataPath)}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    let memberCount = 0;
    for (const t of teams) {
      const { rows } = await client.query(
        `INSERT INTO ranked_teams
           (season, season_number, rule, rank, rating, trainer_name,
            article_url, article_title, article_host, source_updated_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (season, rule, rank) DO UPDATE SET
           season_number = EXCLUDED.season_number,
           rating = EXCLUDED.rating,
           trainer_name = EXCLUDED.trainer_name,
           article_url = EXCLUDED.article_url,
           article_title = EXCLUDED.article_title,
           article_host = EXCLUDED.article_host,
           source_updated_at = EXCLUDED.source_updated_at,
           updated_at = now()
         RETURNING id`,
        [t.season, t.season_number, t.rule, t.rank, t.rating, t.trainer_name,
          t.article_url, t.article_title, t.article_host, t.source_updated_at]
      );
      const teamId = rows[0].id;

      // upsert 時に前回のメンバーが残らないよう、チーム単位で入れ替える
      await client.query('DELETE FROM ranked_team_members WHERE ranked_team_id = $1', [teamId]);
      for (const m of t.members) {
        await client.query(
          `INSERT INTO ranked_team_members
             (ranked_team_id, slot, dex_no, form_no, species_name, form_name,
              type1, type2, category, item_name, tera_type, nature, ability,
              move_names, evs, extraction_source, extraction_confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [teamId, m.slot, m.dex_no, m.form_no, m.species_name, m.form_name,
            m.type1, m.type2, m.category, m.item_name, m.tera_type, m.nature, m.ability,
            m.move_names, m.evs, m.extraction_source, m.extraction_confidence]
        );
        memberCount++;
      }
    }
    await client.query('COMMIT');
    console.log(`seeded ${teams.length} teams / ${memberCount} members`);

    const stats = await client.query(`
      SELECT
        (SELECT count(*) FROM ranked_teams) AS teams,
        (SELECT count(*) FROM ranked_teams WHERE article_url IS NOT NULL) AS teams_with_article,
        (SELECT count(*) FROM ranked_team_members) AS members,
        (SELECT count(*) FROM ranked_team_members WHERE move_names IS NOT NULL) AS members_with_moves,
        (SELECT count(*) FROM ranked_team_members WHERE evs IS NOT NULL) AS members_with_evs
    `);
    console.table(stats.rows);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
