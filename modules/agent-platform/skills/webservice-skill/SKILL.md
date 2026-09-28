---
name: webservice-skill
description: Develop and operate reloadable business plugins under FASTSITE_EXTENSIONS_DIR through Fastsite. Use when asked to write, modify, add, validate, reload, inspect status, or troubleshoot a webservice plugin, page, API endpoint, template, static asset, or plugin load failure.
---

# Webservice Skill

`FASTSITE_EXTENSIONS_DIR` is the absolute root of reloadable business plugins; production sets it to `/app/workspaces/webservice/plugins`. Never infer plugin availability from a relative `webservice/plugins` directory in the current Agent workspace. This skill is for online-model plugin development and operations: write or add a plugin, validate it, explicitly request a reload without interrupting active requests, inspect its runtime state, and repair a failed release. Use `python3 -m fastsite.cli validate-plugins` for local validation and the authenticated Fastsite reload endpoint for cross-container reloads. The endpoint invokes the existing `fastsite.cli reload` workflow inside the Fastsite process container. Read [plugin-contract.md](references/plugin-contract.md) before changing a plugin.

It does not change Fastsite core code, Gunicorn configuration, deployment topology, or database configuration.

## Runtime Variables

Peri and Fastsite run in different containers. Use each injected variable only for its declared boundary:

| Variable | Purpose in Peri | Production example | Never use it for |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | Build browser-facing Fastsite page URLs and plugin API response URLs | `http://10.120.92.138:3022` | Internal health checks, publication, source paths |
| `FASTSITE_STATUS_URL` | Call Fastsite health, ready, plugin API, static checks, and publication routes | `http://172.27.0.10:3003` | Browser iframe URLs, filesystem access, reload endpoint construction |
| `FASTSITE_EXTENSIONS_DIR` | Read or modify the absolute shared plugin source directory and run local validation | `/app/workspaces/webservice/plugins` | Service availability checks, HTTP URLs |
| `FASTSITE_RELOAD_URL` | Base URL for the authenticated reload endpoint | `http://172.27.0.10:3003/internal` | Normal plugin APIs, browser iframe URLs |
| `FASTSITE_RELOAD_TOKEN` | Bearer credential for an explicit reload request | injected secret | Output, logs, query strings, plugin source |

Operational mapping:

```sh
# Service status and plugin presence
curl -fsS "${FASTSITE_STATUS_URL%/}/healthz"
curl -fsS "${FASTSITE_STATUS_URL%/}/readyz"

# Plugin publication or internal API
curl -X PUT "${FASTSITE_STATUS_URL%/}/<plugin-api-route>" ...

# Plugin source and validation
test -d "$FASTSITE_EXTENSIONS_DIR/<plugin-id>"
python3 -m fastsite.cli validate-plugins --extensions-dir "$FASTSITE_EXTENSIONS_DIR"

# Reload only after the user explicitly requests it
curl -X POST \
  -H "Authorization: Bearer $FASTSITE_RELOAD_TOKEN" \
  "${FASTSITE_RELOAD_URL%/}/reload"

# Final browser delivery
printf '<iframe src="%s/<plugin-page-route>" width="100%%" height="760"></iframe>\n' "${PUBLIC_BASE_URL%/}"
```

`FASTSITE_PID_FILE` belongs to the Fenix/Fastsite container and must not be read, mounted, or signaled from Peri. `PUBLIC_BASE_URL` is the public Fastsite origin used by the skill and plugins; Fenix does not provide or reconstruct it. Never inspect a relative `webservice/` directory: source operations start at `FASTSITE_EXTENSIONS_DIR`, and deployment status comes from `FASTSITE_STATUS_URL`.

## Browser Delivery

The final assistant response for a live Fastsite page is one complete iframe. Build its `src` from the injected `PUBLIC_BASE_URL` plus the verified plugin-relative route.

```html
<iframe src="${PUBLIC_BASE_URL}/<plugin-route>" width="100%" height="760"></iframe>
```

For a parameterized page, URL-encode values and HTML-escape query separators as `&amp;` inside the iframe attribute:

```html
<iframe src="${PUBLIC_BASE_URL}/flight-routes?query_mode=fp_id&amp;fp_id=abc123" width="100%" height="760"></iframe>
```

`${PUBLIC_BASE_URL}` in the examples denotes the runtime value and must be expanded before the final response. Never emit that literal placeholder and never hardcode an IP address or port in a plugin, template, browser JavaScript, or skill.

### Inner Page URLs

`PUBLIC_BASE_URL` must **not** be used to build a page's own API calls, static-report URLs, nested iframe `src`, JavaScript assets, or other resources served by the same plugin. These are browser-internal resources and must use plugin-relative paths, for example:

```js
fetch('/flight-routes/{query_id}/sorties/{fp_id}/track')
frame.src = '/flight-reports/static/guangdong-daily/20260814'
```

