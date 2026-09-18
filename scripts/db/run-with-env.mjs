import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';

function usage() {
  console.error('Usage: node scripts/db/run-with-env.mjs <env-file> [--dry-run] <npm-script> [<npm-script> ...]');
}

function parseEnv(source) {
  const variables = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      let end = 1;
      while (end < value.length) {
        if (value[end] === quote && value[end - 1] !== '\\') break;
        end++;
      }
      if (end === value.length) throw new Error(`Unterminated quoted value for ${key}`);
      value = value.slice(1, end);
    } else {
      const commentIndex = value.indexOf('#');
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }
    variables.set(key, value);
  }
  return variables;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRunIndex = args.indexOf('--dry-run');
  const dryRun = dryRunIndex !== -1;
  if (dryRun) args.splice(dryRunIndex, 1);

  const [envFile, ...scripts] = args;
  if (!envFile || scripts.length === 0) {
    usage();
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), envFile);
  const variables = parseEnv(await fs.readFile(envPath, 'utf8'));
  const databaseUrl = variables.get('DATABASE_URL');
  if (!databaseUrl) throw new Error(`DATABASE_URL is not set in ${envFile}`);

  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`DATABASE_URL in ${envFile} is not a valid URL`);
  }
  if (!host) throw new Error(`DATABASE_URL in ${envFile} has no host name`);

  console.log(`DATABASE_URL host: ${host}`);
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl };
  // Windows では npm が .cmd で、Node 18.20+ は shell 無しの .cmd 起動を EINVAL で拒否する。
  // `npm run` 経由なら npm 自身が npm_execpath に cli.js の場所を入れてくれるので、それを
  // node で直接呼ぶ(OS差・shell 依存なし)。直接 node で起動された場合だけ shell 経由に落とす。
  const npmCli = process.env.npm_execpath;
  for (const script of scripts) {
    console.log(`Running: npm run ${script}`);
    if (dryRun) continue;
    const result = npmCli
      ? spawnSync(process.execPath, [npmCli, 'run', script], { cwd: process.cwd(), env: childEnv, stdio: 'inherit' })
      : spawnSync('npm', ['run', script], { cwd: process.cwd(), env: childEnv, stdio: 'inherit', shell: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
