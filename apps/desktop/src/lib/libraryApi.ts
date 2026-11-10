import type {
  LibraryDocument,
  LibraryDocumentDetail,
  LibraryFilter,
  LibraryQuestion,
  LibraryScope,
  LibrarySearchResult,
  PreparedLibraryQuestion,
  PrepareLibraryQuestionInput,
} from "shared/types";
import { getDesktopBackendBase } from "./backendBase";
import { getLibraryLabel as label } from "./i18n/agent";
import { fetchWithBackendStatus } from "./serverApi";
export class LibraryApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const multipart = data instanceof FormData;
  const response = await fetchWithBackendStatus(`${getDesktopBackendBase()}/library${path}`, {
    method,
    credentials: "include",
    ...(data === undefined
      ? {}
      : multipart
        ? { body: data }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new LibraryApiError(body.errorCode ?? "library_unavailable");
  return body as T;
}
const scopeQuery = (scope: LibraryFilter) =>
  new URLSearchParams({
    scope: scope.kind,
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
  }).toString();
const id = encodeURIComponent;
export const libraryApi = {
  list: (scope: LibraryFilter) =>
    request<{ documents: LibraryDocument[] }>(`?${scopeQuery(scope)}`),
  get: (documentId: string) => request<{ document: LibraryDocumentDetail }>(`/${id(documentId)}`),
  upload: (scope: LibraryScope, file: File) => {
    const form = new FormData();
    form.set("scope", JSON.stringify(scope));
    form.set("file", file);
    return request<{ document: LibraryDocument; reused: boolean }>("", "POST", form);
  },
  index: (documentId: string) =>
    request<{ document: LibraryDocument }>(`/${id(documentId)}/index`, "POST"),
  delete: (documentId: string, expectedRevision: number) =>
    request<{ success: boolean }>(`/${id(documentId)}`, "DELETE", { expectedRevision }),
  search: (scope: LibraryFilter, query: string) =>
    request<{ results: LibrarySearchResult[] }>(
      `/search?${scopeQuery(scope)}&q=${encodeURIComponent(query)}`,
    ),
  questions: () => request<{ questions: LibraryQuestion[] }>("/questions"),
  question: (questionId: string) =>
    request<PreparedLibraryQuestion>(`/questions/${id(questionId)}`),
  deleteQuestion: (questionId: string) =>
    request<{ success: boolean }>(`/questions/${id(questionId)}`, "DELETE"),
  prepare: (input: PrepareLibraryQuestionInput) =>
    request<PreparedLibraryQuestion>("/questions", "POST", input),
  original: async (documentId: string): Promise<Blob> => {
    const response = await fetchWithBackendStatus(
      `${getDesktopBackendBase()}/library/${id(documentId)}/original`,
      { credentials: "include" },
    );
    if (!response.ok)
      throw new LibraryApiError(
        (await response.json().catch(() => ({}))).errorCode ?? "library_unavailable",
      );
    return response.blob();
  },
};
export function libraryError(error: unknown): string {
  const code = error instanceof LibraryApiError ? error.code : "library_unavailable";
  switch (code) {
    case "library_invalid_scope":
      return label("library.errors.scope");
    case "library_file_limit":
      return label("library.errors.fileLimit");
    case "library_storage_limit":
      return label("library.errors.storageLimit");
    case "library_question_limit":
      return label("library.errors.questionLimit");
    case "library_unsupported_file":
    case "library_invalid_file":
      return label("library.errors.file");
    case "library_invalid_text":
      return label("library.errors.encoding");
    case "library_empty_text":
      return label("library.errors.empty");
    case "library_text_limit":
      return label("library.errors.textLimit");
    case "library_pdf_limit":
      return label("library.errors.pdfLimit");
    case "library_parse_failed":
      return label("library.errors.parse");
    case "library_no_sources":
      return label("library.errors.sources");
    case "library_channel_unavailable":
      return label("library.errors.channel");
    case "library_index_busy":
      return label("library.errors.busy");
    case "library_request_conflict":
    case "library_conflict":
      return label("library.errors.conflict");
    case "library_not_found":
      return label("library.errors.notFound");
    case "library_invalid_question":
    case "library_invalid_data":
      return label("library.errors.input");
    default:
      return label("library.errors.unavailable");
  }
}
