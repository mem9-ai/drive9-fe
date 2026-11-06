# Authenticated Workspace

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
