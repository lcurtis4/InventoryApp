#!/usr/bin/env python3
"""
Update Sprint Progress on every open epic in the PM Board.

Logic (hard cap 99%):
  - Count children by their Project Board Status (In review, Done, other).
  - Progress = (in_review + done) / total, max 99% until ALL are Done.
  - When all children are Done → 100%.
  - Writes to:
      1. The 'Sprint Progress' field on the PM Board for the epic item.
      2. A progress block at the top of the epic's issue body
         (between <!-- progress:start --> and <!-- progress:end --> markers).

Requires: GH_TOKEN with project, issues:write, repo scopes.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

OWNER = "lcurtis4"
REPO = "InventoryApp"
PROJECT_NUMBER = 1

# Field IDs (PM Board)
PROJECT_ID = "PVT_kwHOBGxeW84BY6b1"
STATUS_FIELD_ID = "PVTSSF_lAHOBGxeW84BY6b1zhT811w"
TYPE_FIELD_ID = "PVTSSF_lAHOBGxeW84BY6b1zhUCirc"
PROGRESS_FIELD_ID = "PVTF_lAHOBGxeW84BY6b1zhUCmn8"

TYPE_EPIC_OPTION = "f3a0a0bc"

START_MARKER = "<!-- progress:start -->"
END_MARKER = "<!-- progress:end -->"


def gql(query, **variables):
    """Run a graphql query via gh CLI. Integers use -F, strings use -f."""
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if isinstance(v, int):
            args += ["-F", f"{k}={v}"]
        else:
            args += ["-f", f"{k}={v}"]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERR gql: {r.stderr}", file=sys.stderr)
        return None
    data = json.loads(r.stdout)
    if "errors" in data:
        print(f"ERR gql response: {data['errors']}", file=sys.stderr)
    return data


def fetch_open_epics():
    """Return list of (project_item_id, issue_id, issue_number, title) for open epics on the board."""
    query = """
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          items(first: 100) {
            nodes {
              id
              type
              fieldValues(first: 30) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    field { ... on ProjectV2SingleSelectField { id name } }
                    optionId
                    name
                  }
                }
              }
              content {
                ... on Issue {
                  id
                  number
                  title
                  state
                  body
                }
              }
            }
          }
        }
      }
    }
    """
    data = gql(query, owner=OWNER, number=PROJECT_NUMBER)
    if not data:
        return []
    nodes = data["data"]["user"]["projectV2"]["items"]["nodes"]
    epics = []
    for n in nodes:
        c = n.get("content") or {}
        if not c or c.get("state") != "OPEN":
            continue
        # Determine if this item's Type field is Epic
        is_epic = False
        for fv in n.get("fieldValues", {}).get("nodes", []):
            f = fv.get("field") or {}
            if f.get("id") == TYPE_FIELD_ID and fv.get("optionId") == TYPE_EPIC_OPTION:
                is_epic = True
                break
        if not is_epic:
            continue
        epics.append({
            "item_id": n["id"],
            "issue_id": c["id"],
            "number": c["number"],
            "title": c["title"],
            "body": c.get("body") or "",
        })
    return epics


def fetch_sub_issues(issue_node_id):
    """Return list of sub-issues with their project Status."""
    query = """
    query($id: ID!) {
      node(id: $id) {
        ... on Issue {
          subIssues(first: 100) {
            nodes {
              id
              number
              title
              state
              projectItems(first: 10) {
                nodes {
                  project { id }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        field { ... on ProjectV2SingleSelectField { id name } }
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    """
    data = gql(query, id=issue_node_id)
    if not data:
        return []
    subs = (data.get("data", {}).get("node") or {}).get("subIssues", {}).get("nodes", [])
    out = []
    for s in subs:
        # Find this child's Status on PM Board
        status = None
        for pi in s.get("projectItems", {}).get("nodes", []):
            if pi.get("project", {}).get("id") != PROJECT_ID:
                continue
            for fv in pi.get("fieldValues", {}).get("nodes", []):
                f = fv.get("field") or {}
                if f.get("id") == STATUS_FIELD_ID:
                    status = fv.get("name")
                    break
        out.append({
            "number": s["number"],
            "title": s["title"],
            "state": s["state"],
            "status": status,
        })
    return out


def compute_progress(children):
    """Return (percent:int, breakdown:str)."""
    total = len(children)
    if total == 0:
        return 0, "no children linked"
    done = sum(1 for c in children if c["status"] == "Done" or c["state"] == "CLOSED")
    in_review = sum(1 for c in children if c["status"] == "In review")
    in_progress = sum(1 for c in children if c["status"] == "In progress")
    ready = sum(1 for c in children if c["status"] == "Ready")
    blocked = sum(1 for c in children if c["status"] == "Blocked")
    backlog = sum(1 for c in children if c["status"] in (None, "Backlog"))

    if done == total:
        pct = 100
    else:
        # Hard cap 99%: any child in In review or Done counts toward progress.
        raw = round(((in_review + done) / total) * 100)
        pct = min(raw, 99)

    parts = []
    if done:        parts.append(f"{done} done")
    if in_review:   parts.append(f"{in_review} in review")
    if in_progress: parts.append(f"{in_progress} in progress")
    if blocked:     parts.append(f"⚠️ {blocked} blocked")
    if ready:       parts.append(f"{ready} ready")
    if backlog:     parts.append(f"{backlog} backlog")
    breakdown = " · ".join(parts) if parts else "no status set"
    return pct, f"{breakdown} (of {total})"


def write_progress_field(item_id, value):
    query = """
    mutation($p: ID!, $i: ID!, $f: ID!, $v: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $p, itemId: $i, fieldId: $f, value: {text: $v}
      }) { projectV2Item { id } }
    }
    """
    return gql(query, p=PROJECT_ID, i=item_id, f=PROGRESS_FIELD_ID, v=value)


def upsert_progress_block(body, pct, breakdown, children):
    """Insert/replace a progress block at the top of the issue body."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    bar_filled = pct // 5
    bar = "█" * bar_filled + "░" * (20 - bar_filled)
    child_lines = []
    for c in sorted(children, key=lambda x: x["number"]):
        emoji = {
            "Done": "✅",
            "In review": "👀",
            "In progress": "🔨",
            "Blocked": "⛔",
            "Ready": "📋",
            "Backlog": "📥",
        }.get(c["status"] or "Backlog", "·")
        child_lines.append(f"  - {emoji} #{c['number']} — {c['title']}")
    children_section = "\n".join(child_lines) if child_lines else "  (no sub-issues linked)"

    block = (
        f"{START_MARKER}\n"
        f"## 📊 Sprint Progress — {pct}%\n"
        f"`{bar}` {pct}%\n\n"
        f"**Status:** {breakdown}\n\n"
        f"<details><summary>Children</summary>\n\n"
        f"{children_section}\n\n"
        f"</details>\n\n"
        f"_Auto-updated {timestamp}. Reaches 100% only when every child is Done._\n"
        f"{END_MARKER}"
    )

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER),
        re.DOTALL,
    )
    if pattern.search(body):
        return pattern.sub(block, body)
    else:
        return block + "\n\n" + body


def update_issue_body(issue_id, body):
    query = """
    mutation($id: ID!, $body: String!) {
      updateIssue(input: {id: $id, body: $body}) {
        issue { number }
      }
    }
    """
    return gql(query, id=issue_id, body=body)


def main():
    epics = fetch_open_epics()
    print(f"Found {len(epics)} open epics")
    if not epics:
        return 0

    summary_rows = []
    for e in epics:
        children = fetch_sub_issues(e["issue_id"])
        pct, breakdown = compute_progress(children)
        field_value = f"{pct}% — {breakdown}"

        print(f"\n#{e['number']} {e['title']}")
        print(f"  {field_value}")

        # 1) Write project field
        write_progress_field(e["item_id"], field_value)

        # 2) Update issue body
        new_body = upsert_progress_block(e["body"], pct, breakdown, children)
        if new_body != e["body"]:
            update_issue_body(e["issue_id"], new_body)

        summary_rows.append((e["number"], e["title"], pct, breakdown))

    print("\n=== Summary ===")
    for num, title, pct, breakdown in summary_rows:
        print(f"  #{num:3} [{pct:3}%] {title[:60]} — {breakdown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
