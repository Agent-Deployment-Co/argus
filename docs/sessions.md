# Sessions

The Sessions view is where you see how you actually work with your agents, one
[session](/terminology#session) at a time, rather than as totals. Find a session,
open it, and read what happened in it.

## Finding a session

The list down the left shows your sessions, newest first. Each entry shows its
title, when it ran, its project and its token, [interaction](/terminology#interaction)
and task counts. The toolbar across the top narrows the list:

- **Search** matches titles, projects and sources, and (when you keep session text,
  the default) the words inside your conversations and the summaries Argus writes.
  A match shows a short snippet with the hit highlighted.
- **Labels** narrows to the sessions carrying the labels you pick. Choose match any
  or match all when you pick more than one.
- **Date** limits the list to a range, with quick presets or your own From and To
  dates.
- **Sources** limits the list to a single agent.

The reset button next to the filters clears them back to the last 30 days and all
sources. If you open Sessions by clicking a project or [source](/terminology#source)
on another view, the list arrives already narrowed to it.

::: tip
Press `/` or Cmd+K (Ctrl+K on Windows) to jump to the search box. With a session
open, `j` and `k` step to the next and previous session in the list.
:::

<div class="screenshot">

![The Sessions view: the session list on the left with the search, labels, date and source toolbar.](./images/screenshots/sessions@1920x1080@2.webp)

</div>

## Labeling and hiding sessions

Two ways to organize the list: label the sessions you want to group, and hide the
ones you don't want to see.

- **Labels.** Open a session and use **Add Label** to tag it. Create a new label on
  the spot or pick one you've used before, and rename or delete labels from the same
  menu. Labels show as chips on the session and in the list, and the toolbar's
  Labels filter narrows to them.
- **Hiding.** The **Hide** button on a session removes it from the list and from
  search. Open a hidden session and **Unhide** it to bring it back.

## Working with several sessions at once

Hold Cmd (or Ctrl) and click to pick sessions one at a time, or hold Shift and
click to select a range. **Select all** picks every session in view and offers to
extend to every session that matches your current filter. With two or more
selected, the right pane switches to bulk actions, so you can label them all at once
or hide them all.

## Inside a session

Open a session and the right pane shows what Argus found in it. The top of the pane
has its source, project, when it ran and how long it lasted, then the title and a
short summary. Below that are three tabs.

<div class="screenshot">

![A session's Overview tab: stat cards, the tasks in the session, and the models, skills and tools it used.](./images/screenshots/session-detail@1920x1080@2.webp)

</div>

### Overview

Stat cards summarize the session: total [tokens](/terminology#token),
[interactions](/terminology#interaction), tasks (once interpreted),
[skills](/terminology#skill) used and [tools](/terminology#tool) used. Below them:

- **Tasks** breaks the session into the tasks you worked on, each with how it turned
  out. They appear once you turn on [task interpretation](/tasks) in
  [Settings](/settings); until then this reads "Interpretation pending." Click a task
  to expand it in place, or open it in the Timeline to read that stretch of the
  session. See [Tasks](/tasks).
- **Models**, **Skills** and **Tools** list what the session drew on, with the tools
  it called most.

### Timeline

The Timeline reads the session back in order, grouped into the tasks you worked on,
so you can follow the back-and-forth between you and the agent.

### Details

The Details tab holds the rest: the [friction](/terminology#friction) signals in the
session (interruptions, tool actions you declined, compactions and turn timings, for
Claude sessions), the full table of tools the session used and the files the agent
read or changed.

## Keeping a session current

If a session has grown since Argus last indexed it, the **Refresh** button at the
top re-reads it from disk and updates everything on the page.
