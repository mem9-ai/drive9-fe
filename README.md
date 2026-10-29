# Drive9 website

The existing website is plain HTML in `site/`. Its homepage is `site/index.html`;
there is no React router for the marketing pages.

## Studio build

`vendor/studio/` contains the Console's built static files. The source repository,
full commit, Node/npm versions, build command and SHA-256 for every file are in
`vendor/studio-build.json`. These files are reviewed and committed together.
Netlify verifies the files, copies them under `site/studio/` and generates routing;
it does not fetch `tidb.ai`, install its dependencies or need a private deploy key.
There is no Git submodule or automatic cross-repository update in this workflow.

To prepare a website checkout with Node 24.22.1:

```sh
node --test scripts/*.test.mjs tests/*.test.mjs
STUDIO_API_ORIGIN=https://api.example.invalid node scripts/prepare-studio.mjs
```

The example origin is a placeholder, not a working backend. Set the real public
HTTPS API origin privately in the deployment environment. Do not include a path,
trailing slash, credentials, or query string. Generated `site/studio/` and
`site/_redirects` are ignored by Git. The homepage, downloads and documentation
remain in `site/`; only the Console's static output is copied under `/studio/`.

### Updating Studio

Use an authorized local checkout of `mem9-ai/tidb.ai`, Node 24.22.1 and npm 11.6.2.
Choose a reviewed full source commit. Export it into an empty directory so local
untracked files, `.env` files and provider configuration cannot enter the build.
From this website repository, reproduce the recorded version as follows:

```sh
studio_revision=$(node -p "require('./vendor/studio-build.json').commit")
studio_source=$(mktemp -d)
git -C /path/to/tidb.ai archive "$studio_revision" | tar -x -C "$studio_source"
(
  cd "$studio_source"
  env -i HOME="$HOME" PATH="$PATH" npm ci --no-audit --no-fund
  env -i HOME="$HOME" PATH="$PATH" npm run build:console -- --base=/studio/
)
node scripts/studio-artifact.mjs "$studio_source/dist/console" "$studio_revision"
node --test scripts/*.test.mjs tests/*.test.mjs
```

For an update, set `studio_revision` to the newly reviewed full commit instead.
The import command accepts only Console HTML, its favicon, JS/CSS/font assets and
config; it rejects source maps, unexpected files and symlinks. It replaces the
local demo config with the same-origin `/studio` config and removes stale assets.
Review the complete artifact and manifest diff, including a secret/internal-data
scan, before committing. File hashes detect drift, not whether a bundle is safe.
To check reproducibility, rebuild from a second clean export and compare the file
hashes after the same config normalization. Only static files are published; the
source manifest lives outside `site/`. Remove the temporary export when finished.

## Netlify

Keep the Netlify project's **base directory set to `site`**. The checked-in
`site/netlify.toml` runs tests and preparation via `../scripts/` and publishes
`.` (the current `site` directory). Publish paths are relative to the base,
so setting publish to `site` would incorrectly select `site/site`.
Only access to this website repository is needed.

The `tests/netlify-build.test.mjs` integration test executes the configured command
from `site` in a temporary checkout and checks the published output and missing
origin failure. It lives outside the build's `scripts/*.test.mjs` glob to avoid
recursively running itself.

Set `STUDIO_API_ORIGIN` in the Netlify project's environment variables, with the
Builds scope and the deploy contexts you intend to publish (Production for the
live site). A missing/invalid origin or modified/incomplete artifact fails the
build. Rebuild after changing the variable. No GitHub App, private submodule key
or new Netlify deployment token is required by this build.

Deploy the API independently using the application's deployment requirements.
This repository does not run the API, provision storage or configure OAuth.

The generated [rewrite rules](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)
keep the Console's current public API contract:

| Browser path | Destination |
| --- | --- |
| `/studio` | Redirect to `/studio/` |
| `/studio/assets/*` | Built static files |
| `/studio/*` | Console entry, only when no file matches |
| `/studio/config.json` | Studio configuration, `apiOrigin: ""`, `apiPathPrefix: "/studio"` |
| `/studio/api/*` | API origin, preserving `/api/*` |
| `/studio/openapi.json` | API schema |

All Studio routes stay under `/studio`; website root API/config paths are untouched.
There is no global SPA fallback: existing pages and unknown non-Studio paths
retain their original behavior. API errors must remain API errors rather than HTML.

For TiDB Cloud SSO, register the callback
`https://drive9.ai/studio/api/auth/tidbcloud/callback` and set the backend's post-login
URL to `https://drive9.ai/studio/`. Set `WORKSPACE_PUBLIC_PATH=/studio` on the backend so session and login-flow cookies
use the same prefix. The gateway removes `/studio` when forwarding to the backend;
its internal routes stay unchanged. Keep OAuth secrets and owner allowlists
only in the backend's private runtime configuration. Verify the backend's public
origin, proxy trust and secure-cookie settings before enabling it for users.

The pinned application includes the merged SSO and public-path support. Live OAuth
configuration is separate from publishing these static files.
After deploying, verify the homepage, a direct Studio refresh, JS/CSS loading,
API error responses, login callback and logout on the actual Netlify domain.
Local build/tests do not constitute live OAuth or Netlify deployment acceptance.
