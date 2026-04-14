# Reviewer Assigner Action

A reusable **GitHub Action** (TypeScript, Node 20) that **requests PR reviewers** using a practical blend of:

- **`CODEOWNERS`** coverage
- **Recent human editors** per file (ranked by changed lines over a lookback window)
- **Lightweight load balancing** across candidates

Repository: `https://github.com/sebastiancoteanu/reviewer-assigner-action`

---

## Features

- Trigger on PR lifecycle events: `opened`, `reopened`, `synchronize`
- Per-file candidate selection with a **strict owners ∩ recent editors** shortcut when possible
- Filters out **PR author**, **bots**, **excluded users**, and users that **cannot be assigned**
- Optional **dry run** and optional **skip if reviewers already requested**
- Optional PR **comment** summarizing assignments
- Basic **API retry** behavior for transient failures / rate limits

---

## Quick start (consumer repository)

### 1) Add a workflow

Copy `examples/consumer-workflow.yml` into your repository as:

`.github/workflows/auto-assign-reviewers.yml`

Then adjust the `uses:` pin to match how you version this action (see **Versioning** below).

### 2) Add configuration (recommended)

Copy `examples/reviewer-assignment.yml` to:

`.github/reviewer-assignment.yml`

### 3) Ensure permissions are sufficient

Team expansion from `@org/team` entries in `CODEOWNERS` may require additional permissions depending on org settings. Start with the permissions shown in the example workflow; if team expansion fails, you’ll see warnings in the job logs.

---

## Usage

### Action inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | — | Token used for GitHub API calls. In Actions, `${{ secrets.GITHUB_TOKEN }}` is typical. |
| `config-path` | No | `.github/reviewer-assignment.yml` | Path to repo-level YAML config in the **consumer** repository. |

`action.yml` defines the runtime entrypoint as `dist/main.js` (built from `src/main.ts`).

---

## Configuration (consumer repository)

Create `.github/reviewer-assignment.yml`:

```yaml
reviewer_count: 2
lookback_days: 60
recent_editors_limit: 3
exclude_users: []
exclude_bots: true
dry_run: false
skip_if_reviewers_already_assigned: true
skip_generated_files: true
leave_comment: false
```

### Field reference

| Field | Type | Default | Description |
| --- | --- | ---: | --- |
| `reviewer_count` | number | `2` | Number of reviewers to request. |
| `lookback_days` | number | `60` | Lookback window for “recent editors” analysis. |
| `recent_editors_limit` | number | `3` | How many top recent editors to consider per file. |
| `exclude_users` | string[] | `[]` | Usernames to exclude from assignment. |
| `exclude_bots` | boolean | `true` | Exclude bot-like accounts from recent-editor signals and candidate pools. |
| `dry_run` | boolean | `false` | If `true`, logs intended reviewers but does not request them. |
| `skip_if_reviewers_already_assigned` | boolean | `true` | If the PR already has requested reviewers, do nothing. |
| `skip_generated_files` | boolean | `true` | Skip some generated-ish paths from reviewer signals (heuristic). |
| `leave_comment` | boolean | `false` | Post a short PR comment listing assigned reviewers. |

If the config file is missing, the action falls back to defaults.

---

## How reviewer selection works (v1)

1. **Collect changed files** for the PR (removed files are ignored; optional generated-path skipping).
2. For each changed file:
   - Resolve **owners** from `CODEOWNERS` (last matching rule wins).
   - Compute **recent editors** from commit history via the GitHub API:
     - Rank authors by total **changed lines** in that file: `additions + deletions` across commits in the lookback window
     - Take the top `recent_editors_limit` distinct usernames (bots excluded when configured)
   - Compute `strict = owners ∩ recent`
   - If `strict` is non-empty, use `strict`; otherwise use **all owners** for that file
3. **Union** candidates across files.
4. **Filter** candidates:
   - remove PR author
   - remove excluded users / bots (when configured)
   - remove users that are not assignable (best-effort via GitHub API checks)
5. **Score** remaining candidates (lower is better):
   - `score = active_reviews * 1.0 + recent_reviews_24h * 0.5 + avg_pr_size * 0.3`
6. Sort by **ascending** score (lowest load first), **randomize ties**, pick the first `reviewer_count`.
7. **Request reviewers** on the PR (unless `dry_run`).

If no eligible candidates remain, the action **logs** and exits **successfully** (it does not fail the workflow by default).

---

## Versioning

GitHub Action references look like:

`uses: sebastiancoteanu/reviewer-assigner-action@<ref>`

Recommended refs:

- **Release tag** (best for consumers): `@v1.0.2` (immutable patch pin)
- **Branch** (okay for early iteration): `@main`
- **Commit SHA** (most deterministic): `@<40-char-sha>`

Note: a moving major tag like `@v1` may exist, but **immutable pins** (`@v1.0.2` or a full SHA) are safer for production consumer repos.

---

## Limitations / notes

- **GitHub API costs**: “recent editors” uses commit + commit-details calls; large PRs can be chatty.
- **Team expansion**: `@org/team` owners require API access that may be restricted by org policy; failures degrade gracefully with warnings.
- **Correctness vs heuristics**: generated-file skipping and bot detection are intentionally simple.

---

## Developing this action (maintainers)

```bash
npm install
npm test
npm run typecheck
npm run build
```

- Source: `src/*.ts`
- Tests: `test/*.test.ts`
- Built entrypoint: `dist/main.js` (produced by `npm run build`)

---

## Examples in this repository

- `examples/consumer-workflow.yml` — drop-in workflow for consumer repos
- `examples/reviewer-assignment.yml` — sample configuration

---

## License

Add a `LICENSE` file in this repository matching the license you selected on GitHub (MIT / Apache-2.0 / etc.). Until a license is present, assume **all rights reserved**.
