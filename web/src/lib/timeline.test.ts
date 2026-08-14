import { describe, expect, it } from "bun:test";
import { chapterKey, resolveTimelineFocus, toChapters, unresolvedFocusNote } from "./timeline";
import type { TimelineInteraction, TimelineTask } from "../types";

function interaction(seq: number, taskSeq: number | null): TimelineInteraction {
  return {
    seq,
    taskSeq,
    initiator: "human",
    disposition: "completed",
    totalTokens: 0,
    toolCalls: 0,
    tools: [],
    models: [],
  };
}

function task(seq: number): TimelineTask {
  return { seq, description: `Task ${seq}` };
}

describe("toChapters", () => {
  it("groups consecutive interactions with the same task into one chapter", () => {
    const chapters = toChapters(
      [interaction(0, 0), interaction(1, 0), interaction(2, 1)],
      [task(0), task(1)],
    );
    expect(chapters.map((c) => c.taskSeq)).toEqual([0, 1]);
    expect(chapters[0]!.items.map((it) => it.seq)).toEqual([0, 1]);
    expect(chapters[0]!.task?.description).toBe("Task 0");
    expect(chapters[1]!.items.map((it) => it.seq)).toEqual([2]);
  });

  it("makes a headerless chapter of the interactions before the first task", () => {
    const chapters = toChapters([interaction(0, null), interaction(1, 0)], [task(0)]);
    expect(chapters[0]!.taskSeq).toBeNull();
    expect(chapters[0]!.task).toBeUndefined();
    expect(chapters[1]!.taskSeq).toBe(0);
  });

  it("keeps a task that heads two separate runs as two chapters", () => {
    const chapters = toChapters(
      [interaction(0, 0), interaction(1, 1), interaction(2, 0)],
      [task(0), task(1)],
    );
    expect(chapters.map((c) => c.taskSeq)).toEqual([0, 1, 0]);
    expect(chapterKey(0)).not.toBe(chapterKey(2));
  });
});

describe("resolveTimelineFocus", () => {
  const chapters = toChapters(
    [interaction(0, 0), interaction(1, 0), interaction(2, 1), interaction(3, 0)],
    [task(0), task(1)],
  );

  it("resolves a task to its first chapter and names no interaction", () => {
    expect(resolveTimelineFocus(chapters, { kind: "task", seq: 0, nonce: 1 })).toEqual({
      chapterIndex: 0,
      interactionSeq: null,
    });
  });

  it("resolves an interaction to the chapter holding it", () => {
    expect(resolveTimelineFocus(chapters, { kind: "interaction", seq: 3, nonce: 1 })).toEqual({
      chapterIndex: 2,
      interactionSeq: 3,
    });
  });

  it("finds an interaction that isn't the first in its chapter", () => {
    expect(resolveTimelineFocus(chapters, { kind: "interaction", seq: 1, nonce: 1 })).toEqual({
      chapterIndex: 0,
      interactionSeq: 1,
    });
  });

  it("gives up on a target this timeline doesn't have, rather than picking one", () => {
    expect(resolveTimelineFocus(chapters, { kind: "interaction", seq: 99, nonce: 1 })).toBeNull();
    expect(resolveTimelineFocus(chapters, { kind: "task", seq: 99, nonce: 1 })).toBeNull();
  });

  it("resolves nothing when nothing was requested", () => {
    expect(resolveTimelineFocus(chapters, null)).toBeNull();
    expect(resolveTimelineFocus(chapters, undefined)).toBeNull();
  });
});

describe("unresolvedFocusNote", () => {
  const chapters = toChapters([interaction(0, 0), interaction(1, 0)], [task(0)]);

  it("stays quiet when nothing was requested", () => {
    expect(unresolvedFocusNote(chapters, null)).toBeNull();
    expect(unresolvedFocusNote(chapters, undefined)).toBeNull();
  });

  it("stays quiet when the request resolved", () => {
    expect(unresolvedFocusNote(chapters, { kind: "interaction", seq: 1, nonce: 1 })).toBeNull();
    expect(unresolvedFocusNote(chapters, { kind: "task", seq: 0, nonce: 1 })).toBeNull();
  });

  it("says an interaction has gone, rather than leaving the click looking broken", () => {
    expect(unresolvedFocusNote(chapters, { kind: "interaction", seq: 99, nonce: 1 })).toBe(
      "That interaction isn’t in this timeline any more. The session may have changed since this page loaded.",
    );
  });

  it("names a missing task as a task", () => {
    expect(unresolvedFocusNote(chapters, { kind: "task", seq: 99, nonce: 1 })).toBe(
      "That task isn’t in this timeline any more. The session may have changed since this page loaded.",
    );
  });

  it("says nothing about an empty timeline unless a link pointed into it", () => {
    expect(unresolvedFocusNote([], null)).toBeNull();
    expect(unresolvedFocusNote([], { kind: "interaction", seq: 0, nonce: 1 })).not.toBeNull();
  });
});
