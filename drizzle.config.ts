export default {
  schema: "./packages/db/src/schema/index.ts",
  out: "./packages/db/src/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL || "./data/openhorn.db",
  },
};
