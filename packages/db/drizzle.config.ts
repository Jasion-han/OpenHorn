function normalizeSqliteUrl(url: string) {
  // Accept both "file:./path.db" and "./path.db"
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

export default {
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: normalizeSqliteUrl(process.env.DATABASE_URL || "../../data/openhorn.db"),
  },
};
