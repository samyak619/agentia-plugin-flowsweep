# FlowSweep

**Safe Salesforce Flow retirement for Copado pipelines, as an Agentia CLI plugin.**

```
agentia flow sweep
```

Deleting a Flow is the one destructive change Copado does not automate. Copado's own knowledge base says it plainly: *"Destructive Changes in Copado Doesn't Support Flow and Process Builder."* Teams find out at deploy time:

```
FS_Demo_Orphan   insufficient access rights on cross-reference id
```

Salesforce refuses to delete a Flow while it has an active version, older versions left in the org, paused interviews, or anything still calling it. So someone opens Setup in every org of the pipeline and does it by hand.

FlowSweep turns that manual chore into one checked, reversible command that knows your Copado user story.

## What it does

```
FlowSweep  origin/main...HEAD
Story      US-0000024 My first Source Format User Story
Org        dev1

BLOCKED      Case_Escalation_Notify
             force-app/main/default/flows/Case_Escalation_Notify.flow-meta.xml
             In org: v1 Active
  blocker    Still referenced in 1 file(s) at the story head; Salesforce refuses to delete a Flow that is in use
    ref      Flow (subflow or action): force-app/main/default/flows/Case_Intake_Main.flow-meta.xml:20

READY        Legacy_Lead_Router
             force-app/main/default/flows/Legacy_Lead_Router.flow-meta.xml
             In org: v1 Obsolete, v2 Active
  step       Back up 2 version(s) as JSON
  step       Deactivate version 2
  step       Delete version(s) 1, 2
  step       Verify the Flow is gone

Summary: 1 blocked, 1 ready
```

1. **Finds the Flows your story deletes.** Reads the diff between the story branch and its base branch. The base comes from the active Copado user story (`agentia cicd work set`), so there is nothing to configure.
2. **Checks the repository for references.** Any subflow, quick action, Lightning page, Flow test, Apex class, LWC or Visualforce page that still names the Flow at the story head marks it **BLOCKED**, with the file and line.
3. **Checks the org** (`--target-org`). Lists every version, the active one, and paused interviews. Paused interviews also block: deleting them would throw away work users have in progress.
4. **Plans.** Each Flow is READY, BLOCKED, ALREADY GONE, or NOT CHECKED (no org given).
5. **Sweeps** (`--apply`). For each READY Flow: saves every version as JSON, deactivates the active version, deletes every version, then re-reads the org to prove the Flow is gone. It stops at the first failure and says where.

```
SWEPT  Legacy_Lead_Router
  [ok] Back up versions: 2 version(s) saved to .flowsweep/backups/dev1/2026-10-21T09-12-03Z/Legacy_Lead_Router
  [ok] Deactivate: Version 2 deactivated
  [ok] Delete version 1
  [ok] Delete version 2
  [ok] Verify: Flow no longer in the org
```

## Install

