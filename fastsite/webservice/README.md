# Webservice Plugins

This directory contains reloadable business plugins only. The `fastsite`
wheel owns Gunicorn, FastAPI application lifecycle, health endpoints, request
protection, and database pools.

Each plugin has an isolated directory under `plugins/` with a `manifest.json`,
entry module, and any templates or static assets it needs. Release a plugin by
updating its files, validating it, and explicitly requesting a controlled
reload through `webservice-skill`. File changes alone do not reload Fastsite.
The Fastsite reload endpoint invokes the existing `fastsite.cli reload` command beside
Gunicorn; existing Workers drain requests while replacement Workers load the
updated plugins.

The entry module must declare `ROUTES`, a tuple of `{path, methods}` mappings.
`fastsite` reports this route contract and a hash of the full plugin
directory through `/readyz` and `/reload-status`, so a deployment page can keep
a Loading overlay visible until the new Worker is confirmed ready.

The active plugin root is configured through `FASTSITE_EXTENSIONS_DIR` and
should normally be `/path/to/askdata-agent/webservice/plugins`.

The OpenSandbox deployment maps the same directory read-write at
`/app/workspaces/webservice/plugins` inside Peri. This is a global release
directory rather than a tenant workspace; concurrent writers must be governed
operationally.

`flight-route` is a dynamic route-query plugin. It queries Doris by exact model
and bounded date range, stores summaries and lazy-loaded tracks in SQLite, and
opens the resulting `/flight-routes/<query_id>` page. Matching history is
reused by default; an explicit refresh replaces summaries and invalidates the
matching track cache. History is stored in
`plugins/flight-route/data/flight_route_index.db`, uses SQLite WAL, and is
retained until an operator explicitly refreshes matching query data.
Set `FLIGHT_ROUTE_DB` to place the sortie index on a persistent volume. The
database and its WAL files are local runtime data and are excluded from Git and
plugin version hashes.

`flight-report` is a report container plugin. Its first report type is the
Guangdong daily flight sortie analysis report at
`/flight-reports/guangdong-daily/<YYYYMMDD>`. The explicit report-generation
endpoint backfills the target and previous natural days in six-hour Doris
chunks, then stores one aggregated row per `stat_date + fp_id` in SQLite.
Subsequent page loads use the cache only. Set `FLIGHT_REPORT_CACHE_DB` to move
that cache to a persistent volume; it is excluded from Git and release hashes.
