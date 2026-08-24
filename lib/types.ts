// In-memory only — never persisted to IndexedDB. Represents audio that is
// either freshly captured (recording/upload) or re-attached by the user from
// their device for the current viewing session.
export type SessionAudio = {
  kind: "upload" | "recording";
  name: string;
  sizeLabel: string;
  mimeType: string;
  durationMs: number;
  blob: Blob;
};

export type Bookmark = {
  id: string;
  label: string;
  atMs: number;
};

// In-memory only — never persisted to IndexedDB. A lecture reference document
// (slides/notes) attached just before running analysis. Only its filename is
// kept afterward, same as SessionAudio's relationship to audioFileName.
export type ReferenceDocument = {
  name: string;
  sizeLabel: string;
  mimeType: string;
  blob: Blob;
};

// A single PDF reference-doc page, rendered client-side to an image.
// Persisted separately from LectureSession (its own IndexedDB store, keyed
// by sessionId) since it's meaningfully larger than the rest of a session's
// data — see lib/db.ts's slideImages store.
export type SlideImage = {
  page: number;
  dataUrl: string;
};

export type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type AiResult = {
  transcript: TranscriptSegment[];
  fullText: string;
  summary: string;
  lectureNote: string;
  checklist: ChecklistItem[];
};

// Persisted shape — pure text/number metadata only. The audio itself lives on
// the user's device (downloaded on recording, or already local for uploads);
// audioFileName is the filename to look for when re-attaching it.
export type LectureSession = {
  id: string;
  title: string;
  category: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  audioFileName: string;
  audioMimeType: string;
  bookmarks: Bookmark[];
  keywords: string[];
  referenceFileName: string;
  aiResult: AiResult | null;
};

export type LectureSessionSummary = {
  id: string;
  title: string;
  category: string;
  updatedAt: number;
  durationMs: number;
  hasAiResult: boolean;
};

export type ChecklistFeedItem = ChecklistItem & {
  sessionId: string;
  sessionTitle: string;
  category: string;
};

// In-memory only — a pending AI deep-dive suggestion awaiting review in the
// DeepDiveModal. Only merged into the persisted lectureNote text once confirmed.
export type DraftBlock = {
  id: string;
  sourceQuestion: string;
  anchorText: string;
  title: string;
  definition: string;
  deepDive: string;
  example: string;
  status: "pending" | "confirmed";
};
