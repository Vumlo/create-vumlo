# create-vumlo

The installer of [Vumlo](https://github.com/Vumlo/vumlo-core), a self-hosted LMS for one school or university.

```sh
npx create-vumlo
```

It downloads the newest release, checks it against the release's `SHA256SUMS`, keeps only the parts you pick (web app,
desktop app), asks a few questions and writes `vumlo.toml` and `.env` (with a generated database password). Then it prints
the commands that build and start Vumlo. It needs Node 20 or newer, and Docker with the Compose plugin to run what it
installs.

What it asks, and the flag that answers it (with `--yes`, or without a terminal, every question takes its default):

| Question | Flag | Default |
|---|---|---|
| Where to install | `--dir` | `vumlo` |
| Institution name | `--name` | `Vumlo` |
| School or university (cannot be changed later) | `--mode` | `university` |
| Public address | `--origin` | `http://localhost:3000` |
| Short name, for "Vumlo \| Short name" | `--short-name` | initials of the name |
| Email domains that may sign up | `--domains` | nobody |
| Language of the web app | `--language` | `en` |
| Time zone | `--time-zone` | this computer's |
| Parts besides the backend | `--parts` | `web` |

`--version 0.4.1` takes a release other than the newest. `--archive file.tar.gz` unpacks a local archive instead (no
checksum is checked). Nothing is installed into a folder that is not empty, and a failed run removes what it made.

The guide to everything after this (TLS, mail, upgrades, backups) is `docs/install.md` in the installed folder.

## Development

`npm test` checks the edits it makes against the example files of a `vumlo-core` checkout that sits next to this
folder (`../vumlo-core/deploy/`): a release that changes those files breaks the test, which is the point. A new version is
published with `npm publish` after `npm test`.
