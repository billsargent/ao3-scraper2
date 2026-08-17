import { z } from "zod";
import { createDatabase } from "@ao3-offsite/database";
import { buildApp } from "./app.js";
import { MariaDbApiServices } from "./services.js";

const configuration = z.object({
  COLLECTOR_DATABASE_URL: z.string().url(),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
}).parse(process.env);
const { db, pool } = createDatabase(configuration.COLLECTOR_DATABASE_URL);
const app = buildApp(new MariaDbApiServices(db));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close());
}
app.addHook("onClose", async () => pool.end());
await app.listen({ host: configuration.API_HOST, port: configuration.API_PORT });