An absolute/root-relative path is resolved against the iframe document's own origin, never the Fenix parent page. This prevents a stale `PUBLIC_BASE_URL` from sending a nested request to an old port. Use a path relative to the plugin mount when the deployment has a non-root path prefix.

For interactive pages, prefer `fetch` JSON APIs and update the existing DOM. Do not rely on native form POST navigation inside an iframe; it can reset the page in an embedding renderer. Keep a server-rendered form route only as an optional direct-browser fallback. If native form submission remains available, the outer iframe still needs `allow-forms`.

For an existing Fastsite page, emit its complete iframe as the final response. Do not `curl` an internal page into `/tmp`, copy it to `user/`, save it as an HTML file, or invoke `show-html-or-picture`; those steps are only for local static artifacts, not live webservice pages. This is a hard delivery rule and overrides the normal local-HTML rendering procedure. Use `FASTSITE_STATUS_URL` only for internal API, health, validation, or status calls, and `FASTSITE_RELOAD_URL` only for authenticated reload requests. If a plugin API returns `calendar_url`, `report_url`, `page_url`, or a similar public URL, verify that it uses the configured `PUBLIC_BASE_URL` before using it.

For a live webservice page, output exactly one physical line containing one raw iframe and nothing else. Do not wrap it in a code fence, Markdown, backticks, quotes, a span, or explanatory text.

### Iframe Output Integrity

Before sending the final response, verify the literal output starts exactly with `<iframe `, ends with `</iframe>`, and contains no newline.

- The `src` must start with the expanded `${PUBLIC_BASE_URL%/}/`; never use `FASTSITE_STATUS_URL` as a browser URL.
- URL-encode user values and use `&amp;` between query parameters in the HTML attribute.
- Do not emit `&lt;iframe`, `<span`, backticks, a fenced code block, or text outside the iframe.
- Fenix ignores model-supplied sandbox permissions and applies its own fixed sandbox, loading behavior, dimensions, and expansion controls.

## Plugin Public URLs

Inspect a plugin API's returned public URL and verify its origin matches `PUBLIC_BASE_URL`. Build the final iframe from the configured `PUBLIC_BASE_URL` and the verified path/query; never infer an origin from an old generated page or browser DevTools.

Plugin Python code and final assistant delivery both read `PUBLIC_BASE_URL` from the environment. Plugins that serve only same-origin routes must use relative paths internally. A normal Fastsite reload does not apply a changed process environment; a deployment-managed service restart is required before process environment changes take effect.

## Status Check

Check the current host before and after every release:

```sh
curl "${FASTSITE_STATUS_URL%/}/healthz"
curl "${FASTSITE_STATUS_URL%/}/readyz"
```

`FASTSITE_STATUS_URL` is the internal Fastsite address reachable from Peri, normally `http://172.27.0.10:3003`. It is not the browser URL. `healthz` confirms that the host is alive. `readyz` is the release result: record `worker.boot_id`, verify that `extensions` contains the expected plugin ID, and compare its `plugin_sha256` after reload. If a plugin is absent, do not reload again blindly; run validation and inspect its reported error.

## Release Preconditions

Before validating or reloading any plugin, verify the required runtime settings:

```sh
test -n "$PUBLIC_BASE_URL" || { echo "PUBLIC_BASE_URL is not configured"; exit 1; }
test -n "$FASTSITE_EXTENSIONS_DIR" && test -d "$FASTSITE_EXTENSIONS_DIR" || { echo "FASTSITE_EXTENSIONS_DIR is missing"; exit 1; }
test -n "$FASTSITE_STATUS_URL" || { echo "FASTSITE_STATUS_URL is not configured"; exit 1; }
test -n "$FASTSITE_RELOAD_URL" || { echo "FASTSITE_RELOAD_URL is not configured"; exit 1; }
test -n "$FASTSITE_RELOAD_TOKEN" || { echo "FASTSITE_RELOAD_TOKEN is not configured"; exit 1; }
```

Peri and Fastsite run in different containers and PID namespaces. Never read or mount the Gunicorn PID file into Peri and never send process signals from the sandbox. The authenticated Fastsite endpoint invokes `fastsite.cli reload` in Gunicorn's container and owns that operation.

## Explicit Reload Request

When the user explicitly says “重载 webservice” or asks to reload a plugin, perform the controlled workflow directly; do not merely describe the command and do not send Gunicorn signals yourself:

