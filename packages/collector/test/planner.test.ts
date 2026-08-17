import { describe, expect, it } from "vitest";
import { planIdRange } from "../src/planner.js";

describe("ID range planner", () => {
  it("streams bounded batches without materializing the full range", () => {
    const iterator = planIdRange({ start: 1, end: 1_000_000_000, batchSize: 3 });
    expect(iterator.next().value).toEqual(["1", "2", "3"]);
    expect(iterator.next().value).toEqual(["4", "5", "6"]);
  });

  it("includes the end ID and yields a final partial batch", () => {
    expect([...planIdRange({ start: 10, end: 14, batchSize: 3 })]).toEqual([
      ["10", "11", "12"],
      ["13", "14"],
    ]);
  });

  it("rejects reversed and oversized configurations", () => {
    expect(() => [...planIdRange({ start: 5, end: 4, batchSize: 2 })]).toThrow("end must be greater");
    expect(() => [...planIdRange({ start: 1, end: 2, batchSize: 1001 })]).toThrow();
  });
});
