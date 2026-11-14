// Opens only the isolated database inherited from deepseekImport.fixture.ts.
export {};
if (
  process.env.NODE_ENV !== "test" ||
  !process.env.DATABASE_URL?.includes("openhorn-deepseek-import-")
) {
  throw new Error("DeepSeek import worker requires its parent fixture's temporary database");
}
const { client } = await import("../db");
try {
  const { importDeepSeek } = await import("./importService");
  console.log(JSON.stringify(await importDeepSeek(process.argv[2], process.argv[3])));
} finally {
  client.close();
}
