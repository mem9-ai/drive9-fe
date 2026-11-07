---
name: tidb-agent-workspace
description: Continue a TiDB Agent Workspace report across local coding agents, run its free public sales sample, or work with a selected private CSV or authenticated Workspace.
---

# TiDB Agent Workspace

Use the current project and the user's requested data. The public sample is a bounded demonstration, not access to their account or a general database. Private data belongs in [the private CSV workflow](private-csv.md); existing customer resources use [the authenticated API](workspace-api.md). Ask which source only when ambiguous.

The product and public skill are **TiDB Agent Workspace**. `drive9.ai` is the service domain. Older public URLs are compatibility aliases. Existing local `~/.drive9/` and `~/.agents/skills/drive9-workspace/` locations are retained deliberately so updates and other agents reuse the same credentials and reports; do not rename them.

## Public sample: reuse the installed Python helper

Requires Python 3.9.2+ and a usable native credential store: macOS Keychain, Linux Secret Service, or Windows Credential Manager. Check the actual environment; do not assume every Mac ships Python. Before invoking macOS `/usr/bin/python3`, confirm `xcode-select -p` succeeds so a system shim cannot prompt installation of developer tools. Do not install developer tools to continue. Reuse `~/.drive9/report-runtime/bin/python` (`Scripts/python.exe` on Windows) and `~/.agents/skills/drive9-workspace/report.py` if installed. If a compatible interpreter or native credential store is unavailable, explain what is missing and stop. Do not install/upgrade Python, switch runtimes, create another identity or use plaintext key storage to continue.

On first use, after confirming a compatible interpreter is already available (prefer an existing newer version), inspect and run [the official installer](https://drive9.ai/studio/skills/tidb-agent-workspace/install.py) with an existing compatible Python in isolated mode. It installs the helper and its private dependencies once, reuses a healthy environment on updates and preserves customized skill files. Its scope is the managed skill, one private Python environment and their dependencies; report commands use the selected project and native credential store. It never installs or upgrades Python itself. Reuse a verified installed helper without downloading and reviewing it again on each report. If dependency setup fails, report the failure and stop; do not change runtimes or retry installations repeatedly.

If the installed helper does not list `--json` in `--help`, update it once with the official installer to get the project-boundary fix. Preserve its existing environment and bindings. Otherwise reuse it.

Run the installed helper by absolute path from the current project:

```sh
/absolute/path/to/python -I /absolute/path/to/report.py start
```

Before running, tell the user in one short sentence where the report will be saved. The helper also prints the selected report folder before writing. It verifies the public sample, saves `reports/tidb-agent-workspace/report.md` and `us-sales.csv` in the project, and returns the confirmed result and read-only Studio link. The service provides canonical Markdown; don't replace it with another summary or add SQL during import. Do not upload other project files.

| User intent                                    | Helper action |
| ---------------------------------------------- | ------------- |
| First report or continue an existing one       | `start`       |
| Add the leading state's top product            | `products`    |
| Close every shared link for this report        | `unshare`     |
| Remove this project's local credential         | `forget`      |
| Explicitly start again after expiry or removal | `new`         |

Reuse an existing binding in this folder or its project parents first. Otherwise, the nearest Git project below the user's home is selected; without one, use the current folder. Never climb into `~/.git` or the filesystem root. `--project /absolute/project/path` selects that exact folder, without walking upward. When starting in the home/root folder, use a specific project folder; offer to create one if none was selected.

If the helper finds an older binding above the selected folder, present **Continue the existing report** or **Start a separate report here** using the host's native options (or two short choices in chat). Do not ask the user to type a path. For continuation, pass the returned previous folder as `--project` with the same action. Only an explicit choice to start separately permits `new --project <current folder>`; the old report and credential stay untouched. Do not move bindings or generate a key to fix a missing credential. Existing home-bound reports can still be reopened or forgotten explicitly.

The project root, service and OS user identify the binding; switching coding agents in that project reuses it. The default output is a brief result; add `--json` when structured fields or `insightsUrl` are needed. A `needs-project-choice` result exits with code 2 and supplies the two options. Preserve existing identity and files.

## Deliver the result and the next step

Answer the user's question in their language, using the confirmed output. Give the Studio link and one clickable local report link. Briefly state that anyone with the link can view until its displayed expiry and that the user can ask to close sharing. Keep installation logs, internal cache paths and raw JSON out of the final answer. If sharing was revoked, give only the retained local report. Never invent a link or claim an unconfirmed save.

Offer one relevant next action, without a fixed sales script: add the product breakdown if it is missing, compare the top two states if requested, or open the report in Workspace to explore the saved data. The returned `insightsUrl` is another view of the same report. The Studio page refreshes automatically; Workspace opens a copy of the canonical report and sample. Inside a temporary Workspace, **Save to TiDB Cloud** lets the user keep the files through sign-in or signup. Do not imply that this read-only link proves account ownership.

When the user is stuck, use the host's native options if available: **Continue the sample** or **Use my CSV**. An attached/named file is already a selection; resolve that file yourself. If no private source exists, invite an attachment or filename without demanding path syntax or listing limits. Do not repeat a picker for an already clear request.

For an agent handoff, open the same project in the other agent and ask it to follow this skill and continue the report. The next agent reads the stored binding and project files; it does not need the previous chat or another upload.

## Expiry, removal and safety

Public trial access and the read-only link end at the original 48-hour deadline. The helper keeps its signing key in the OS credential store, outside the project. Never display, export to a file, or commit it. Trial access cannot open customer Workspaces, upload private data or spend money. Private CSV and authenticated Workspace credentials keep their separate scope.

`unshare` closes links on the server, permanently for this trial, while preserving local files and editing access. `forget` only deletes the local credential; it does not close links. To do both, confirm `unshare` succeeded before `forget`. The next invocation removes an expired key; no background process is installed. Inactive keys may remain on disk after their server access has expired. Reports and CSVs remain local.

If the client reports an expired/forgotten trial or edited local files, preserve them and explain the recovery step. Only `new` on the user's explicit request starts another trial. Existing Keychain trials need their store unlocked; do not silently switch identities. A missing or locked credential store stops the workflow. Never replace secure storage with a file.
