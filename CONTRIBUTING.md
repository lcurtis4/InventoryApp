# Contributing to YGO Scanner

## Code review

Every pull request goes through two review passes:

1. **Automated review — CodeRabbit AI.** When a PR is opened (or updated),
   [CodeRabbit](https://github.com/marketplace/coderabbitai) posts an automated
   senior-dev-style review: a high-level summary, a file-by-file walkthrough,
   and inline comments on bugs, style, and security concerns. Configuration
   lives in [`.coderabbit.yaml`](.coderabbit.yaml) at the repo root and is
   version-controlled — edit that file to change review tone, path filters, or
   per-area instructions.
2. **Human review.** A maintainer reviews after CodeRabbit, using the automated
   pass as a first filter.

### CodeRabbit setup (one-time, repo admin)

CodeRabbit is a GitHub App and must be installed on the repository by an admin —
this cannot be done from a PR or config file alone:

1. Open <https://github.com/marketplace/coderabbitai> and **Install** the app.
2. Scope it to the `lcurtis4/InventoryApp` repository.
3. Confirm the plan: the free tier covers public/OSS repos. If this repo is
   **private**, verify the chosen plan covers private-repo usage.
4. Open a test PR and confirm CodeRabbit posts a review + summary.

Once installed, the committed `.coderabbit.yaml` drives all review behavior.

### Config notes

- **Profile:** `chill` — focused on real issues, low nitpick noise. Switch to
  `assertive` in `.coderabbit.yaml` for stricter feedback.
- **Auto-review:** enabled for all PRs targeting `main`; drafts are skipped.
- **Path filters:** generated data (`snapshots/`, `*.jsonl`) and `docs/` are
  excluded from review.

## CI

- **Sprint Progress Tracker** (`.github/workflows/sprint-progress.yml`) keeps
  the PM board in sync with issue/sub-issue state.

## Branching

- Branch from `main` using `feat/<issue#>-<slug>` or `fix/<issue#>-<slug>`.
- Open a PR back to `main`; CodeRabbit + a maintainer review before merge.
