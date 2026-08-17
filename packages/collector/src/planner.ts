import { z } from "zod";

export const IdRangeConfigurationSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(1_000).default(250),
}).refine((configuration) => configuration.end >= configuration.start, {
  message: "end must be greater than or equal to start",
  path: ["end"],
});

export type IdRangeConfiguration = z.input<typeof IdRangeConfigurationSchema>;

export function* planIdRange(input: IdRangeConfiguration): Generator<string[]> {
  const configuration = IdRangeConfigurationSchema.parse(input);
  let batch: string[] = [];
  for (let workId = configuration.start; workId <= configuration.end; workId += 1) {
    batch.push(String(workId));
    if (batch.length === configuration.batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
