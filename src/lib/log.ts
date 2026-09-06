// サーバー側のデータアクセス層(owned-pokemon.ts / team.ts / opponent-notes.ts など)が
// 共通で使うエラーログ。以前は各ファイルが prefix だけ違う同じ logError を個別に持っていた。
//
// Supabaseのクエリ失敗は「呼び出し元へは ok:false を返しつつ、原因はサーバーログに残す」
// という扱いに揃えているため、投げ直さずここで console.error するだけにしている。
export type LogError = (context: string, error: unknown) => void;

/** `[prefix] context:` の形でエラーを出すロガーを作る。prefixは呼び出し元のモジュール名。 */
export function createLogError(prefix: string): LogError {
	return (context, error) => {
		// eslint-disable-next-line no-console
		console.error(`[${prefix}] ${context}:`, error);
	};
}
