import type { UnifiedSearchKind, UnifiedSearchResult } from "shared/types";
import { client } from "../db";
import { searchMessages } from "./messageService";

const PER_KIND = 8;
export async function unifiedSearch(userId: string, input: string): Promise<UnifiedSearchResult[]> {
  const query = input.trim();
  if (!query) return [];
  if (query.length > 200) throw new RangeError("search_query_limit");
  const read = async (kind: UnifiedSearchKind, sql: string) => {
    const result = await client.execute({ sql, args: [userId, query, PER_KIND] });
    return result.rows.map(
      (row): UnifiedSearchResult => ({
        kind,
        id: String(row.id),
        title: String(row.title ?? ""),
        snippet: String(row.snippet ?? "").slice(0, 240),
        ...(kind === "message" ? { conversationId: String(row.conversation_id) } : {}),
      }),
    );
  };
  const messageFallback = () =>
    read(
      "message",
      `SELECT m.id, c.id AS conversation_id, c.title, substr(m.content, max(1, instr(lower(m.content), lower(?2))-50), 220) AS snippet
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.user_id=?1 AND instr(lower(m.content), lower(?2))>0 ORDER BY m.created_at DESC, m.id LIMIT ?3`,
    );
  const messageResults = async () => {
    if (query.length < 3) return messageFallback();
    try {
      const results = await searchMessages(userId, query, PER_KIND);
      if (results.length) {
        const indexed = results.map(
          (row): UnifiedSearchResult => ({
            kind: "message",
            id: row.messageId,
            conversationId: row.conversationId,
            title: row.conversationTitle,
            snippet: row.snippet,
          }),
        );
        if (indexed.length >= PER_KIND) return indexed;
        const ids = new Set(indexed.map((row) => row.id));
        return [...indexed, ...(await messageFallback()).filter((row) => !ids.has(row.id))].slice(
          0,
          PER_KIND,
        );
      }
    } catch {
      /* Older installations may not have an available FTS index. */
    }
    return messageFallback();
  };
  const groups = await Promise.all([
    read(
      "conversation",
      `SELECT id, title, '' AS snippet FROM conversations WHERE user_id=?1 AND instr(lower(title),lower(?2))>0 ORDER BY updated_at DESC, id LIMIT ?3`,
    ),
    messageResults(),
    read(
      "artifact",
      `SELECT a.id,a.title,substr(v.content,max(1,instr(lower(v.content),lower(?2))-50),220) AS snippet FROM saved_artifacts a JOIN saved_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.user_id=?1 AND (instr(lower(a.title),lower(?2))>0 OR instr(lower(v.content),lower(?2))>0) ORDER BY a.updated_at DESC,a.id LIMIT ?3`,
    ),
    read(
      "recipe",
      `SELECT id,json_extract(spec,'$.title') AS title,substr(json_extract(spec,'$.promptTemplate'),1,220) AS snippet FROM task_recipes WHERE user_id=?1 AND json_valid(spec) AND (instr(lower(json_extract(spec,'$.title')),lower(?2))>0 OR instr(lower(json_extract(spec,'$.description')),lower(?2))>0 OR instr(lower(json_extract(spec,'$.promptTemplate')),lower(?2))>0) ORDER BY updated_at DESC,id LIMIT ?3`,
    ),
    read(
      "project",
      `SELECT id,name AS title,'' AS snippet FROM projects WHERE user_id=?1 AND instr(lower(name),lower(?2))>0 ORDER BY updated_at DESC,id LIMIT ?3`,
    ),
    read(
      "reviews",
      `SELECT id,title,'' AS snippet FROM review_workspaces WHERE user_id=?1 AND instr(lower(title),lower(?2))>0 ORDER BY updated_at DESC,id LIMIT ?3`,
    ),
  ]);
  return groups.flat();
}
