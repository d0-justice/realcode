# Fastsite

`fastsite` is the stable webservice host. Its Python package is `fastsite`. It exposes `/healthz`, applies basic request protections, loads trusted extensions from `FASTSITE_EXTENSIONS_DIR` whenever a Gunicorn Worker starts, and provides shared MySQL-protocol connection pools through PyMySQL.

## Build

```bash
python -m pip wheel --no-build-isolation --no-deps --wheel-dir dist ./fastsite
```

For the production secure wheel, create a private `build-config.yml` from
`build-config.example.yml`, then run this on the target Linux/Python build image:

```bash
python -m pip install -r requirements-build.txt
python build_secure_wheel.py --config build-config.yml
```

This produces a platform-specific wheel in `dist-secure/`. It includes
`_compiled_config.so` and compiled fastsite modules; it does not include the YAML
configuration or external TOML files. Build with the same Linux distribution,
CPU architecture, and CPython minor version as production. Use
`gunicorn "fastsite.host:app"` after installing it.

### Docker Desktop Build

For the deployed Debian x86_64 container that runs CPython 3.11, Docker Desktop
can build the Linux wheel without using the Windows Python environment. Create a
private `build-config.yml`, then run from this directory with BuildKit enabled:

```powershell
docker buildx build --platform linux/amd64 `
  --build-arg FASTSITE_BUILD_NONCE="$(Get-Date -Format FileDateTimeUniversal)" `
  --secret id=fastsite_config,src=build-config.yml `
  --output type=local,dest=dist-secure `
  -f Dockerfile.wheel .
```

`build-config.yml` is mounted only while compiling and is excluded from the
build context. The output directory contains the Linux binary wheel. Verify it
contains `.so` files before deployment:

```powershell
tar -tf dist-secure/fastsite-*.whl
```

## Run

```python
from fastsite import create_app

app = create_app()
```

After installing the wheel, run the extension host through
[`gunicorn.conf.py`](gunicorn.conf.py). `fastsite` owns the Gunicorn process,
health endpoints, request protections, extension discovery, and Worker-local pools.
`webservice` contains only reloadable business plugins.

The Fenix production image can run Gunicorn and the Bun server as independent
processes in one container. `scripts/start-fenix-services.sh` owns both process
lifecycles. Fastsite exposes an authenticated `POST /internal/reload` endpoint
that transports a cross-container reload request from Peri and invokes the
existing `fastsite.cli reload` command in Gunicorn's PID namespace. Plugin file
changes never reload Fastsite automatically.

Production installs the Fastsite wheel into the host-managed shared Conda
environment before containers start. Fenix and Peri mount that environment
read-only and therefore run the same Fastsite version; containers never install
or overlay a second package copy.

## Extension Layout

```text
webservice/plugins/
  flight-route/
    manifest.json
    plugin.py
```

`manifest.json`:

```json
{"id":"flight-route","api_version":1,"entry":"plugin.py"}
```

`plugin.py`:

```python
from fastapi import APIRouter
from fastsite import ExtensionContext

def register(router: APIRouter, context: ExtensionContext) -> None:
    @router.get("/status")
    def status():
        return {"extension": context.extension_id, "ok": True}
```

The default resulting route is `/extensions/flight-route/status`. A trusted plugin
may set `"mount_path":""` to retain an existing root route, such as
`/flight-routes`. Extensions are trusted release artifacts, not arbitrary end-user uploads.

## Database Configuration

The secure wheel loads the database settings embedded in `_compiled_config.so`.
For source development only, copy [`config/databases.toml.example`](config/databases.toml.example) to a deployment-only path such as `config/databases.toml`, then point `FASTSITE_DATABASE_CONFIG` to it. The external TOML path takes precedence when explicitly set.

Both MySQL and Doris use the MySQL wire protocol and are connected through PyMySQL. Store passwords in environment variables and reference their names through `password_env`; do not put passwords in TOML. Pooling uses `DBUtils.PooledDB`, matching the established dbfactory settings: `mincached=min(2, pool_size)`, `maxconnections=pool_size + pool_max_overflow`, `blocking=True`, and `ping=1`.

Extensions borrow a connection by database name. The first database request in each Gunicorn worker creates the configured pool; later requests reuse idle connections. Do not call `conn.close()` in an extension: leaving the `with` block returns it to the pool. Set `pool_size = 0` to preserve dbfactory's direct-connection mode.

