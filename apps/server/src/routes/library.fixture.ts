import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryDocument, LibrarySearchResult, PreparedLibraryQuestion } from "shared/types";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-library-test-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
process.env.ENCRYPTION_KEY = "synthetic-library-fixture-encryption-key";
let providerAttempts = 0;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://library-fixture.invalid" || url.pathname !== "/v1/chat/completions")
      throw new Error("External network forbidden in library fixture");
    providerAttempts++;
    return Response.json({
      id: "synthetic-summary",
      object: "chat.completion",
      created: 1,
      model: "synthetic",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "SUMMARY:\nSynthetic summary\nKEY_FACTS:\n[]" },
          finish_reason: "stop",
        },
      ],
    });
  },
  { preconnect() {} },
);
const { client, db } = await import("../db");
try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase({ backup: null });
  const { Hono } = await import("hono");
  const {
    channels,
    channelModels,
    conversations,
    libraryDocuments,
    libraryChunks,
    libraryQuestions,
    importRecords,
    messages,
    projects,
    users,
  } = await import("db");
  const { eq } = await import("drizzle-orm");
  const service = await import("../services/libraryService");
  const { libraryTestPdf } = await import("./libraryPdf.fixture");
  const { parseLibraryOriginal } = await import("../services/libraryParser");
  const { validateLibraryBackupOriginal, restoreLibraryBackup } = await import(
    "../services/libraryBackup"
  );
  const { exportBackup, estimateExportSize } = await import("../services/exportService");
  const { importOpenHornBackup, extractZipEntries } = await import("../services/importService");
  const { encrypt } = await import("../utils");
  const { maybeSummarize } = await import("../services/summaryService");
  const { setSettingValue } = await import("../services/settingsService");
  const { buildChatMessages } = await import("../services/messageService");
  const { withAppendedSystemPrompt } = await import("../services/appendSystemPrompt");
  const {
    LIBRARY_SYSTEM_PROMPT,
    LIBRARY_LIMITS,
    libraryQuestionPayload,
    packLibrarySources,
    utf8Bytes,
    libraryKeywords,
  } = await import("shared/library");
  const { isDataOnlyPrompt } = await import("shared/data-only");
  const { default: routes } = await import("./library");
  const app = new Hono().route("/library", routes);
  const userId = String((await client.execute("SELECT id FROM users LIMIT 1")).rows[0].id),
    other = "library-other",
    now = new Date();
  await db.insert(users).values({
    id: other,
    email: "library@test.invalid",
    username: "Library synthetic",
    createdAt: now,
    updatedAt: now,
  });
  for (const owner of [userId, other]) {
    await db.insert(projects).values({
      id: `project-${owner}`,
      userId: owner,
      name: "Synthetic",
      rootPath: `/synthetic/${owner}`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channels).values({
      id: `channel-${owner}`,
      userId: owner,
      name: "Synthetic",
      provider: "openai",
      protocol: "openai",
      apiKey: encrypt("synthetic-never-sent"),
      baseUrl: "https://library-fixture.invalid/v1",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channelModels).values({
      id: `model-${owner}`,
      channelId: `channel-${owner}`,
      modelId: "synthetic",
      displayName: "Synthetic",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const reject = async (work: () => Promise<unknown>, code: string) => {
    await assert.rejects(work, { code });
    checks++;
  };
  // Recreate the exact pre-versioning shape before booting an upgrade in this isolated DB.
  await client.batch(
    [
      "DROP INDEX library_documents_version_group_idx",
      "DROP INDEX library_documents_current_idx",
      ...["page_start", "page_end", "start_offset", "end_offset", "line_start", "line_end"].map(
        (column) => `ALTER TABLE library_chunks DROP COLUMN ${column}`,
      ),
      "ALTER TABLE library_documents DROP COLUMN display_name",
      "ALTER TABLE library_documents DROP COLUMN tags",
      "ALTER TABLE library_documents DROP COLUMN is_favorite",
      "ALTER TABLE library_documents DROP COLUMN version_group_id",
      "ALTER TABLE library_documents DROP COLUMN version",
      "ALTER TABLE library_documents DROP COLUMN is_current",
      "ALTER TABLE library_documents DROP COLUMN previous_version_id",
      {
        sql: `INSERT INTO library_documents
        (id,user_id,scope_key,file_name,file_type,file_size,sha256,original_base64,created_at,updated_at)
        VALUES ('legacy-library',?,'personal','legacy.txt','text/plain',6,'fixture','bGVnYWN5',12,34)`,
        args: [userId],
      },
    ],
    "write",
  );
  await bootstrapDatabase({ backup: null });
  await bootstrapDatabase({ backup: null });
  const legacy = await service.getLibraryDocument(userId, "legacy-library");
  check([legacy.tags, legacy.isFavorite], [[], false]);
  check(
    [legacy.displayName, legacy.versionGroupId, legacy.version, legacy.isCurrent],
    ["legacy.txt", "legacy-library", 1, true],
  );
  check((await service.getLibraryOriginal(userId, legacy.id)).bytes.toString(), "legacy");
  await service.deleteLibraryDocument(userId, legacy.id, legacy.revision);
  const request = (url: string, method = "GET", data?: unknown) =>
    app.request(`/library${url}`, {
      method,
      ...(data === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    });
  check((await request("?scope=all")).status, 200);
  check((await request("?scope=project&projectId=missing")).status, 404);
  const personal = { kind: "personal" } as const,
    project = { kind: "project", projectId: `project-${userId}` } as const;
  const upload = async (
    fileName: string,
    content: string,
    scope: unknown = personal,
    folderId?: string | null,
  ) => {
    const form = new FormData();
    form.set("file", new File([content], fileName));
    form.set("scope", JSON.stringify(scope));
    if (folderId !== undefined) form.set("folderId", folderId ?? "");
    const response = await app.request("/library", { method: "POST", body: form });
    return {
      status: response.status,
      body: (await response.json()) as { document: LibraryDocument; reused: boolean },
    };
  };
  const first = await upload(
    "synthetic.md",
    "# Shipping\nShipping costs 12 coins. Returns take 7 days.",
  );
  check(first.status, 201);
  check(first.body.document.status, "ready");
  check(first.body.document.chunkCount, 1);
  check(
    Number(
      (
        await client.execute({
          sql: "SELECT count(*) AS count FROM library_chunks_fts WHERE document_id = ?",
          args: [first.body.document.id],
        })
      ).rows[0]?.count,
    ),
    1,
  );
  check(
    (await upload("synthetic.md", "# Shipping\nShipping costs 12 coins. Returns take 7 days.")).body
      .document.id,
    first.body.document.id,
  );
  check(
    (await upload("synthetic.json", '{"shipping":"project only 55"}', project)).body.document
      .status,
    "ready",
  );
  const projectDoc = (await service.listLibraryDocuments(userId, project))[0];
  check((await service.listLibraryDocuments(other, personal)).length, 0);
  await reject(
    () => service.getLibraryDocument(other, first.body.document.id),
    "library_not_found",
  );
  await reject(
    () => service.uploadLibraryDocument(other, project, "x.txt", Buffer.from("x")),
    "library_invalid_scope",
  );
  check(
    (await service.searchLibrary(userId, personal, "shipping")).every(
      (r) => r.documentId === first.body.document.id,
    ),
    true,
  );
  check(
    (await service.searchLibrary(userId, project, "shipping")).every(
      (r) => r.documentId === projectDoc.id,
    ),
    true,
  );
  check((await service.searchLibrary(other, { kind: "all" }, "shipping")).length, 0);
  const largeSearch = (
    await upload(
      "large-search.md",
      Array.from({ length: 85 }, (_, n) => `## Section ${n + 1}\nCoverage needle ${n + 1}.`).join(
        "\n\n",
      ),
    )
  ).body.document;
  const widthSearch = (await upload("width-search.md", "Cｏｖｅｒａｇｅ needle.")).body.document;
  const titleSearch = (await upload("coverage.docx", "Stored original without a text index.")).body
    .document;
  const [coverageNames, coverageMatches] = await Promise.all([
    service.searchLibrary(userId, personal, "coverage"),
    service.searchLibrary(userId, personal, "coverage needle"),
  ]);
  check(coverageNames.length, 3);
  check(coverageNames.find((row) => row.documentId === titleSearch.id)?.matchCount, 0);
  check(coverageNames.find((row) => row.documentId === widthSearch.id)?.matchCount, 1);
  check(coverageMatches.find((row) => row.documentId === largeSearch.id)?.matchCount, 85);
  const targetParams = new URLSearchParams({
    q: "coverage needle",
    documentId: largeSearch.id,
    matchIndex: "84",
    revision: String(largeSearch.revision),
  });
  const coveragePage = await request(`/search?${targetParams}`);
  check(coveragePage.status, 200);
  const [lastCoverageHit] = (
    (await coveragePage.json()) as {
      results: LibrarySearchResult[];
    }
  ).results;
  check(
    [lastCoverageHit.matchIndex, lastCoverageHit.heading, lastCoverageHit.location?.lineStart],
    [84, "Section 85", 253],
  );
  check(
    (await request(`/search?scope=project&projectId=${project.projectId}&${targetParams}`)).status,
    409,
  );
  await reject(
    () =>
      service.searchLibrary(
        other,
        { kind: "all" },
        "coverage needle",
        {},
        {
          documentId: largeSearch.id,
          index: 84,
          revision: largeSearch.revision,
        },
      ),
    "library_conflict",
  );
  await client.execute("DROP TABLE library_chunks_fts");
  check(
    (await service.searchLibrary(userId, personal, "coverage")).find(
      (row) => row.documentId === largeSearch.id,
    )?.matchCount,
    85,
  );
  await bootstrapDatabase({ backup: null });
  const source = {
    documentId: lastCoverageHit.documentId,
    chunkIndex: lastCoverageHit.chunkIndex,
    revision: lastCoverageHit.revision,
  };
  const selectedInput = {
    scope: personal,
    channelId: `channel-${userId}`,
    modelId: "synthetic",
    requestId: crypto.randomUUID(),
    question: "Nonsuch interpretation?",
    // Extra client fields are ignored. The snapshot uses the stored text.
    source: { ...source, text: "Client-provided text" },
  };
  const beforeSelected = providerAttempts;
  const selectedResponse = await request("/questions", "POST", selectedInput);
  check(selectedResponse.status, 201);
  const selectedQuestion = (await selectedResponse.json()) as PreparedLibraryQuestion;
  const { documentId, chunkIndex, fileName, text, heading, location } = lastCoverageHit;
  check(selectedQuestion.question.sources, [
    { documentId, chunkIndex, fileName, text, heading, location },
  ]);
  check(JSON.parse(selectedQuestion.question.prompt).sources.length, 1);
  check(providerAttempts, beforeSelected);
  const selectedConversation = selectedQuestion.question.conversationId as string;
  const makeSourceQuery = (ref: { documentId: string; chunkIndex: number; revision?: number }) =>
    new URLSearchParams({
      documentId: ref.documentId,
      chunkIndex: String(ref.chunkIndex),
      revision: String(ref.revision),
    });
  const selectedSourcePath = `/conversations/${selectedConversation}/source?${makeSourceQuery(source)}`;
  const existingSource = await request(selectedSourcePath);
  check(existingSource.status, 200);
  check(await existingSource.json(), { source: selectedQuestion.question.sources[0] });
  await reject(
    () => service.getSourceForLibraryConversation(other, selectedConversation, source),
    "library_not_found",
  );
  const scopedSource = await request(
    `/conversations/${selectedConversation}/source?${makeSourceQuery({ documentId: projectDoc.id, chunkIndex: 0, revision: projectDoc.revision })}`,
  );
  check(scopedSource.status, 409);
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...selectedInput, source: undefined }),
    "library_request_conflict",
  );
  await reject(
    () =>
      service.prepareLibraryQuestion(userId, {
        ...selectedInput,
        source: { ...source, chunkIndex: 0 },
      }),
    "library_request_conflict",
  );
  const freshSelection = { ...selectedInput, requestId: crypto.randomUUID() };
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...freshSelection, scope: project }),
    "library_source_changed",
  );
  await reject(
    () =>
      service.prepareLibraryQuestion(other, { ...freshSelection, channelId: `channel-${other}` }),
    "library_source_changed",
  );
  await reject(
    () =>
      service.prepareLibraryQuestion(userId, {
        ...freshSelection,
        source: { ...source, chunkIndex: -1 },
      }),
    "library_invalid_question",
  );
  await service.indexLibraryDocument(userId, largeSearch.id);
  check((await request(`/search?${targetParams}`)).status, 409);
  check((await request(selectedSourcePath)).status, 409);
  await reject(
    () => service.prepareLibraryQuestion(userId, freshSelection),
    "library_source_changed",
  );
  check(await service.prepareLibraryQuestion(userId, selectedInput), selectedQuestion);
  check((await service.listLibraryQuestions(userId)).length, 1);
  await service.deleteLibraryQuestion(userId, selectedQuestion.question.id);
  await db
    .delete(conversations)
    .where(eq(conversations.id, selectedQuestion.question.conversationId as string));
  for (const record of [largeSearch, widthSearch, titleSearch]) {
    const current = await service.getLibraryDocument(userId, record.id);
    await service.deleteLibraryDocument(userId, record.id, current.revision);
  }
  const versionOne = await upload("versioned.md", "# Version one\nOriginal text.");
  const versionTwo = await upload("versioned.md", "# Version two\nUpdated text.");
  check(versionTwo.body.document.version, 2);
  check(
    (await service.listLibraryDocuments(userId, personal)).some(
      (row) => row.id === versionOne.body.document.id,
    ),
    false,
  );
  const versions = await service.listLibraryDocumentVersions(userId, versionTwo.body.document.id);
  check(
    versions.map((row) => row.version),
    [2, 1],
  );
  const restoredVersion = await service.restoreLibraryDocument(
    userId,
    versionOne.body.document.id,
    versions[1].revision,
  );
  check(restoredVersion.isCurrent, true);
  await service.deleteLibraryDocument(userId, restoredVersion.id, restoredVersion.revision);
  check(
    (await service.listLibraryDocuments(userId, personal)).some(
      (row) => row.id === versionTwo.body.document.id && row.isCurrent,
    ),
    true,
  );
  const currentVersionTwo = (
    await service.listLibraryDocumentVersions(userId, versionTwo.body.document.id)
  ).find((row) => row.isCurrent);
  if (!currentVersionTwo) throw new Error("current version missing");
  await service.deleteLibraryDocument(userId, currentVersionTwo.id, currentVersionTwo.revision);
  const metadataDoc = await upload("metadata.md", "# Metadata\nProject reference.");
  const saved = await request(`/${metadataDoc.body.document.id}`, "PATCH", {
    expectedRevision: metadataDoc.body.document.revision,
    displayName: "Saved notes",
    tags: ["work", "work", "  notes  "],
    isFavorite: true,
  });
  check(saved.status, 200);
  const { document: updated } = (await saved.json()) as { document: LibraryDocument };
  check(
    [updated.displayName, updated.tags, updated.isFavorite],
    ["Saved notes", ["work", "notes"], true],
  );
  const latest = (await upload("metadata.md", "# Metadata\nNewest reference.")).body.document;
  check(
    [latest.displayName, latest.tags, latest.isFavorite],
    [updated.displayName, updated.tags, true],
  );
  const modified = await service.updateLibraryDocumentMetadata(userId, latest.id, {
    expectedRevision: latest.revision,
    tags: ["work", "guide"],
  });
  check(
    (await service.listLibraryDocumentVersions(userId, modified.id)).map((row) => row.tags),
    [
      ["work", "guide"],
      ["work", "guide"],
    ],
  );
  check(
    (
      await service.searchLibrary(userId, personal, "Saved notes", {
        favoriteOnly: true,
        tag: "work",
      })
    ).map((row) => row.documentId),
    [modified.id],
  );
  check(
    (await service.searchLibrary(userId, project, "reference", { favoriteOnly: true })).length,
    0,
  );
  check(
    (
      await service.listLibraryDocuments(
        other,
        { kind: "all" },
        { favoriteOnly: true, tag: "work" },
      )
    ).length,
    0,
  );
  await reject(
    () =>
      service.updateLibraryDocumentMetadata(userId, modified.id, {
        expectedRevision: latest.revision,
        isFavorite: false,
      }),
    "library_conflict",
  );
  await reject(
    () =>
      service.updateLibraryDocumentMetadata(userId, modified.id, {
        expectedRevision: modified.revision,
        tags: ["x".repeat(41)],
      }),
    "library_invalid_tags",
  );
  const folder = await service.createLibraryFolder(userId, personal, "Research");
  const foldered = await upload(
    "foldered.md",
    "# Foldered\nResearch material.",
    personal,
    folder.folder.id,
  );
  check(
    (await service.getLibraryDocument(userId, foldered.body.document.id)).folderId,
    folder.folder.id,
  );
  const renamed = await service.renameLibraryFolder(
    userId,
    folder.folder.id,
    folder.folder.revision,
    "Renamed",
  );
  check(renamed.name, "Renamed");
  const moveEntry = (doc: LibraryDocument) => ({
    documentId: doc.id,
    expectedRevision: doc.revision,
  });
  const unfiled = await request("/documents/move", "POST", {
    scope: personal,
    folderId: null,
    documents: [moveEntry(foldered.body.document), moveEntry(modified)],
  });
  check(unfiled.status, 200);
  check(await unfiled.json(), { moved: 1 });
  const freshlyUnfiled = await service.getLibraryDocument(userId, foldered.body.document.id);
  check(freshlyUnfiled.folderId, null);
  check((await service.getLibraryDocument(userId, modified.id)).revision, modified.revision);
  const bulkMove = {
    scope: personal,
    folderId: renamed.id,
    documents: [moveEntry(modified), moveEntry(freshlyUnfiled)],
  };
  const staleBatch = await request("/documents/move", "POST", {
    ...bulkMove,
    documents: [moveEntry(modified), moveEntry(foldered.body.document)],
  });
  check(staleBatch.status, 409);
  check(await staleBatch.json(), { errorCode: "library_conflict" });
  const mixedScope = await request("/documents/move", "POST", {
    ...bulkMove,
    documents: [moveEntry(modified), moveEntry(projectDoc)],
  });
  check(mixedScope.status, 409);
  const projectFolder = await service.createLibraryFolder(userId, project, "Project archive");
  const wrongFolder = await request("/documents/move", "POST", {
    ...bulkMove,
    folderId: projectFolder.folder.id,
  });
  check(wrongFolder.status, 404);
  await reject(() => service.moveLibraryDocuments(other, bulkMove), "library_folder_not_found");
  await reject(
    () =>
      service.moveLibraryDocuments(userId, {
        ...bulkMove,
        documents: [moveEntry(modified), moveEntry(modified)],
      }),
    "library_invalid_data",
  );
  check((await service.getLibraryDocument(userId, modified.id)).folderId, null);
  check((await service.getLibraryDocument(userId, modified.id)).revision, modified.revision);
  const completedMove = await request("/documents/move", "POST", bulkMove);
  check(completedMove.status, 200);
  check(await completedMove.json(), { moved: 2 });
  check(
    (await service.listLibraryDocumentVersions(userId, modified.id)).map((row) => row.folderId),
    [renamed.id, renamed.id],
  );
  check((await service.getLibraryDocument(userId, freshlyUnfiled.id)).folderId, renamed.id);
  const inheritedFolder = await upload("foldered.md", "An update without a folder.");
  check(inheritedFolder.status, 201);
  check(inheritedFolder.body.document.folderId, renamed.id);
  const explicitUncategorized = await upload(
    "foldered.md",
    "An update saved in Uncategorized.",
    personal,
    null,
  );
  check(explicitUncategorized.status, 201);
  check(explicitUncategorized.body.document.folderId, null);
  check(explicitUncategorized.body.document.previousVersionId, inheritedFolder.body.document.id);
  await service.deleteLibraryFolder(userId, projectFolder.folder.id, projectFolder.folder.revision);
  await service.deleteLibraryFolder(userId, renamed.id, renamed.revision);
  check((await service.getLibraryDocument(userId, foldered.body.document.id)).folderId, null);
  const provenance = await service.uploadLibraryDocument(
    userId,
    personal,
    "provenance.pdf",
    libraryTestPdf(3, (index) => (index === 0 ? "" : "Page provenance")),
  );
  const [pageHit] = await service.searchLibrary(userId, personal, "provenance");
  check(pageHit.documentId, provenance.document.id);
  check(pageHit.location, { pageStart: 2, pageEnd: 3, startOffset: 2, endOffset: 34 });
  check((await service.searchLibrary(userId, personal, "Pa"))[0].location, pageHit.location);
  const [firstTextHit] = await service.searchLibrary(userId, personal, "shipping");
  check(firstTextHit.location?.startOffset, 0);
  check(firstTextHit.location?.lineStart, 1);
  const backupFolder = await service.createLibraryFolder(userId, personal, "Backup folder");
  await upload("backup-folder.md", "Backup folder material.", personal, backupFolder.folder.id);
  const badUpload = await upload("bad.exe", "abc");
  const emptyUpload = await upload("empty.txt", "");
  check(badUpload.status, 400);
  check(emptyUpload.status, 413);
  const binary = await service.uploadLibraryDocument(
    userId,
    personal,
    "bad.txt",
    Buffer.from([0xff, 0xfe]),
  );
  check(binary.document.status, "failed");
  check(binary.document.errorCode, "library_invalid_text");
  check(
    (await service.getLibraryOriginal(userId, binary.document.id)).bytes,
    Buffer.from([0xff, 0xfe]),
  );
  await assert.rejects(() => parseLibraryOriginal(Buffer.from("\u0000hello"), "text/plain"), {
    code: "library_invalid_text",
  });
  checks++;
  const scanUpload = await upload("scan.pdf", "not a PDF");
  check(scanUpload.body.document.status, "failed");
  const parsedPdf = await parseLibraryOriginal(libraryTestPdf(1), "application/pdf");
  check(parsedPdf.includes("Shipping costs twelve coins"), true);
  await assert.rejects(() => parseLibraryOriginal(libraryTestPdf(101), "application/pdf"), {
    code: "library_pdf_limit",
  });
  checks++;
  await assert.rejects(() => parseLibraryOriginal(libraryTestPdf(1, ""), "application/pdf"), {
    code: "library_empty_text",
  });
  checks++;
  await assert.rejects(
    () =>
      parseLibraryOriginal(
        libraryTestPdf(55, "confidential budget ".repeat(2000).trim()),
        "application/pdf",
      ),
    { code: "library_text_limit" },
  );
  checks++;
  check(isDataOnlyPrompt(LIBRARY_SYSTEM_PROMPT), true);
  check(withAppendedSystemPrompt(LIBRARY_SYSTEM_PROMPT, "Do not append"), LIBRARY_SYSTEM_PROMPT);
  check(isDataOnlyPrompt("[OpenHorn review classification JSON v1]"), true);
  check(isDataOnlyPrompt("ordinary"), false);
  check(libraryKeywords("运费多少").includes("运费"), true);
  const packed = packLibrarySources(
    "运费",
    Array.from({ length: 10 }, (_, i) => ({
      documentId: String(i),
      fileName: '"'.repeat(200),
      chunkIndex: i,
      text: "汉".repeat(2800),
    })),
  );
  check(utf8Bytes(libraryQuestionPayload("运费", packed)) <= LIBRARY_LIMITS.sourceBytes, true);
  check(packed.length > 0 && packed.length < 5, true);
  const prepare = {
    requestId: crypto.randomUUID(),
    scope: personal,
    question: "shipping",
    channelId: `channel-${userId}`,
    modelId: "synthetic",
  };
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...prepare, channelId: `channel-${other}` }),
    "library_channel_unavailable",
  );
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...prepare, scope: { kind: "all" } }),
    "library_invalid_scope",
  );
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...prepare, question: "nonexistent" }),
    "library_no_sources",
  );
  const shopping = await upload("shopping.txt", "我想知道这台咖啡机的折扣，商品只在周末促销。");
  const contract = await upload("contract.txt", "ＡＢＣ合同版本。");
  check(
    (await service.searchLibrary(userId, personal, "abc")).map((hit) => hit.fileName),
    ["contract.txt"],
  );
  check(
    (await service.searchLibrary(userId, personal, "咖啡机")).map((hit) => hit.fileName),
    ["shopping.txt"],
  );
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...prepare, question: "我想知道季度安全预算" }),
    "library_no_sources",
  );
  await service.deleteLibraryDocument(
    userId,
    shopping.body.document.id,
    shopping.body.document.revision,
  );
  await service.deleteLibraryDocument(
    userId,
    contract.body.document.id,
    contract.body.document.revision,
  );
  check((await db.select().from(conversations).where(eq(conversations.userId, userId))).length, 0);
  const prepared = await service.prepareLibraryQuestion(userId, prepare);
  check(prepared.replayable, true);
  check(prepared.question.sources[0].fileName, "synthetic.md");
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, prepared.question.conversationId as string));
  check(conversation.defaultMode, "chat");
  check(conversation.forceWebSearch, false);
  check(conversation.systemPrompt, LIBRARY_SYSTEM_PROMPT);
  await db.insert(conversations).values({
    id: "foreign-memory",
    userId,
    title: "Unrelated",
    summary: "MUST_NOT_LEAK_LIBRARY",
    createdAt: now,
    updatedAt: now,
  });
  const context = await buildChatMessages(
    userId,
    [{ role: "user", content: prepared.question.prompt }],
    conversation.systemPrompt,
    conversation.id,
  );
  check(JSON.stringify(context).includes("MUST_NOT_LEAK_LIBRARY"), false);
  await db
    .update(conversations)
    .set({ summary: "LIBRARY_PRIVATE_SUMMARY" })
    .where(eq(conversations.id, conversation.id));
  await db.insert(conversations).values({
    id: "review-private-summary",
    userId,
    title: "Review fixture",
    systemPrompt: "\u3000\t[OpenHorn review classification JSON v1] suffix",
    summary: "REVIEW_PRIVATE_SUMMARY",
    createdAt: now,
    updatedAt: now,
  });
  const ordinary = await buildChatMessages(
    userId,
    [{ role: "user", content: "ordinary" }],
    "Ordinary",
    "new-ordinary-chat",
  );
  check(JSON.stringify(ordinary).includes("MUST_NOT_LEAK_LIBRARY"), true);
  check(JSON.stringify(ordinary).includes("LIBRARY_PRIVATE_SUMMARY"), false);
  check(JSON.stringify(ordinary).includes("REVIEW_PRIVATE_SUMMARY"), false);
  await setSettingValue(userId, "agent.autoSummarize", "true");
  for (const id of [conversation.id, "review-private-summary", "foreign-memory"]) {
    await db.insert(messages).values(
      Array.from({ length: 10 }, (_, n) => ({
        id: `${id}-summary-${n}`,
        conversationId: id,
        content: "Synthetic summary fixture",
        role: n % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: now,
      })),
    );
  }
  const beforeSummary = providerAttempts;
  await maybeSummarize(userId, conversation.id);
  await maybeSummarize(userId, "review-private-summary");
  check(providerAttempts, beforeSummary);
  await maybeSummarize(userId, "foreign-memory");
  check(providerAttempts, beforeSummary + 1);
  await setSettingValue(userId, "agent.autoSummarize", "false");
  await db.delete(conversations).where(eq(conversations.id, "review-private-summary"));
  await db.delete(conversations).where(eq(conversations.id, "foreign-memory"));
  check((await service.prepareLibraryQuestion(userId, prepare)).question.id, prepared.question.id);
  await reject(
    () => service.prepareLibraryQuestion(userId, { ...prepare, question: "returns" }),
    "library_request_conflict",
  );
  await service.deleteLibraryDocument(userId, first.body.document.id, first.body.document.revision);
  check((await service.searchLibrary(userId, personal, "shipping")).length, 0);
  check(
    Number(
      (
        await client.execute({
          sql: "SELECT count(*) AS count FROM library_chunks_fts WHERE document_id = ?",
          args: [first.body.document.id],
        })
      ).rows[0]?.count,
    ),
    0,
  );
  check(
    (await service.prepareLibraryQuestion(userId, prepare)).question.prompt,
    prepared.question.prompt,
  );
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  check((await service.prepareLibraryQuestion(userId, prepare)).replayable, false);
  check((await db.select().from(conversations).where(eq(conversations.userId, userId))).length, 0);
  // A second index claim cannot overwrite a newer lease; deleting during parse never resurrects.
  const deferred = await service.uploadLibraryDocument(
    userId,
    personal,
    "race.txt",
    Buffer.from("original"),
  );
  let finish!: (text: string) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const indexing = service.indexLibraryDocument(userId, deferred.document.id, async () => {
    entered();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  await started;
  await reject(
    () => service.indexLibraryDocument(userId, deferred.document.id),
    "library_index_busy",
  );
  await db
    .update(libraryDocuments)
    .set({ leaseUntil: new Date(0) })
    .where(eq(libraryDocuments.id, deferred.document.id));
  const newer = await service.indexLibraryDocument(
    userId,
    deferred.document.id,
    async () => "newest shipping text",
  );
  finish("stale text");
  await reject(() => indexing, "library_conflict");
  check((await service.getLibraryDocument(userId, newer.id)).text, "newest shipping text");
  check(
    (
      await client.execute({
        sql: "SELECT text FROM library_chunks_fts WHERE document_id = ?",
        args: [newer.id],
      })
    ).rows.map((row) => String(row.text)),
    ["newest shipping text"],
  );
  const active = service.indexLibraryDocument(userId, newer.id, async () => {
    await service.deleteLibraryDocument(userId, newer.id, newer.revision + 1);
    return "deleted";
  });
  await reject(() => active, "library_conflict");
  check(
    (await db.select().from(libraryChunks).where(eq(libraryChunks.documentId, newer.id))).length,
    0,
  );
  // Project snapshots remain in an unavailable original scope after project deletion.
  const projectQuestion = await service.prepareLibraryQuestion(userId, {
    ...prepare,
    requestId: crypto.randomUUID(),
    scope: project,
  });
  await db.delete(projects).where(eq(projects.id, project.projectId));
  check(
    (await service.getLibraryQuestion(userId, projectQuestion.question.id)).question.scope.kind,
    "project",
  );
  check(
    (await service.getLibraryQuestion(userId, projectQuestion.question.id)).question.scopeAvailable,
    false,
  );
  check((await service.getLibraryQuestion(userId, projectQuestion.question.id)).replayable, false);
  check(
    (await service.listLibraryDocuments(userId, { kind: "all" })).some(
      (d) => d.id === projectDoc.id,
    ),
    false,
  );
  const pdfQuestion = await service.prepareLibraryQuestion(userId, {
    ...prepare,
    question: "provenance",
    requestId: crypto.randomUUID(),
  });
  check(JSON.parse(pdfQuestion.question.prompt).sources[0].location, pageHit.location);
  // Exercise compatibility with a source snapshot created before positions were stored.
  const { location: _oldLocation, ...oldSource } = prepared.question.sources[0];
  await db
    .update(libraryQuestions)
    .set({ sources: JSON.stringify([oldSource]) })
    .where(eq(libraryQuestions.id, prepared.question.id));
  const backupDoc = await upload("backup.md", "Shipping backup original.");
  const backupNewer = await upload("backup.md", "Shipping backup newer.");
  check(backupNewer.body.document.version, 2);
  const estimate = await estimateExportSize(userId);
  check(estimate.estimatedBytes > 0, true);
  const backup = await exportBackup(userId, directory);
  const entries = await extractZipEntries(backup.filePath);
  check(entries.has("library-documents.json"), true);
  check(entries.has("library-questions.json"), true);
  const exportedDocs = JSON.parse((entries.get("library-documents.json") as Buffer).toString());
  check("indexToken" in exportedDocs[0], false);
  check("textContent" in exportedDocs[0], false);
  const restored = await importOpenHornBackup(other, backup.filePath);
  check((restored.library?.imported ?? 0) >= 3, true);
  check((await service.searchLibrary(other, personal, "shipping")).length, 1);
  const restoredBackup = (await service.listLibraryDocuments(other, personal)).find(
    (row) => row.fileName === "backup.md",
  );
  if (!restoredBackup) throw new Error("restored versioned backup missing");
  check(
    (await service.listLibraryDocumentVersions(other, restoredBackup.id)).map((row) => row.version),
    [2, 1],
  );
  const restoredFoldered = (await service.listLibraryDocuments(other, personal)).find(
    (row) => row.fileName === "backup-folder.md",
  );
  check(restoredFoldered?.folderId !== null && restoredFoldered?.folderId !== undefined, true);
  const importedMetadata = (
    await service.listLibraryDocuments(other, personal, { favoriteOnly: true, tag: "guide" })
  )[0];
  check(
    [importedMetadata.displayName, importedMetadata.tags, importedMetadata.isFavorite],
    ["Saved notes", ["work", "guide"], true],
  );
  check((await service.listLibraryDocumentVersions(other, importedMetadata.id)).length, 2);
  const restoredQuestions = await service.listLibraryQuestions(other);
  check(restoredQuestions.length, 3);
  check(
    restoredQuestions.find((q) => q.question === "provenance")?.sources[0]?.location,
    pageHit.location,
  );
  check(
    restoredQuestions.find((q) => q.scope.kind === "personal" && q.question === "shipping")
      ?.sources[0]?.location,
    undefined,
  );
  check((await service.searchLibrary(other, personal, "provenance"))[0].location, pageHit.location);
  check(
    restoredQuestions.some((q) => q.scope.kind === "project" && !q.scopeAvailable),
    true,
  );
  const again = await importOpenHornBackup(other, backup.filePath);
  check(again.library?.imported, 0);
  check((await service.listLibraryQuestions(other)).length, 3);
  check(
    (await service.getLibraryOriginal(userId, backupDoc.body.document.id)).bytes.toString(),
    "Shipping backup original.",
  );
  let invalid = false;
  try {
    validateLibraryBackupOriginal({ ...exportedDocs[0], originalBase64: "!!!!" });
  } catch {
    invalid = true;
  }
  check(invalid, true);
  invalid = false;
  try {
    validateLibraryBackupOriginal({ ...exportedDocs[0], fileSize: 999 });
  } catch {
    invalid = true;
  }
  check(invalid, true);
  const missing = await restoreLibraryBackup(
    other,
    [{ ...exportedDocs[0], projectId: "missing", scopeKey: "project:missing", folderId: null }],
    [],
    [],
    { project: () => null, channel: () => null, conversation: () => null, stable: (_, v) => v },
  );
  check(missing.skipped, 1);
  check(missing.errors.length, 1);
  check(await service.deleteLibraryQuestion(userId, prepared.question.id), true);
  check((await service.listLibraryQuestions(userId)).length, 2);
  // Large originals must pass canonical validation without regex recursion limits.
  const fullBytes = Buffer.alloc(LIBRARY_LIMITS.fileBytes, 65);
  const fullDoc = await service.uploadLibraryDocument(userId, personal, "large.txt", fullBytes);
  check(fullDoc.document.status, "failed");
  const [fullRow] = await db
    .select()
    .from(libraryDocuments)
    .where(eq(libraryDocuments.id, fullDoc.document.id));
  check(validateLibraryBackupOriginal(fullRow).bytes.length, LIBRARY_LIMITS.fileBytes);
  await service.deleteLibraryDocument(userId, fullRow.id, fullRow.revision);
  const longHeading = await service.uploadLibraryDocument(
    userId,
    personal,
    "long-heading.md",
    Buffer.from(`# ${"heading".repeat(1000)}`),
  );
  const headings = await db
    .select()
    .from(libraryChunks)
    .where(eq(libraryChunks.documentId, longHeading.document.id));
  check(
    headings.every((chunk) => (chunk.heading?.length ?? 0) <= 280),
    true,
  );
  let invalidScope = false;
  try {
    const corrupt = { ...exportedDocs[0], scopeKey: "project:original" };
    delete corrupt.projectId;
    validateLibraryBackupOriginal(corrupt);
  } catch {
    invalidScope = true;
  }
  check(invalidScope, true);
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      service.uploadLibraryDocument(userId, personal, "duplicate.txt", Buffer.from("same")),
    ),
  );
  check(concurrent[0].document.id, concurrent[1].document.id);
  // Quota check precedes any new conversation write; deleting records frees the slot.
  const questions = await db
    .select()
    .from(libraryQuestions)
    .where(eq(libraryQuestions.userId, userId));
  await db.delete(libraryQuestions).where(eq(libraryQuestions.userId, userId));
  const seed = questions[0];
  await db.insert(libraryQuestions).values(
    Array.from({ length: LIBRARY_LIMITS.questions }, (_, i) => ({
      ...seed,
      id: `quota-${i}`,
      requestId: `quota-request-${i}`,
      conversationId: null,
    })),
  );
  await reject(
    () =>
      service.prepareLibraryQuestion(userId, {
        ...prepare,
        requestId: crypto.randomUUID(),
        question: "heading",
      }),
    "library_question_limit",
  );
  await service.deleteLibraryQuestion(userId, "quota-0");
  check(
    (
      await service.prepareLibraryQuestion(userId, {
        ...prepare,
        requestId: crypto.randomUUID(),
        question: "heading",
      })
    ).replayable,
    true,
  );
  // A ZIP with duplicate names cannot silently replace the original entry.
  const { ZipArchive } = await import("archiver");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const archive = new ZipArchive(),
    duplicatePath = path.join(directory, "duplicate.zip");
  const completed = pipeline(archive, createWriteStream(duplicatePath));
  archive.append("one", { name: "same.json" });
  archive.append("two", { name: "same.json" });
  await Promise.all([completed, archive.finalize()]);
  await assert.rejects(() => extractZipEntries(duplicatePath), /Duplicate/);
  checks++;
  const testArchive = async (name: string, data: Record<string, unknown>) => {
    const file = path.join(directory, name);
    const zip = new ZipArchive();
    const pipe = pipeline(zip, createWriteStream(file));
    zip.append(JSON.stringify({ formatVersion: "1.3.0" }), { name: "manifest.json" });
    for (const [entry, value] of Object.entries(data))
      zip.append(JSON.stringify(value), { name: entry });
    await Promise.all([pipe, zip.finalize()]);
    return file;
  };
  const invalidArchive = await testArchive("invalid-library.zip", {
    "conversations.json": [
      { id: "preflight-no-write", title: "Must not import", createdAt: now, updatedAt: now },
    ],
    "library-documents.json": [{ ...exportedDocs[0], sha256: "invalid" }],
  });
  const invalidResult = await importOpenHornBackup(other, invalidArchive);
  check(invalidResult.backupFailure, "validation");
  check(invalidResult.conversations.imported, 0);
  check(
    (await db.select().from(conversations).where(eq(conversations.id, "preflight-no-write")))
      .length,
    0,
  );
  check(!!invalidResult.recordId, true);
  await client.execute(`CREATE TRIGGER audit_reject_setting BEFORE INSERT ON settings
    WHEN NEW.key = 'audit-fail-at-destination'
    BEGIN SELECT RAISE(ABORT, 'Synthetic destination failure'); END;`);
  const interruptedArchive = await testArchive("interrupted.zip", {
    "conversations.json": [
      { id: "committed-before-interruption", title: "Restored", createdAt: now, updatedAt: now },
    ],
    "settings.json": [
      {
        id: "cannot-restore-setting",
        key: "audit-fail-at-destination",
        value: "synthetic",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  const interrupted = await importOpenHornBackup(other, interruptedArchive);
  check(interrupted.backupFailure, "interrupted");
  check(interrupted.conversations.imported, 1);
  check(
    interrupted.errors.some((error) => error.endsWith("settings")),
    true,
  );
  check(
    (
      await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, "committed-before-interruption"))
    ).length,
    1,
  );
  check(
    (
      await db
        .select()
        .from(importRecords)
        .where(eq(importRecords.id, interrupted.recordId as string))
    ).length,
    1,
  );
  console.log(JSON.stringify({ checks }));
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
