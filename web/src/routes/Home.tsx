import { Panel } from "../components/Panel";
import { Section } from "../components/Section";

// The Home screen (#270) — the future root of the web UI. It leads with a few complementary lenses
// (recency, exceptions, repetition, a little metrics) rather than one big table, and routes the user
// into the detail views from there. Mounted at /home for now while it's designed alongside the
// existing Activity page; it takes over "/" once the design settles.
//
// Placeholder content while the panel set is designed — it doubles as the first consumer of the
// shared <Section>/<Panel> layout primitives (docs/internals/design-system.md).
export function Home() {
  return (
    <Section eyebrow="Home">
      <Panel title="Coming soon">
        <p className="muted">The new landing view is under construction.</p>
      </Panel>
    </Section>
  );
}
