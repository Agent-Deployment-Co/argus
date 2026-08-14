// Pure shaping for the session timeline: grouping interactions into task chapters, and resolving a
// focus request (a "show me this" link from elsewhere in the session) to the chapter — and, when the
// request named one, the interaction — the timeline should open and scroll to. Kept out of the
// component so the grouping and the link targeting are testable on their own.
import type { TimelineInteraction, TimelineTask } from "../types";

/** A run of consecutive interactions belonging to the same task (or to no task at all). */
export interface TimelineChapter {
  taskSeq: number | null;
  task?: TimelineTask;
  items: TimelineInteraction[];
}

/** A one-shot request to open the timeline focused on something. `kind: "task"` targets a task
 *  chapter by its seq (the task list's timeline links); `kind: "interaction"` targets one
 *  interaction by its seq (a credential finding in the warning banner, #336). `nonce` changes per
 *  click so re-focusing the same target re-triggers. */
export interface TimelineFocus {
  kind: "task" | "interaction";
  seq: number;
  nonce: number;
}

/** Where a focus request lands. `interactionSeq` is set only when the request named an interaction,
 *  in which case that card — not the chapter head — is what gets scrolled to and highlighted. */
export interface TimelineFocusTarget {
  chapterIndex: number;
  interactionSeq: number | null;
}

/** Chapters are keyed by running index, not taskSeq: task membership is *usually* monotonic across
 *  the timeline, but clock skew or interleaved subagent/resumed interactions can make the same
 *  taskSeq head two separate chapters — index keys stay unique so collapse/focus never conflate
 *  them. */
export function chapterKey(index: number): string {
  return `ch-${index}`;
}

/** Group interactions into task chapters, preserving order. Task membership is non-decreasing across
 *  the timeline (bookmark assignment), so consecutive interactions with the same taskSeq are one
 *  chapter; a run with no task (before the first task) becomes a headerless group. */
export function toChapters(
  interactions: TimelineInteraction[],
  tasks: TimelineTask[],
): TimelineChapter[] {
  const byIndex = new Map(tasks.map((t) => [t.seq, t]));
  const chapters: TimelineChapter[] = [];
  for (const it of interactions) {
    const last = chapters[chapters.length - 1];
    if (last && last.taskSeq === it.taskSeq) {
      last.items.push(it);
    } else {
      chapters.push({
        taskSeq: it.taskSeq,
        task: it.taskSeq != null ? byIndex.get(it.taskSeq) : undefined,
        items: [it],
      });
    }
  }
  return chapters;
}

/** Resolve a focus request against the chapters on screen. Returns null when the target isn't in
 *  this timeline — a link that went stale after a re-index should do nothing rather than scroll
 *  somewhere arbitrary. A task seq resolves to the first chapter carrying it. */
export function resolveTimelineFocus(
  chapters: TimelineChapter[],
  focus: TimelineFocus | null | undefined,
): TimelineFocusTarget | null {
  if (!focus) return null;
  if (focus.kind === "task") {
    const chapterIndex = chapters.findIndex((c) => c.taskSeq === focus.seq);
    return chapterIndex < 0 ? null : { chapterIndex, interactionSeq: null };
  }
  const chapterIndex = chapters.findIndex((c) => c.items.some((it) => it.seq === focus.seq));
  return chapterIndex < 0 ? null : { chapterIndex, interactionSeq: focus.seq };
}
