import { describe, expect, test } from "bun:test";
import { Backoff, RepeatCollapser, sleep, superviseLoop } from "../src/backoff.ts";

describe("sleep", () => {
  test("resolves after roughly the requested delay", async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });

  test("resolves immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("resolves early when aborted mid-wait (no tight loop, no late fire)", async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const t0 = Date.now();
    await p;
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("Backoff", () => {
  test("grows geometrically and caps (jitter off)", () => {
    const b = new Backoff({ baseMs: 100, factor: 2, capMs: 1000, jitter: 0 });
    expect(b.next()).toBe(100);
    expect(b.next()).toBe(200);
    expect(b.next()).toBe(400);
    expect(b.next()).toBe(800);
    expect(b.next()).toBe(1000); // capped
    expect(b.next()).toBe(1000);
  });

  test("reset returns to the base delay", () => {
    const b = new Backoff({ baseMs: 100, factor: 2, jitter: 0 });
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(100);
  });

  test("jitter keeps each delay within ±jitter of the base curve", () => {
    const b = new Backoff({ baseMs: 100, factor: 1, capMs: 1000, jitter: 0.5 });
    for (let i = 0; i < 100; i++) {
      const v = b.next();
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(150);
      b.reset();
    }
  });
});

describe("RepeatCollapser", () => {
  test("logs only on change and summarizes the suppressed repeats", () => {
    const lines: string[] = [];
    const c = new RepeatCollapser((s) => lines.push(s));
    expect(c.note("a")).toBe(true);
    expect(c.note("a")).toBe(false);
    expect(c.note("a")).toBe(false);
    expect(c.note("b")).toBe(true); // flushes the run of "a", then logs "b"
    c.flush();
    expect(lines[0]).toBe("a");
    expect(lines[1]).toContain("repeated 2 more time");
    expect(lines[2]).toBe("b");
  });
});

describe("superviseLoop", () => {
  test("does nothing when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let runs = 0;
    await superviseLoop("test", async () => { runs++; }, { signal: ac.signal, log: () => {} });
    expect(runs).toBe(0);
  });

  test("restarts a throwing body with backoff, collapses repeats, and exits on abort", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let runs = 0;
    const p = superviseLoop(
      "test",
      async () => {
        runs++;
        throw new Error("boom");
      },
      { signal: ac.signal, log: (s) => lines.push(s), backoff: { baseMs: 1, factor: 1, jitter: 0 } },
    );
    setTimeout(() => ac.abort(), 50);
    await p;
    expect(runs).toBeGreaterThan(1); // it restarted
    // Identical failures collapse: the full "boom" line is logged once, not once per attempt.
    expect(lines.filter((l) => l.includes("boom")).length).toBe(1);
  });

  test("restarts a body that returns early while still running", async () => {
    const ac = new AbortController();
    let runs = 0;
    const p = superviseLoop("test", async () => { runs++; }, {
      signal: ac.signal,
      log: () => {},
      backoff: { baseMs: 1, jitter: 0 },
    });
    setTimeout(() => ac.abort(), 40);
    await p;
    expect(runs).toBeGreaterThan(1);
  });
});
