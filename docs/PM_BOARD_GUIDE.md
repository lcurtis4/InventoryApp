# PM Board Guide

Single source of truth for tracking work on the Yu-Gi-Oh Inventory App.

Board: [PM Board (Project #1)](https://github.com/users/lcurtis4/projects/1)

---

## 1. Lane meanings (Status column)

| Status | Meaning |
|---|---|
| **Backlog** | Unsorted ideas + epics not yet committed to a sprint. Triaged here first. |
| **Ready** | Groomed: sized, prioritized, acceptance criteria written. Committed to the next sprint. |
| **In progress** | Active sprint work + the epic for the sprint that is currently being delivered. |
| **Blocked** ⛔ | Waiting on the PM (you) for input, decision, or unblocking. **Anything in here needs your attention.** |
| **In review** | PR open, awaiting UAT or merge. |
| **Done** | Merged to `main`. |

**Rule of thumb:** Anything in `In progress` should have visible movement in the current sprint. If it stalls > 2 days, move it back to `Ready` and replace with something else.

**Blocked policy:** When an assistant (e.g. me) needs an answer or decision from you before continuing a ticket, the ticket gets moved to `Blocked` and a comment is added explaining what's needed. **Daily action for the PM: check the Blocked column first thing.** Empty Blocked column = no decisions waiting on you.

---

## 2. Field conventions

| Field | Values | When to set |
|---|---|---|
| **Type** | Epic / Story / Bug / Chore / Spike | On creation. Epics are sprint or initiative parents. |
| **Sprint** | Sprint 1–N / SaaS-Readiness / Backlog | On grooming, before moving to `Ready`. |
| **Priority** | P0 urgent · P1 this sprint · P2 next sprint · P3 someday | On grooming. Every item must have one. |
| **Size** | XS (<1h) · S (1–3h) · M (½–1d) · L (1–3d) · XL (3d+ split) | On grooming. XL items must be split before moving past `Backlog`. |
| **Parent issue** | Link to the epic | For every child of an epic. Linked via GitHub sub-issues — drives the rollup progress bar. |

---

## 3. Recommended views (configure in the GitHub UI)

GitHub's API doesn't let scripts create/configure views, so the five existing slots need to be set up once in the browser. Click each view tab → "View options" → apply settings.

### View 1: **Sprint Board** (rename "Backlog" view)
- Layout: **Board**
- Group by: **Status**
- Filter: `sprint:"Sprint 4"` (update each sprint)
- Sort: Priority ↑, Size ↑
- Columns shown: Type, Priority, Size, Sub-issues progress

**Use:** Daily standup view. What's in progress right now.

### View 2: **Roadmap**
- Layout: **Roadmap**
- Group by: **Sprint**
- Dates: Start date → Target date
- Filter: `type:Epic` (epics only — keeps it scannable)

**Use:** Multi-sprint planning. See which initiatives land when.

### View 3: **Epics** (rename "Priority board")
- Layout: **Board**
- Group by: **Parent issue**
- Filter: none
- Columns shown: Status, Priority, Sub-issues progress

**Use:** At-a-glance project status. Each epic is a column, with its stories beneath. Done count rolls up.

### View 4: **Backlog Grooming** (rename "Team items")
- Layout: **Table**
- Filter: `status:Backlog,Ready`
- Sort: Priority ↑, Created ↓
- Columns: Title, Type, Sprint, Priority, Size, Parent issue

**Use:** Weekly grooming. Walk top-to-bottom, fill in missing fields, promote `Backlog` → `Ready`.

### View 5: **By Priority** (rename "My items")
- Layout: **Board**
- Group by: **Priority**
- Filter: `status:!Done`
- Sort: Sprint ↑

**Use:** Triage. See if anything P0 is sitting in Backlog (a red flag).

---

## 3.5. One-time setup: fix the "PR linked" automation

GitHub's default project automation moves a linked issue to **In progress** when a PR mentioning it is opened. That conflicts with our convention (PR open = **In review**).

**Fix it once in the UI:**

1. Open [PM Board](https://github.com/users/lcurtis4/projects/1) → click **⋯** menu (top right) → **Workflows**
2. Find **"Pull request linked to issue"**
3. Change the target **Status** from `In progress` to `In review`
4. Save

This way, opening a PR auto-routes the issue to the correct lane.

---

## 4. Workflow

### When a new bug/feature comes up
1. Create issue on `lcurtis4/InventoryApp` with a descriptive title.
2. Apply labels: `type:*`, `area:*`, `size:*`, `sprint:N` (or `saas-readiness`).
3. The issue auto-adds to PM Board.
4. Set **Type**, **Priority**, **Sprint** in the project.
5. If it's a child of an epic, set **Parent issue** (via sub-issue link on the epic).

### Each sprint
1. Pick an epic for the sprint → set **Sprint** = current, **Status** = `In progress`, **Priority** = P1.
2. Children → **Sprint** = current, **Priority** = P1 or P2, **Status** = `In progress` (when picked up) or `Ready` (when groomed but not started).
3. As PRs open, move to **In review**.
4. On merge, move to **Done** and close the issue.
5. When all children are `Done`, close the epic.

### Closing a sprint
1. Verify all epic children are `Done` or rolled to next sprint.
2. Close the epic (this auto-marks the project item Done).
3. Bump the **Sprint** field on the next epic to current.

---

## 5. Definition of "Ready" (must be true before pulling into a sprint)

- [ ] **Type** set
- [ ] **Priority** set
- [ ] **Size** set and ≤ L
- [ ] Acceptance criteria in the issue body
- [ ] If child of epic → **Parent issue** linked
- [ ] No unanswered open questions in the issue

## 6. Definition of "Done"

- [ ] Code merged to `main`
- [ ] UAT passed on local Windows machine
- [ ] Issue closed with a brief "what shipped" comment
- [ ] If part of a SaaS-readiness item → CHANGELOG updated

---

## 7. Health checks (look for these on the board)

| Symptom | What it usually means |
|---|---|
| > 5 items in `In progress` | Too much WIP; close some before pulling new work. |
| Anything P0 in `Backlog` | Mis-prioritized — either P0 is wrong or it should be `Ready`. |
| Epic in `In progress` > 2 sprints | Epic too large; split. |
| Item in `Ready` with no Size | Not actually ready; back to Backlog for grooming. |
| Sub-issues progress < 100% on a closed epic | Children not properly linked; fix parent issue. |

---

_Last updated: 2026-05-28. Maintained alongside the PM Board itself._
