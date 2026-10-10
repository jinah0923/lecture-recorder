export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Puts both flavors on the clipboard: `html` for rich editors (Notion, Docs,
// Word read it and keep bold, highlights, headings, lists and tables) and
// `text` for everything else. Falls back to plain text alone where the
// browser can't write HTML (no ClipboardItem, or the write is refused).
// ClipboardItem gets Blob promises so the write starts inside the click —
// Safari rejects clipboard writes that begin after an await.
export async function copyRichToClipboard(html: string, text: string): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": Promise.resolve(new Blob([html], { type: "text/html" })),
          "text/plain": Promise.resolve(new Blob([text], { type: "text/plain" })),
        }),
      ]);
      return true;
    } catch {
      // fall through to plain text
    }
  }
  return copyToClipboard(text);
}

export function downloadTextFile(filename: string, content: string, mimeType: string) {
  downloadBlob(filename, new Blob([content], { type: mimeType }));
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function sanitizeFileNamePart(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, "").trim() || "녹음";
}

export function buildRecordingFileName(category: string, title: string, date: Date, extension = "webm") {
  const dateLabel = date.toISOString().slice(0, 10);
  const categoryPart = sanitizeFileNamePart(category);
  const titlePart = sanitizeFileNamePart(title);
  return `[${categoryPart}]${titlePart}_${dateLabel}.${extension}`;
}
