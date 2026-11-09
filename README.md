# create-vumlo

The installer of [Vumlo](https://github.com/Vumlo/vumlo-core), a self-hosted LMS for one school or university.

```sh
npx create-vumlo            # install
npx create-vumlo update     # later, inside the installed folder: take a newer release
```

It downloads the newest release, checks it against the release's `SHA256SUMS`, keeps only the parts you pick, asks a few
questions and writes `vumlo.toml` and `.env` (with a generated database password). Then it prints the commands that build
and start Vumlo. It needs Node 20 or newer, and Docker with the Compose plugin to run what it installs.

## Install

What it asks, in this order, and the flag that answers it (with `--yes`, or without a terminal, every question takes its
default):

| Question | Flag | Default |
|---|---|---|
| Where to install | `--dir` | `vumlo` |
| Institution name | `--name` | `Vumlo` |
| Short name, for "Vumlo \| Short name" | `--short-name` | initials of the name |
| Accent colour: violet, blue, teal, green, orange, red | `--accent` | `violet` |
| School or university (cannot be changed later) | `--mode` | `university` |
| Public address | `--origin` | `http://localhost:3000` |
| Email domains that may sign up | `--domains` | nobody |
| Language of the web app | `--language` | `en` |
| Time zone | `--time-zone` | this computer's |
| Web app? Desktop app? | `--parts web,desktop` (`""` for the backend alone) | web |
| Modules of the release (only if it has any) | `--modules a,b` | none |
| Plugins of the latest vumlo-plugins release | `--plugins a,b` (`""` for none) | none |

An accent other than violet needs release 0.5.0 or newer; an older one stops with a message saying so.

`--version 0.5.0` takes a release other than the newest. `--archive file.tar.gz` unpacks a local archive instead (no
checksum is checked). Nothing is installed into a folder that is not empty, and a failed run removes what it made.

The desktop app is built from `web/`, so `web/` stays when either is picked; only the web service of the Compose file is
dropped when the web app is not.

### Plugins

Plugins come from the latest release of [Vumlo/vumlo-plugins](https://github.com/Vumlo/vumlo-plugins), downloaded over
HTTPS from GitHub. GitHub publishes no checksum for a release's source tarball, so unlike the core archive it is not
verified (`--plugins-archive file.tar.gz` uses a local tarball instead). The chosen plugins and what their image builds
from are copied to `plugins/`, with a `plugins/compose.yaml` that adds one service per plugin (`plugin-<name>`, no
published port; the core reaches it at `http://plugin-<name>:8000`). The `./vumlo` wrapper reads that file; for plain
`docker compose` the installer prints `COMPOSE_FILE=deploy/compose.yaml:plugins/compose.yaml`.

`.env` gets `VUMLO__PLUGINS__SECRET_KEY` (generated; the core refuses to install a plugin without it) and an empty
`PLUGIN_<NAME>_TOKEN=` and `PLUGIN_<NAME>_SECRET=` for each plugin. After the first `docker compose up -d`, run
`./vumlo plugin install http://plugin-<name>:8000`, put the printed token and secret into those two variables, and run
`docker compose up -d` again.

## Update

Inside an installation (a folder with `vumlo.toml`):

```sh
npx create-vumlo update [--dir .] [--version 0.6.0] [--archive file.tar.gz] [--yes]
```

It reads the installed version from `backend/Cargo.toml` (or the default of `VUMLO_VERSION` in `deploy/compose.yaml`;
if neither is there it asks for `--yes`), downloads the release (checksum checked), and says so if you are already up to
date. Otherwise it saves every file it is about to replace to `backups/vumlo-<old>-files.tar.gz`, then replaces the
top-level entries the release has (`backend/`, `web/`, `deploy/`, `docs/`, ...). If the replacing fails it puts the
backup back.

Never touched: `vumlo.toml`, `.env`, `backups/`, `plugins/`, and anything the release does not contain. `web/` and
`desktop/` are not brought back where the installation never had them, and a Compose file whose web service was
dropped stays so.

It does not restart anything. Read the Upgrade notes in `CHANGELOG.md`, run `./vumlo config check && ./vumlo brand apply`
(`web/` was replaced, and the generated brand files live in it), then `deploy/update.sh --docker`, which backs up the
database, stops the services, rebuilds, migrates and starts them.

## Development

`npm test` checks the edits it makes against the example files of a `vumlo-core` checkout that sits next to this
folder (`../vumlo-core/deploy/`): a release that changes those files breaks the test, which is the point. It also runs the
installer and `update` on small fixture archives it builds (no network). A new version is published with `npm publish`
after `npm test`.
