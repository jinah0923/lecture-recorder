// Matches a Notion page/database ID either as a canonical hyphenated UUID
// (8-4-4-4-12) or as the bare 32-char hex form Notion uses in page-URL slugs.
const NOTION_ID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}";

function normalizeNotionId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Extracts a Notion page/database ID from whatever the user pastes: a plain
 * ID, a normal page URL (".../Page-Title-<id>" or ".../<id>"), or a
 * center-peek/popup URL ("...?p=<id>&...").
 */
export function extractNotionId(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    const peekId = url.searchParams.get("p");
    if (peekId) {
      const match = peekId.match(new RegExp(NOTION_ID_PATTERN));
      if (match) return normalizeNotionId(match[0]);
    }
  } catch {
    // Not a parseable absolute URL — fall through to a plain text scan,
    // which also covers a bare ID or a relative "...?p=<id>" fragment.
  }

  const matches = input.match(new RegExp(NOTION_ID_PATTERN, "g"));
  if (!matches || matches.length === 0) return null;
  // Page URLs place the ID at the end of the slug; the last match in the
  // string is the one that actually identifies the target page.
  return normalizeNotionId(matches[matches.length - 1]);
}
