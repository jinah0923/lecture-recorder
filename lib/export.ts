export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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
