# Plugin Contract

## Layout

```text
$FASTSITE_EXTENSIONS_DIR/<plugin-id>/
  manifest.json
  plugin.py
  templates/             # optional
  static/                # optional
```

`manifest.json` must contain only `id`, `api_version`, `entry`, and optional
`mount_path`:

```json
{"id":"example","api_version":1,"entry":"plugin.py","mount_path":"/extensions/example"}
```

`id` is lowercase letters, digits, and hyphens; it must start with a letter.
`entry` is a Python file in the plugin root. `mount_path` defaults to
`/extensions/<id>` and must be unique. Root mounting is exceptional.

## Entry Module

Every entry module must declare `ROUTES` and a callable
`register_routes(router, context)`. `ROUTES` is the release contract used by preflight
and reload status; include each public path and its uppercase methods.

```python
from fastapi import APIRouter
from fastsite import ExtensionContext

ROUTES = ({"path": "/status", "methods": ("GET",)},)

def register_routes(router: APIRouter, context: ExtensionContext) -> None:
    @router.get("/status")
    def status() -> dict[str, str]:
        return {"extension": context.extension_id, "status": "ok"}
```

For an extension mounted at `/extensions/example`, this is exposed as
`/extensions/example/status`.

## Static Assets

Put browser-ready JavaScript, CSS, images, and fonts in the owning plugin. Do
not put `node_modules` in a plugin release.

```text
$FASTSITE_EXTENSIONS_DIR/example/
  plugin.py
  templates/index.html
  static/
    app.8f3d2.js
    app.8f3d2.css
    vendor/echarts.min.js
```

Mount the directory with a plugin-specific route name and declare the public
asset path in `ROUTES`:

```python
from fastapi.staticfiles import StaticFiles

ROUTES = (
    {"path": "/page", "methods": ("GET",)},
    {"path": "/assets/{path:path}", "methods": ("GET", "HEAD")},
)

def register_routes(router, context):
    router.mount(
        "/assets",
        StaticFiles(directory=context.extension_dir / "static"),
        name=f"{context.extension_id}-assets",
    )
```

Render template asset URLs through `request.url_for`, not hard-coded root paths:

```html
<link rel="stylesheet" href="{{ request.url_for('example-assets', path='app.8f3d2.css') }}">
<script src="{{ request.url_for('example-assets', path='vendor/echarts.min.js') }}"></script>
<script src="{{ request.url_for('example-assets', path='app.8f3d2.js') }}"></script>
```

For a browser-facing URL returned by an API, derive it from
`context.settings.public_base_url`. Docker sets this through
`PUBLIC_BASE_URL`; do not hard-code an IP address or port. Keep API
calls and browser-facing URLs separate: Peri uses `FASTSITE_STATUS_URL` for internal calls, while browser-facing URLs use `PUBLIC_BASE_URL`.

Build npm dependencies before release, copy only the built output to `static/`,
then run plugin validation and controlled reload. Prefer content-hashed file
names so browsers do not retain an old asset after reload. External scripts are
allowed only when the business dependency explicitly requires them, such as the
official AMap JSAPI.

## Database Access

Use a configured shared pool only when the endpoint is intended to query it:

```python
with context.services.connection("doris") as connection:
    with connection.cursor() as cursor:
        cursor.execute("SELECT value FROM table_name WHERE id = %s", (item_id,))
        row = cursor.fetchone()
```

Always parameterize values, use bounded time ranges and result limits, and let
the outer `with` return the connection to the current service Worker's pool.

## Dynamic Query Pages

A business plugin may query a configured database and write its own SQLite
history when the page needs interactive results. Keep the workflow bounded:

```text
validated form or API parameters
  -> parameterized Doris query with time and result limits
  -> optional business SQLite history/cache
  -> HTML or JSON response
```

Do not provide browser-supplied SQL. Define exact input fields, maximum time
ranges, result limits, and any source-query chunking in the business plugin.
For example, `flight-route` requires an exact UAV model, limits the date range,
caches query summaries, and loads one selected trajectory at a time.

## Release Commands

```bash
fastsite-cli validate-plugins --extensions-dir "$FASTSITE_EXTENSIONS_DIR"

curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $FASTSITE_RELOAD_TOKEN" \
  "${FASTSITE_RELOAD_URL%/}/reload"
```

`validate-plugins` runs in Peri and returns a JSON error with exit status `2`
without affecting the running service. The authenticated Fastsite endpoint runs
`fastsite.cli reload` in the Fenix container, where it can access the Gunicorn
PID namespace, and waits for a replacement Worker that has loaded the expected
plugin hashes. Existing Workers continue draining in-flight requests. File
changes alone never trigger a reload.
