export type SseEvent = { event: string; data: string };

function parseSseEvent(raw: string): SseEvent {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // blank/comment (keepalive) line
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join("\n") };
}

// Minimal Server-Sent Events reader for a fetch() response body — the
// browser's native EventSource can't be used here since it only supports
// GET requests, not POST with a multipart form body (see
// app/api/transcribe-and-summarize/route.ts, the one producer of this shape).
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (rawEvent.trim()) yield parseSseEvent(rawEvent);
    }
  }
}
