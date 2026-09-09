// ビルド時とブラウザで同じ配置先を求めるため、種族名のUTF-16コードユニットをFNV-1aでハッシュする。
export const LEARNSET_SHARD_COUNT = 64;

export function learnsetShardIndex(speciesName) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < speciesName.length; index += 1) {
    hash ^= speciesName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % LEARNSET_SHARD_COUNT;
}

export function learnsetShardFilename(speciesName) {
  return String(learnsetShardIndex(speciesName)).padStart(2, '0');
}