```sh
test -n "$PUBLIC_BASE_URL" || { echo "PUBLIC_BASE_URL is not configured"; exit 1; }
test -n "$FASTSITE_RELOAD_URL" && test -n "$FASTSITE_RELOAD_TOKEN" || { echo "Fastsite reload endpoint is not configured"; exit 1; }
python3 -m fastsite.cli validate-plugins --extensions-dir "$FASTSITE_EXTENSIONS_DIR"
reload_result="$(curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $FASTSITE_RELOAD_TOKEN" \
  "${FASTSITE_RELOAD_URL%/}/reload")" || {
  printf '%s\n' "$reload_result"
  exit 1
}
printf '%s\n' "$reload_result"
printf '%s' "$reload_result" | jq -e '.ok == true and .phase == "ready"' >/dev/null
```

Do not issue this request merely because files changed. Run it only when the user explicitly requests a webservice reload. If validation fails, stop before the request and return the JSON error. If reload succeeds, return the new `worker.boot_id` and loaded plugin IDs from its JSON result.

## Workflow

Use todos and complete these steps in order:

1. Inspect the target plugin, its `manifest.json`, `plugin.py`, templates, and related skill. Reuse the existing plugin unless the request is a separate business capability.
2. For a new plugin, create `$FASTSITE_EXTENSIONS_DIR/<plugin-id>/manifest.json` and `plugin.py`; use a non-empty default `mount_path`. Use `"mount_path":""` only for a deliberate root route.
3. Declare every public route in `ROUTES`, implement `register_routes(router, context)`, and keep database access inside the plugin only when the business contract permits it. `register_routes` owns HTTP routes only; scheduled work belongs in the optional `register_jobs` function.
4. A plugin with scheduled work may optionally implement `register_jobs(registry, context)`. Use `registry.add_cron(extension_id=context.extension_id, name="job_name", func=callable, hour=6, minute=0)`. Do not create an APScheduler instance inside a plugin. Fastsite owns one `BackgroundScheduler`, runs jobs outside the request event loop, and waits for running jobs during shutdown. Job names must be stable and unique within the plugin; Fastsite prefixes them with the plugin ID and uses a SQLite owner lease with heartbeat across worker reload overlap.
5. When a page needs JavaScript or CSS libraries, publish built files in the owning plugin's `static/` directory and mount them with `StaticFiles`. Read the static-assets section in [plugin-contract.md](references/plugin-contract.md).
6. Keep runtime data outside release files. Do not commit credentials, database TOML, SQLite databases, logs, `node_modules`, `__pycache__`, or generated browser payloads.
7. Run local syntax checks and `python3 -m fastsite.cli validate-plugins --extensions-dir <plugins-dir>`.
8. If validation fails, read its JSON error, repair the plugin, and repeat validation. Do not reload a failing release.
9. Verify `PUBLIC_BASE_URL`, `FASTSITE_STATUS_URL`, `FASTSITE_RELOAD_URL`, and `FASTSITE_RELOAD_TOKEN`. If any check fails, stop and return the failed prerequisite.
10. Check `${FASTSITE_STATUS_URL%/}/readyz`, record the old Worker `boot_id`, then send one authenticated `POST ${FASTSITE_RELOAD_URL%/}/reload` request.
11. Treat only `{"ok": true, "phase": "ready"}` as a successful release. Confirm the returned Worker `boot_id` differs from the old one, the intended plugin appears in `/readyz.extensions`, and any expected jobs appear in `/readyz.scheduled_jobs`.

## Boundaries

- Do not modify host-core code, host configuration, or database configuration while adding a business plugin.
- Do not run process or signal commands from Peri. Use the authenticated Fastsite reload endpoint, which runs `fastsite.cli reload` in Gunicorn's container and waits for a new ready Worker.
- Do not add unrestricted SQL endpoints or execute user-provided SQL. Use bounded, business-specific queries and parameterized SQL.
- Do not place passwords, API keys, or connection strings in plugin source, templates, or `manifest.json`.
- Do not run `npm install` or download browser libraries at service startup. Build them before release and publish only the static output.
- Do not claim a release succeeded until reload returns `{"ok": true, "phase": "ready"}`.
- Do not treat `healthz` alone as a successful plugin release; use `readyz` and the reload JSON result.

## Existing Patterns

- `flight-route` is a dynamic business plugin. Its `register_jobs` schedules a daily 06:00 `create_time` incremental sync into a lightweight SQLite sortie index. List pages use `after_fp_id` cursor pagination directly on that index by `time_stamp` date, with no page cache, and retain a bounded Doris fallback outside index coverage; selected tracks query Doris on demand and are never stored in SQLite.
- `flight-report` is a report container. Add new report types beneath this plugin instead of creating one plugin per report. It publishes and serves static report HTML; business skills own Doris queries, SQLite caches, metric calculation, and report generation.
- Use `context.services.connection("doris")` only for plugin endpoints that are explicitly allowed to query Doris, and return the borrowed connection through a `with` block.
- A dynamic query page may write business-owned SQLite history or cache data. Validate all business parameters, bound time windows and result sizes, and retain only the data needed for the user workflow.
- Templates belong beneath the owning plugin and should be rendered through that plugin's router.
