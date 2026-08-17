import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema.js";

export type CollectorDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(databaseUrl = process.env.COLLECTOR_DATABASE_URL) {
  if (!databaseUrl) throw new Error("COLLECTOR_DATABASE_URL is required");
  const parsed = new URL(databaseUrl);
  if (!["mysql:", "mariadb:"].includes(parsed.protocol)) {
    throw new Error("COLLECTOR_DATABASE_URL must use mysql:// or mariadb://");
  }
  const pool = mysql.createPool({
    uri: databaseUrl.replace(/^mariadb:/, "mysql:"),
    connectionLimit: 10,
    charset: "utf8mb4",
    supportBigNumbers: true,
    timezone: "Z",
  });
  return { pool, db: drizzle(pool, { schema, mode: "default" }) };
}
