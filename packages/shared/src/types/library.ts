export type LibraryScope = { kind: "personal" } | { kind: "project"; projectId: string };
export type LibraryFilter = LibraryScope | { kind: "all" };
export type LibraryStatus = "pending" | "indexing" | "ready" | "failed";
export interface LibraryDocument {
  id: string;
  projectId: string | null;
  fileName: string;
  fileType: string;
  fileSize: number;
  status: LibraryStatus;
  errorCode: string | null;
  chunkCount: number;
  revision: number;
  canIndex: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface LibraryDocumentDetail extends LibraryDocument {
  text: string;
}
export interface LibrarySource {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  text: string;
  heading?: string;
}
export interface LibrarySearchResult extends LibrarySource {
  score: number;
}
export interface PrepareLibraryQuestionInput {
  requestId: string;
  scope: LibraryScope;
  question: string;
  channelId: string;
  modelId: string;
}
export interface LibraryQuestion {
  id: string;
  requestId: string;
  scope: LibraryScope;
  scopeAvailable: boolean;
  conversationId: string | null;
  channelId: string | null;
  modelId: string;
  question: string;
  sources: LibrarySource[];
  prompt: string;
  createdAt: string;
}
export interface PreparedLibraryQuestion {
  question: LibraryQuestion;
  replayable: boolean;
}

export interface LibraryImportCounts {
  imported: number;
  skipped: number;
}

/** Distinguishes an invalid archive from an interrupted import that may have committed rows. */
export type BackupImportFailure = "validation" | "interrupted";