```python
def register(router: APIRouter, context: ExtensionContext) -> None:
    @router.get("/summary")
    def summary():
        with context.services.connection("doris") as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT 1")
                return {"value": cursor.fetchone()[0]}
```

`fastsite` closes idle connections when its Gunicorn worker exits. Each Gunicorn worker has its own pool. `pool_wait_timeout_seconds = 0` retains dbfactory's unbounded blocking behavior; use a positive value in web services so exhausted pools return an error instead of holding a worker indefinitely.

## Reload Status

Before sending Gunicorn `HUP`, record `worker.boot_id` from `/readyz`. After
the signal, poll the following endpoint with that old ID and the plugin expected
to be active:

```text
/reload-status?previous_boot_id=<old-id>&expected_extension=flight-route
```

It returns `waiting_for_new_worker` while the old Worker still serves requests,
then `ready` once a replacement Worker has loaded the plugins and mounted their
routes. The response includes Worker PID, `boot_id`, plugin route list, and
SHA-256 hashes of each manifest, entry module, and complete plugin directory.
Pass `expected_plugin_sha256` when the caller has the expected plugin directory
hash and needs strict version confirmation. A deployment page should keep its
Loading overlay visible until `ready` is `true`.

Before sending `HUP`, the reload caller must validate the release. The command
returns one JSON object and exits with `2` if any manifest, import, `ROUTES`,
or `register()` call is invalid. Its `error` object includes the exception type,
message, and traceback so an Agent can repair the plugin and retry without
interrupting the active Worker.

```bash
fastsite-cli validate-plugins --extensions-dir /path/to/askdata-agent/webservice/plugins
```

Use the wrapper, rather than invoking `kill -HUP` directly, when a caller must
receive the outcome synchronously. It validates first, sends HUP only on a
passing release, then waits until a different Worker reports the exact plugin
directory hashes that passed preflight.

```bash
fastsite-cli reload \
  --extensions-dir /path/to/askdata-agent/webservice/plugins \
  --pid-file /path/to/askdata-agent/run/fastsite.pid \
  --status-url http://127.0.0.1:3003
```

When `webservice-skill` runs in a separate Peri sandbox, it cannot access the
Gunicorn PID namespace. Configure `FASTSITE_RELOAD_TOKEN` with at least 32
characters and call the Fastsite-owned bridge instead:

```bash
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $FASTSITE_RELOAD_TOKEN" \
  http://172.27.0.10:3003/internal/reload
```

The endpoint executes the same `fastsite.cli reload` command and returns its
final JSON result synchronously. The CLI receives the current Worker boot ID
from the endpoint so it can signal Gunicorn before polling the replacement
Worker. Ordinary CLI calls retain their existing behavior. A filesystem lock
rejects concurrent reloads with HTTP `409`; missing or invalid credentials
return `401`.

## Script Database API

Standalone Python scripts can use the same configuration and connector behavior
without starting the web host. `create_connection` creates one direct connection;
`ConnectionFactory` owns a DBUtils pool for the lifetime of that script process.

```python
from fastsite import ConnectionFactory, create_connection

with create_connection("doris") as conn:
    with conn.cursor() as cursor:
        cursor.execute("SELECT 1")

factory = ConnectionFactory("doris", pool_size=4)
try:
    with factory.get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1")
finally:
    factory.close_all()
```

The script pool is deliberately process-local and independent of a Gunicorn
worker's shared pool. This avoids sharing live PyMySQL connections across
processes. Use the installed command to inspect or test the active configuration:

```bash
fastsite-cli list
fastsite-cli test doris
```

## Environment

- `FASTSITE_DATABASE_CONFIG`: Absolute or working-directory-relative path to the deployment TOML configuration. If omitted, no database pool is registered.
- `FASTSITE_EXTENSIONS_DIR`: Plugin root; production should point to `webservice/plugins`.
- `FASTSITE_TRUSTED_HOSTS`: Comma-separated HTTP Host allowlist. Defaults to `localhost,127.0.0.1`; set the deployed hostnames or IPs explicitly when serving through a proxy.
- `FASTSITE_RELOAD_TOKEN`: Bearer token for `POST /internal/reload`; use at least 32 random characters.
- `FASTSITE_RELOAD_LOCK_FILE`: Cross-Worker reload lock; defaults to `/app/data/fastsite/reload.lock`.
- `FASTSITE_RELOAD_REQUEST_TIMEOUT_SECONDS`: HTTP bridge timeout; defaults to `120`.
