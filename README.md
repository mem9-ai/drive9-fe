# Drive9 website

The existing website is plain HTML in `site/`. Its homepage is `site/index.html`;
there is no React router for the marketing pages.

## Studio build

`studio/` is a Git submodule of `mem9-ai/tidb.ai`, pinned to an explicit revision.
It supplies the Console source without copying its implementation into this repo.
Use Node 24.22.1 and npm 11.6.2, as required by that application.

```sh
git submodule update --init
npm ci --prefix studio
npm run build:console --prefix studio -- --base=/studio/
STUDIO_API_ORIGIN=https://api.example.invalid node scripts/prepare-studio.mjs
node --test scripts/prepare-studio.test.mjs
```

The example origin is a placeholder, not a working backend. Set the real public
HTTPS API origin privately in the deployment environment. Do not include a path,
trailing slash, credentials, or query string. Generated `site/studio/` and
`site/_redirects` are ignored by Git. The homepage, downloads and documentation
remain in `site/`; only the Console's static output is copied under `/studio/`.

## Netlify

Keep the package directory set to `site`, with the base directory unset. The
checked-in `site/netlify.toml` builds from the repository root and publishes `site`.
Before enabling this build:

1. Give Netlify read-only access to the private `tidb.ai` submodule using a
   [Netlify deploy key](https://docs.netlify.com/build/git-workflows/repo-permissions-linking/#deploy-keys).
   Never put a private key or GitHub token in a repository URL.
2. Set the build variable `STUDIO_API_ORIGIN` to the deployed backend's public
   HTTPS origin. It is routing configuration, not a place for secrets. A missing
   or invalid value fails the build instead of publishing a loopback/demo target.
3. Deploy the API independently using the application's deployment requirements.
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

The pinned application includes [SSO PR #2](https://github.com/mem9-ai/tidb.ai/pull/2)
and [public-path PR #3](https://github.com/mem9-ai/tidb.ai/pull/3). Review and land
those application changes before enabling this website build. Live OAuth
configuration is separate from this website PR.
After deploying, verify the homepage, a direct Studio refresh, JS/CSS loading,
API error responses, login callback and logout on the actual Netlify domain.
Local build/tests do not constitute live OAuth or Netlify deployment acceptance.
