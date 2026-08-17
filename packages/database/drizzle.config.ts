import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.COLLECTOR_DATABASE_URL ?? "mysql://collector:collector@localhost:3306/ao3_collector",
  },
  strict: true,
  verbose: true,
});
