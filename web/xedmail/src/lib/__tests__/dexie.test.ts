import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { db, getSyncState, setSyncState } from "../dexie";

describe("syncState helpers", () => {
  beforeEach(async () => { await db.syncState.clear(); });

  it("returns fallback when key missing", async () => {
    expect(await getSyncState("missing", 42)).toBe(42);
  });

  it("round-trips a value", async () => {
    await setSyncState("test", { a: 1 });
    expect(await getSyncState("test", null)).toEqual({ a: 1 });
  });
});
