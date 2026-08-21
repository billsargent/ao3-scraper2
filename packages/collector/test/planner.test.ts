import { describe, expect, it } from "vitest";
import { describeError, isTransientError } from "../src/job-planner.js";
import { planIdRange } from "../src/planner.js";

describe("planner error diagnostics", () => {
  it("unwraps the underlying MySQL error cause", () => {
    const mysql = Object.assign(
      new Error("Deadlock found when trying to get lock; try restarting transaction"),
      { code: "ER_LOCK_DEADLOCK", errno: 1213, sqlMessage: "Deadlock found when trying to get lock; try restarting transaction" },
    );
    const drizzleError = Object.assign(new Error("Failed query: select ..."), { name: "DrizzleQueryError", cause: mysql });
    const described = describeError(drizzleError);
    expect(described).toContain("ER_LOCK_DEADLOCK");
    expect(described).toContain("Deadlock found");
  });

  it("classifies transient lock and connection errors", () => {
    expect(isTransientError({ code: "ER_LOCK_DEADLOCK" })).toBe(true);
    expect(isTransientError({ cause: { code: "1205" } })).toBe(true);
    expect(isTransientError({ code: "PROTOCOL_CONNECTION_LOST" })).toBe(true);
    expect(isTransientError({ code: "ER_DUP_ENTRY" })).toBe(false);
    expect(isTransientError(new Error("generic failure"))).toBe(false);
  });
});

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
