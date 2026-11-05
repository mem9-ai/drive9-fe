---
name: drive9-workspace
description: Start or continue a free Drive9 public US sales report in this project, including a report created by another local coding agent. Also use for explicit file and database tasks with an existing Workspace Key.
---

# Drive9 Workspace

## Free public sales report

For the Studio free-trial prompt or a request to continue its sales report, use the project you are already in. The public sample requires no account, Workspace Key or payment method. Use only the public US sales fixture. Previous chat history is optional.

1. Locate the installed helper at `~/.agents/skills/drive9-workspace/report.py` and its isolated Python under `~/.drive9/report-runtime/` (`bin/python` on macOS/Linux or `Scripts/python.exe` on Windows). On first use, download [the official installer](https://drive9.ai/studio/skills/drive9-workspace/install.py) over HTTPS to a temporary file. Inspect it and run it with Python 3.10+ in isolated mode (`python3 -I <downloaded-file>`, or `py -3 -I <downloaded-file>` on Windows), respecting the host's normal installation permissions. Agents that do not discover this skill automatically can follow the linked instructions directly and invoke the same helper by its absolute path.
2. Invoke that isolated Python with `-I`, the absolute helper path and `start` in the current project. To add the leading state's top product to the same report, use `products`. Reuse the same directory or pass `--project` with its path. The helper owns the OS credential, verifies the input, computes the totals and reads the saved report back.
3. Return the actual result, calculation, and a clickable absolute local file link from the JSON `report` field. For `synced`, return the clickable `studioUrl` labeled “View report in Studio” (or “在 Studio 查看报告”), the local Markdown, and the original expiry in the user's timezone. Anyone with that link can read the latest saved version until expiry. After a continuation, return the same link. If an older installed helper reports `synced` without `studioUrl`, update it once with the official installer from step 1 and repeat the same command in the same project. Never invent a URL or present a local-only result as viewable in Studio. After the first report, offer one follow-up they can paste into another local coding agent with the same project open: “Follow https://drive9.ai/studio/skills/drive9-workspace/SKILL.md to continue my Drive9 sales report in this project and add the top product in the leading state.” For `local-only`, explain the reported limitation; do not describe the result as remotely saved. Expired and forgotten bindings keep the local Markdown. Access expires 48 hours after registration. The next invocation for this project clears an expired key; `forget` removes it early. Only run `new` if the user explicitly wants a separate trial after expiry or removal.

When the task calls for a private Workspace or spending, explain that a trial grants neither. Keep using the following authenticated API flow for existing customer integrations.

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
