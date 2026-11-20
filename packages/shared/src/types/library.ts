export type LibraryScope = { kind: "personal" } | { kind: "project"; projectId: string };
export type LibraryFilter = LibraryScope | { kind: "all" };
export type LibraryStatus = "pending" | "indexing" | "ready" | "failed";
export interface LibraryFolder {
  id: string;
  projectId: string | null;
  name: string;
  revision: number;
}
export interface LibraryListOptions {
  favoriteOnly?: boolean;
  tag?: string;
  folderId?: string | null;
}
export interface LibraryDocument {
  id: string;
  projectId: string | null;
  folderId: string | null;
  fileName: string;
  displayName: string;
  tags: string[];
  isFavorite: boolean;
  versionGroupId: string;
  version: number;
  isCurrent: boolean;
  previousVersionId: string | null;
  fileType: string;
  fileSize: number;
  status: LibraryStatus;
  errorCode: string | null;
  chunkCount: number;
  revision: number;
  canIndex: boolean;
  /** Explicit cloud operation only; never inferred as permission during upload/index. */
  canOcr?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface LibraryDocumentDetail extends LibraryDocument {
  text: string;
}
export interface LibraryStats {
  documents: number;
  documentLimit: number;
  bytes: number;
  byteLimit: number;
}
export type LibraryDocumentMetadata = Pick<LibraryDocument, "displayName" | "tags" | "isFavorite">;
export type UpdateLibraryDocumentMetadataInput = Partial<LibraryDocumentMetadata> & {
  expectedRevision: number;
  folderId?: string | null;
};
export interface MoveLibraryDocumentsInput {
  scope: LibraryScope;
  folderId: string | null;
  documents: Array<{ documentId: string; expectedRevision: number }>;
}
export interface LibrarySource {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  text: string;
  heading?: string;
  location?: LibrarySourceLocation;
}
export interface LibrarySourceLocation {
  pageStart?: number;
  pageEnd?: number;
  startOffset?: number;
  endOffset?: number;
  lineStart?: number;
  lineEnd?: number;
}
export interface LibrarySearchResult extends LibrarySource {
  score: number;
  matchCount?: number;
  matchIndex?: number;
  revision?: number;
  snippet?: string;
}
export interface LibrarySearchMatchRequest {
  documentId: string;
  index: number;
  revision: number;
}
export interface LibraryQuestionSourceRef {
  documentId: string;
  chunkIndex: number;
  revision: number;
}
export interface PrepareLibraryQuestionInput {
  requestId: string;
  scope: LibraryScope;
  source?: LibraryQuestionSourceRef;
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
