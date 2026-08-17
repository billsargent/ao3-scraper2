import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDatabase } from "./client.js";

const { db, pool } = createDatabase();
try {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  console.log("Collector MariaDB migrations completed");
} finally {
  await pool.end();
}
