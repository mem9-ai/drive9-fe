---
name: tidb-agent-workspace
description: Start or continue a free TiDB Agent Workspace public US sales report in this project, including a report created by another local coding agent. Upload an explicitly selected private CSV into an independent 48-hour workspace without login, or resume that project’s stored CSV. Also use for authenticated file and database tasks.
---

# TiDB Agent Workspace

If a user returns to a private CSV, use the private workflow even when they call the result a sales report. If the source is ambiguous and both kinds of report exist, ask which one to continue before opening or creating anything.

## Free public sales report

For the Studio free-trial prompt or a request to continue its sales report, use the project you are already in. The public sample requires no account, Workspace Key or payment method. Use only the public US sales fixture. Previous chat history is optional.

1. Locate the installed helper at `~/.agents/skills/drive9-workspace/report.py` and its isolated Python under `~/.drive9/report-runtime/` (`bin/python` on macOS/Linux or `Scripts/python.exe` on Windows). On first use, download [the official installer](https://drive9.ai/studio/skills/drive9-workspace/install.py) over HTTPS to a temporary file. Inspect it and run it with Python 3.10+ in isolated mode (`python3 -I <downloaded-file>`, or `py -3 -I <downloaded-file>` on Windows), respecting the host's normal installation permissions. Agents that do not discover this skill automatically can follow the linked instructions directly and invoke the same helper by its absolute path.
2. Invoke that isolated Python with `-I`, the absolute helper path and `start` in the current project. To add the leading state's top product to the same report, use `products`. Reuse the same directory or pass `--project` with its path. The helper owns the OS credential, verifies the input, computes the totals and reads the saved report back. It already saves the local Markdown and sample. Create extra project files only if requested.
3. Use the returned `status` and saved `version` to finish the conversation in the user's language. Base all numbers on the helper's verified result.

**Saved report (`synced`).** Lead with the finding and its calculation in one sentence. Give the clickable `studioUrl` (“View report in Studio”) and a single “Local Markdown” link using the absolute `report` path. Describe the Studio link as read-only to anyone with the link until the original expiry in the user's timezone. Use descriptive labels so internal paths stay out of the reply.

- **Version 1:** End with one question the user can accept right here, naming the leading state: “Want me to add California’s top product and its share of the state’s sales to this report?” Wait for their answer. A “yes”, “好” or equivalent in context means run `products` in this same project. No copy/paste, tool switch or repeated setup is needed.
- **Version 2 (including reopening a completed report):** Give the verified product, sales and share. On an update, tell the user the finding is now in the same report and return the original Studio link. On a reopen, describe what is already there. Direct them to **Continue with TiDB Cloud** on the report: sign in or create an account to open their own Workspace with the report and sample already saved. They can then choose **Connect my agent** or **Explore sample data**. Offer the in-chat sample comparison only when they want more analysis; avoid repeating a completed question.
- **Top-two-states question, including Copy next question:** Run `start` in the same project to reopen the verified report. Give the calculation, the returned `insightsUrl` labeled “View this analysis in Studio”, and the local Markdown link. If `insightsUrl` is missing, update the helper once with the official installer and repeat `start`. This link shows the comparison computed from the same saved state totals; it does not create another report or extend access. End with one concrete next step: “Open the report and choose Continue with TiDB Cloud to sign in or create an account. Your report and sample data will be ready in your workspace; then choose Connect my agent to keep working.” Do not end with only a local file or another open-ended question. The report can still be read without login; account continuation is the user's choice.
- **Switching agents:** Only when the user wants a handoff, give one portable prompt for another local agent in the same project: “Follow https://drive9.ai/studio/skills/drive9-workspace/SKILL.md to continue my TiDB Agent Workspace sales report in this project and add the top product in the leading state.” The first-version Studio report also offers a copyable follow-up.
- If an older helper returns `synced` without `studioUrl`, update it once with the official installer and repeat the same command in the same project. Only show a Studio link returned by the helper.

**Local or unavailable report.** For `local-only`, link the actual local file, explain what prevented a confirmed remote save, and give the recovery step from the helper's message. For `expired` or `forgotten`, offer the retained Markdown if available. Access expires 48 hours after registration. The next invocation for this project clears an expired key; `forget` removes it early. Only run `new` when the user explicitly requests a separate trial after expiry or removal.

When the task calls for an existing customer Workspace or spending, explain that a trial grants neither. Keep using the following authenticated API flow for existing customer integrations.

## In-chat choices

At a missing-file prompt, when the user is stuck on what to do next, or after the completed sample, offer one question in their language: “What would you like to do next?” Use the agent host’s native choice picker when available. Otherwise show the same numbered options in chat and invite a number, a label, or a file:

1. **Compare the top two states** — see their share of total sales in the public sample.
2. **Use my sales CSV** — continue with my saved data, or attach a CSV here.

Wait for a selection. Accept a click, “1” or “2”, the option in the user’s words, or an attached/named CSV. A highlighted default is not a selection.

- **Sample:** Complete the top-two-states workflow above, including its online analysis link and account continuation. Use the existing project binding; don't create a separate trial for a report that can be resumed.
- **My CSV:** Use the selected file or resume the project’s existing private CSV. If the source is still missing, say “Attach your CSV here, or tell me its filename.” A file supplied with the selection is enough to proceed. Do not show the menu again while waiting for the file.

Skip the picker for a selected file, a usable saved source on a continuation request, an explicit sample request, or the copied Studio question with a usable fallback. Proceed with the request. A problem reading an existing file calls for recovery of that file.

## My own CSV, without an account

If no file was selected and the private state directory (`~/.drive9/private-csv/`) does not exist, go straight to the no-file response below. This also works on a new machine before installing anything. Otherwise use the isolated Python described above. If `private_csv.py` is missing or predates the `needs-file` result, update once with the current official installer. Run the sibling `private_csv.py` with `-I` in the user's project. Authenticate only through the helper and OS credential store.

- **File selected.** An attachment, a file reference or an unambiguous filename in the project is a selection. Resolve it yourself and run `upload <path>`. For a filename, look only for that name in the project; if several match, let the user choose by short folder name. Never pick a different file or scan the project for upload candidates. The first upload opens a private 48-hour Workspace.
- **No file selected.** Resume the saved CSV in this project. On `needs-file`, follow the user's request in the language of the conversation:
  - A copied Studio question about the public sample belongs to the public workflow above. It needs no private CSV. A request explicitly limited to calculation in chat can use the supplied figures directly.
  - When a private request is stuck waiting for a file, offer the in-chat choices above. If the user has already selected “Use my sales CSV” from that menu, just invite the attachment or filename.
  - Keep credential state and path syntax out of the handoff. Explain a size or encoding limit only if it actually blocks the selected file. A failed resume of an existing source is a recovery case; report it rather than silently switching data.
- **Continue.** Run `resume` without a path, including in another local agent in the same project. Use the returned absolute `source` path for the requested analysis. The helper checks the current remote file, restores a missing local copy and reuses unchanged content. Reopening a completed report is a read.
- **Report.** Answer the user's question using the selected data. Save or update the project's local Markdown report, then return a clickable local file link. Keep private results out of public sample links. For a failed or missing upload, report what actually succeeded.
- **File changes.** Use `replace <path>` only when the user explicitly selects a replacement. If the current version changed, resume and reconcile before retrying. An expired binding ends remote access and retains local files. Only start another timed Workspace with `new <path>` on explicit request. `forget` removes the local credential.

## Authenticated Workspace

The task supplies the Global API endpoint and identifies the resources and work requested.
Read `WORKSPACE_API_KEY` from the environment or the user's secret manager. Never print it,
put credentials in URLs or source files, or send the Key or Global Token to a Region endpoint.
Do not create, change, or delete data unless requested. Respect the Key's resource and action
permissions. If network access or required permissions are missing, explain the error and stop.

## Connect

1. At the Global API endpoint, `POST /v1/token-issuances` with the Key as Bearer and JSON
   `{"audience":"global"}`. Keep the returned `workspaceId` and `accessToken` in memory.
2. With that Global Token, `GET /v1/workspaces/{workspaceId}/region-route`. Do not follow the
   307 redirect. Record `Location` and `X-Region-Id`.
3. At the Global API endpoint, issue a Region Token with the Key and `{"audience":"region"}`.
   Verify the response's region origin, path, and ID match the redirect. Require HTTPS except
   for an explicitly loopback development endpoint.
4. Send the Region Token as Bearer to the verified Region origin and path followed by
   `/api/v1/workspaces/{workspaceId}`. Request a new token if it expires. Do not forward the
   Key or Global Token to this endpoint. `GET /context` shows the available permissions;
   `GET /resources` lists permitted resources.

## Work with files

- `GET /files?resourceId=RESOURCE_ID` lists files. For a bounded text preview, use
  `GET /files/content?resourceId=RESOURCE_ID&path=ENCODED_PATH&preview=1` and check
  `unavailableReason`. Original downloads through `/files/content` are for Drive9 resources;
  local demo file listings include UTF-8 content.
- To analyze a CSV with read-only SQL, `POST /file-analyses` with JSON
  `{"resourceId":"RESOURCE_ID","path":"/example.csv","engine":"duckdb","sql":"SELECT count(*) AS n FROM file"}`.
  Replace the example values with the selected resource, file, and requested SQL. The selected
  file is the SQL table `file`. Inspect the response rows and errors; do not invent results.
- Before writing, `GET /files/metadata?resourceId=RESOURCE_ID&path=ENCODED_PATH`. To create
  an absent file, `PUT /files` with `If-None-Match: *` and JSON
  `{"resourceId":"RESOURCE_ID","path":"/report.md","type":"file","content":"REPORT"}`.
  For an explicitly requested update, use `If-Match` with the current metadata version. If a
  write's outcome is uncertain, inspect the destination rather than blindly retrying it.

## Work with databases

`GET /resources/{resourceId}/tables` lists permitted tables. `POST /queries` executes one SQL
statement; use `readOnly: true` for reads. Do not blindly retry an uncertain write. Database
access needs a separate resource grant and query permission; file analysis uses file permissions.