Needs Node.js 22.12+, the [Agentia CLI](https://developer.copado.com/) 1.0.0-rc.0 or newer, the Salesforce CLI (`sf`), and Git.

```sh
git clone https://github.com/samyak619/agentia-plugin-flowsweep.git
cd agentia-plugin-flowsweep
npm install
npm run build
agentia plugins link . --no-install
agentia flow sweep --help
```

## Use

Run it inside the Git clone of your Copado pipeline, on a story branch.

```sh
agentia cicd work set US-0000024            # Copado picks the story and its branches

agentia flow sweep                          # report from the repository only
agentia flow sweep -o dev1                  # add org state: versions, active version, paused interviews
agentia flow sweep -o dev1 --apply          # back up, deactivate, delete, verify (asks first)
agentia flow sweep -o uat --apply --yes --json   # unattended, machine-readable
agentia flow sweep --check                  # exit 1 if anything is blocked: for git hooks and CI
agentia flow sweep -o dev1 --explain        # Copado Release agent writes a risk summary and go / no-go
agentia flow sweep --write-manifest destructive  # package.xml + destructiveChangesPost.xml
```

Run `--apply` once per org the story moves through (dev, then INT, UAT, production), or from the pipeline step that runs before each promotion.

### Flags

| Flag | What it does |
| --- | --- |
| `-o, --target-org` | `sf` alias or username of the org to check and, with `--apply`, to clean. |
| `--apply` | Delete the READY Flows in the target org. Asks for confirmation in a terminal. |
| `--yes` | Apply without asking. Required with `--apply` when there is no terminal or with `--json`. |
| `--check` | Exit with code 1 when any Flow is blocked. |
| `--explain` | Ask the Copado Release agent (`ai.ask`) for a release-risk summary. Uses AI quota. |
| `--base` | Base ref to diff against. Default: the story's base branch, then `main`, then `master`. |
| `--head` | Head ref. Default `HEAD`. |
| `--flow` | Also sweep this Flow API name even if the diff does not delete it. Repeatable. |
| `--ignore-references` | Report references as warnings instead of blockers. |
| `--backup-dir` | Where `--apply` writes version backups. Default `.flowsweep/backups`. |
| `--write-manifest` | Write a Metadata API destructive manifest for the sweepable Flows. |
| `--path` | Repository to inspect. Default: current directory. |
| `--json` | Machine-readable output. |

### Git hook

Stop a story from being pushed while a deleted Flow is still in use:

```sh
# .husky/pre-push  (or .git/hooks/pre-push)
agentia flow sweep --check
```

## How it works

```
 story diff (git)          repository at story head (git grep)        target org (sf + Tooling API)
       │                               │                                        │
 deleted *.flow-meta.xml  ──►  references by kind and line  ──►  versions, active version, paused interviews
                                       │                                        │
                                       └──────────────► plan ◄──────────────────┘
                                                         │  READY / BLOCKED / ALREADY GONE
                                                   --apply (READY only)
                                                         │
             GET each version (backup) → PATCH FlowDefinition activeVersionNumber=0
             → DELETE each Flow version → re-query → Flow gone
```

| Piece | Source |
| --- | --- |
| Active story, base branch | Agentia plugin host: `work.getWorkItem` |
| Risk summary | Agentia plugin host: `ai.ask` with the `release` agent |
| Deleted Flows | `git diff --name-status --no-renames <base>...<head>` |
| References | `git grep -w` at the story head over metadata, Apex, LWC, Aura, Visualforce |
| Org state | Tooling API `FlowDefinition`, `Flow`; data API `FlowInterview` |
| Changes | Tooling API through `sf api request rest` |

FlowSweep never receives Copado credentials. It uses the Agentia host API for Copado data and your existing `sf` login for the org, as the Agentia plugin guidelines require.

## Safety

- **Report first.** Nothing changes without `--apply`, and `--apply` asks unless you pass `--yes`.
- **Blocks instead of breaking.** References in the repository and paused interviews stop the sweep for that Flow.
- **Backups.** Every version is saved as JSON before it is touched.
- **Verifies.** After deleting, it re-reads the org and fails if the Flow is still there.
- **Fails loudly.** It stops at the first failed step for a Flow and exits non-zero.
- **No shell injection.** Flow names must be valid API names, SOQL values are checked, and on Windows any argument with cmd.exe metacharacters is refused instead of escaped.

## Compared with other tools

Deleting all versions of a Flow is a known Salesforce DevOps problem, and some tools outside Copado handle part of it: sfdx-hardis (destructive Flow handling and `hardis:org:purge:flow`), sfp (destructive Flow handling), and Gearset (a problem analyzer that lists all versions). FlowSweep is built for Copado users:

- It runs inside Agentia and reads the active Copado user story.
- It scans the story head for references and blocks before Salesforce fails.
- It refuses when paused interviews exist instead of deleting them.
- It backs up every version and verifies the result.
- It asks the Copado Release agent for a go / no-go summary.

## Limits

- Source Format pipelines only, like Agentia.
- Reference scanning is a whole-word text search, so a common word used as a Flow name can give false positives. Use `--ignore-references` after checking them.
- Tested with autolaunched Flows. Process Builder processes are stored as Flows too and should work the same way, but have not been tested. Managed-package Flows are ignored.
- Agentia plugins cannot yet wrap `cicd work commit` or `work submit`, so FlowSweep runs as its own command.

## Development

```sh
npm install
npm test          # builds, then runs node:test against dist/
agentia plugins link . --no-install
```

Tests cover diff parsing, reference search on a real temporary Git repository, planning, the manifest writer, and the full org sequence against a fake `sf`.

## License

MIT
