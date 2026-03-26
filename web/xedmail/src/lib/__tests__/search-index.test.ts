import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { addToIndex, searchIndex } from "../search-index";

describe("searchIndex", () => {
  it("returns empty for empty query", () => {
    expect(searchIndex("")).toEqual([]);
  });

  it("finds added email by subject", async () => {
    await addToIndex([{
      id: "a@b.com:1", mailboxId: "a@b.com", uid: 1, threadId: "",
      subject: "Hello World", fromName: "Alice", fromAddress: "alice@x.com",
      date: 0, snippet: "", isRead: false, isStarred: false, labels: [], hasAttachments: false,
    }]);
    const results = searchIndex("hello");
    expect(results).toContain("a@b.com:1");
  });
});
