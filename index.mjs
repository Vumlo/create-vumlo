#!/usr/bin/env node
// create-vumlo: downloads a Vumlo release, keeps only the parts you pick, writes vumlo.toml and .env.
// The result has the same layout as the repository (backend/, web/, desktop/, deploy/, ...).
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";

const REPO = "Vumlo/vumlo-core";

// Each edit must hit exactly one line: a release that changed the example file fails loudly
// instead of producing a config that quietly differs from what was asked.
export const ACCENTS = ["violet", "blue", "teal", "green", "orange", "red"];

export function patchToml(text, { name, mode, origin, modules, short, accent, domains = [], language, timeZone }) {
  const set = (re, to) => {
    if (!re.test(text)) throw new Error(`vumlo.toml: the example has no line matching ${re}`);
    text = text.replace(re, () => to);
  };
  set(/^name = "Vumlo"$/m, `name = ${JSON.stringify(name)}`);
  set(/^mode = "university"$/m, `mode = "${mode}"`);
  set(/^public_origin = ".*"$/m, `public_origin = ${JSON.stringify(origin)}`);
  if (short) set(/^# short_name = ".*$/m, `short_name = ${JSON.stringify(short)}`);
  if (accent && accent !== "violet") {
    if (!/^# accent = ".*$/m.test(text)) {
      throw new Error(`vumlo.toml: this release is older than 0.5.0 (its example has no "# accent" line), so the accent "${accent}" cannot be set. Use violet or a newer release.`);
    }
    set(/^# accent = ".*$/m, `accent = "${accent}"`);
  }
  if (domains.length) set(/^allowed_domains = \[\].*$/m, `allowed_domains = ${JSON.stringify(domains)}`);
  if (language && language !== "en") set(/^# language = "en".*$/m, `language = ${JSON.stringify(language)}`);
  if (timeZone && timeZone !== "UTC") set(/^# time_zone = ".*$/m, `time_zone = ${JSON.stringify(timeZone)}`);
  if (origin.startsWith("https://")) set(/^cookie_secure = false.*$/m, "cookie_secure = true");
  if (modules.length) {
    set(/^# \[modules\]\n# some-module = true$/m, `[modules]\n${modules.map((m) => `${m} = true`).join("\n")}`);
  }
  return text;
}

export function patchEnv(text, { password, modules }) {
  const set = (re, to) => {
    if (!re.test(text)) throw new Error(`.env: the example has no line matching ${re}`);
    text = text.replace(re, () => to);
  };
  set(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgres://vumlo:${password}@postgres:5432/vumlo`);
  set(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${password}`);
  if (modules.length) set(/^# VUMLO_FEATURES=$/m, `VUMLO_FEATURES=${modules.join(",")}`);
  return text;
}

// A plugin is a folder of the plugins release; its name is also a compose service and a path, so it stays plain.
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const pluginVar = (name, what) => `PLUGIN_${name.toUpperCase().replaceAll("-", "_")}_${what}`;

// plugins/compose.yaml, added to deploy/compose.yaml (`-f deploy/compose.yaml -f plugins/compose.yaml`; the ./vumlo
// wrapper does it). Relative paths resolve from the first file's folder, deploy/, hence ../plugins. Nothing is
// published: the core reaches a plugin by its service name, http://plugin-<name>:8000.
export function pluginCompose(names) {
  const service = (n) => `  plugin-${n}:
    build:
      context: ../plugins
      args:
        PLUGIN: ${n}
    environment:
      VUMLO_API: http://core:8080
      VUMLO_PLUGIN_TOKEN: \${${pluginVar(n, "TOKEN")}:-}
      VUMLO_WEBHOOK_SECRET: \${${pluginVar(n, "SECRET")}:-}
    depends_on:
      - core
    restart: unless-stopped
`;
  return `# Written by create-vumlo. The token and secret of each plugin are in .env (see "Next" of the installer).\nservices:\n${names.map(service).join("\n")}`;
}

// What .env needs for these plugins, added to what it has: the key every plugin's webhook secret is derived from
// (the core refuses to install a plugin without it) and an empty token and secret per plugin. A variable that is
// already there, empty or not, is never touched.
export function addPluginEnv(text, names, key) {
  const KEY = "VUMLO__PLUGINS__SECRET_KEY";
  if (!new RegExp(`^${KEY}=\\S`, "m").test(text)) {
    const slot = new RegExp(`^(# )?${KEY}=\\s*$`, "m");
    text = slot.test(text) ? text.replace(slot, () => `${KEY}=${key}`) : `${text.replace(/\n*$/, "\n")}${KEY}=${key}\n`;
  }
  const missing = names.flatMap((n) => [pluginVar(n, "TOKEN"), pluginVar(n, "SECRET")]).filter((v) => !new RegExp(`^${v}=`, "m").test(text));
  if (missing.length) {
    text = `${text.replace(/\n*$/, "\n")}\n# Plugins: \`./vumlo plugin install http://plugin-<name>:8000\` prints each token and secret.\n${missing.map((v) => `${v}=\n`).join("")}`;
  }
  return text;
}

// The first line of prose in a plugin's README.md (not a heading, badge, quote or HTML), cut to a line a menu can hold.
export function describePlugin(readme = "", max = 80) {
  const line = readme.split("\n").map((l) => l.trim()).find((l) => l && !/^(#|>|<|\[!\[|!\[|---|===|```)/.test(l)) ?? "";
  const plain = line.replace(/[`*]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

// Name and description of each plugin in a folder (a plugins release, or an installation's plugins/).
export function readPlugins(dir) {
  return listPlugins(dir).map((name) => ({
    name,
    description: describePlugin(existsSync(join(dir, name, "README.md")) ? readFileSync(join(dir, name, "README.md"), "utf8") : ""),
  }));
}

// What a plugin needs next to its own folder to build (the Dockerfile of the plugins release).
const PLUGIN_SHARED = ["vumlo_plugins", "pyproject.toml", "uv.lock", "Dockerfile", "LICENSE"];
const PLUGINS_REPO = "Vumlo/vumlo-plugins";

// The folders of the plugins release that hold a plugin (an app.py).
export function listPlugins(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PLUGIN_NAME.test(d.name) && existsSync(join(dir, d.name, "app.py")))
    .map((d) => d.name)
    .sort();
}

// tar -xzf of a local file or of bytes into an existing folder, dropping the archive's top folder.
function unpack(dest, { file, bytes }) {
  execFileSync("tar", ["-xzf", file ?? "-", "-C", dest, "--strip-components=1"], bytes ? { input: bytes } : {});
}

// A new empty folder under the system temp dir, made by us and removed by the caller.
const tempDir = () => mkdtempSync(join(tmpdir(), "create-vumlo-"));

// "a,b" -> ["a", "b"]; "all" -> every available plugin. A name the release lacks is an error that lists the ones it has.
export function resolvePlugins(list, available) {
  const names = list.split(",").map((x) => x.trim()).filter(Boolean);
  if (names.includes("all")) return [...available];
  for (const n of names) {
    if (!available.includes(n)) throw new Error(`the plugins release has no plugin "${n}" (it has: ${available.join(", ") || "none"})`);
  }
  return [...new Set(names)];
}

// "name   description" lines; installed ones are marked.
export function pluginLines(plugins, installed = []) {
  const width = Math.max(0, ...plugins.map((x) => x.name.length));
  return plugins.map((x) => `${x.name.padEnd(width)}  ${[x.description, installed.includes(x.name) && "(installed)"].filter(Boolean).join("  ")}`.trimEnd());
}

// Downloads the latest plugins release (or unpacks --plugins-archive) into `scratch` and returns [{ name, description }].
async function loadPlugins(f, scratch, s) {
  s.start(f["plugins-archive"] ? "Unpacking the plugins" : "Downloading the latest plugins release");
  const prel = f["plugins-archive"] ? { tag: "local archive" } : await fetchPluginsRelease();
  unpack(scratch, { file: f["plugins-archive"] && resolve(f["plugins-archive"]), bytes: prel.bytes });
  const plugins = readPlugins(scratch);
  s.stop(`Plugins ${prel.tag}`);
  return plugins;
}

// The multiselect, as `npx skills add` shows it: how many there are, then name and one line each.
async function chooseFrom(plugins) {
  p.log.info(`Found ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`);
  return ok(await p.multiselect({ message: "Plugins (space toggles, enter confirms)", options: plugins.map((x) => ({ value: x.name, label: x.name, hint: x.description || undefined })), required: false }));
}

// Puts these plugins of an unpacked plugins release into <dir>/plugins and makes the rest follow: compose.yaml lists every
// plugin now in the folder, .env gets what is missing for these. Used by the install and by `plugins add`. The shared files
// (Dockerfile, vumlo_plugins/, ...) of a folder that has them are kept, so plugins already there build as they did.
function addPlugins(dir, release, names) {
  if (!existsSync(join(release, "Dockerfile"))) throw new Error("the plugins release has no Dockerfile");
  const out = join(dir, "plugins");
  mkdirSync(out, { recursive: true });
  const skip = (src) => !/(^|\/)(__pycache__|\.pytest_cache)(\/|$)/.test(src);
  for (const n of names) cpSync(join(release, n), join(out, n), { recursive: true, filter: skip });
  for (const n of PLUGIN_SHARED) {
    if (existsSync(join(release, n)) && !existsSync(join(out, n))) cpSync(join(release, n), join(out, n), { recursive: true, filter: skip });
  }
  writeFileSync(join(out, "compose.yaml"), pluginCompose(listPlugins(out)));
  const env = join(dir, ".env");
  writeFileSync(env, addPluginEnv(readFileSync(env, "utf8"), names, randomBytes(32).toString("base64")));
  chmodSync(env, 0o600);
}

// The commands that bring the plugins up and register them with the core.
const pluginSteps = (names) => [
  ...names.map((n) => `./vumlo plugin install http://plugin-${n}:8000   # prints a token and a secret`),
  `# Put them in .env as ${names.map((n) => `${pluginVar(n, "TOKEN")} and ${pluginVar(n, "SECRET")}`).join("; ")}, then:`,
  "docker compose up -d",
];

export function dropWebService(text) {
  const out = text.replace(/\n  # The browser-facing origin[\s\S]*?(?=\nvolumes:)/, "");
  if (out === text) throw new Error("deploy/compose.yaml: cannot find the web service to remove");
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns the archive bytes after checking them against the release's SHA256SUMS.
async function fetchRelease(version) {
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/${version ? `tags/v${version}` : "latest"}`);
  const asset = (re) => rel.assets.find((a) => re.test(a.name));
  const archive = asset(/-source\.tar\.gz$/);
  const sums = asset(/^SHA256SUMS$/);
  if (!archive || !sums) throw new Error(`release ${rel.tag_name} has no source archive or SHA256SUMS`);
  const [bytes, sumsText] = await Promise.all([
    getBuffer(archive.browser_download_url),
    getBuffer(sums.browser_download_url).then(String),
  ]);
  const want = sumsText.split("\n").map((l) => l.trim().split(/\s+/)).find(([, n]) => n === archive.name)?.[0];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (want !== got) throw new Error(`checksum mismatch for ${archive.name}: do not use this download`);
  return { bytes, tag: rel.tag_name };
}

// The latest release of the plugins repository. GitHub publishes no checksum for a release's source tarball, so
// unlike the core archive this one is trusted for HTTPS and the repository alone; plugins run in containers of their own.
async function fetchPluginsRelease() {
  const rel = await getJson(`https://api.github.com/repos/${PLUGINS_REPO}/releases/latest`).catch((e) => {
    throw new Error(`cannot find a release of ${PLUGINS_REPO} (${e.message}); install without plugins (--plugins "") or try later`);
  });
  if (!rel.tarball_url) throw new Error(`release ${rel.tag_name} of ${PLUGINS_REPO} has no tarball`);
  return { bytes: await getBuffer(rel.tarball_url), tag: rel.tag_name };
}

const ok = (v) => {
  if (p.isCancel(v)) throw new Error("Cancelled");
  return v;
};

// "Example University" -> "EU"; one word stays as it is. The web and desktop apps are called "Vumlo | <short name>".
export function defaultShort(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const short = words.length > 1 ? words.map((w) => w[0].toUpperCase()).join("") : (words[0] ?? "Vumlo");
  return short.slice(0, 50);
}

// "https://lms.example.edu" -> "example.edu": the guess offered for who may sign up. Nothing for localhost or an address.
export function guessDomain(origin) {
  try {
    const host = new URL(origin).hostname;
    const labels = host.split(".");
    return labels.length >= 2 && !/^\d+$/.test(labels.at(-1)) ? labels.slice(-2).join(".") : "";
  } catch {
    return "";
  }
}

export function parseDomains(text) {
  const list = text.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  for (const d of list) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(`"${d}" is not an email domain (like example.edu)`);
  return list;
}

const zoneError = (zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return undefined;
  } catch {
    return `"${zone}" is not a time zone name (like Europe/Kyiv)`;
  }
};

// Top-level entries of an installation that an update never touches: what the administrator wrote or what
// create-vumlo added. Anything the archive does not have is left alone too.
const KEEP = ["vumlo.toml", ".env", "backups", "plugins"];

// `version = "x"` under [workspace.package] of backend/Cargo.toml.
export function versionOf(text) {
  const section = text.split(/^\[workspace\.package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  return section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

// The default of ${VUMLO_VERSION:-x} in deploy/compose.yaml: the fallback when there is no backend/Cargo.toml.
export function composeVersionOf(text) {
  return text.match(/\$\{VUMLO_VERSION:-([^}]+)\}/)?.[1];
}

// The top-level entries of the archive to put into the installation. An installation that never had web/ or
// desktop/ (they were not picked) does not get them now.
export function entriesToReplace(archiveEntries, installEntries) {
  const skip = new Set(KEEP);
  for (const part of ["web", "desktop"]) if (!installEntries.includes(part)) skip.add(part);
  return archiveEntries.filter((e) => !skip.has(e));
}

async function update(f) {
  p.intro("Vumlo update");
  const dir = resolve(f.dir ?? ".");
  if (!existsSync(join(dir, "vumlo.toml"))) throw new Error(`${dir} has no vumlo.toml: run this inside a Vumlo installation (or pass --dir)`);
  const read = (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : "");
  const old = versionOf(read("backend/Cargo.toml")) ?? composeVersionOf(read("deploy/compose.yaml"));
  if (!old) {
    if (!f.yes) throw new Error("cannot tell which version is installed (no backend/Cargo.toml or deploy/compose.yaml); run again with --yes to update anyway");
    p.log.warn("The installed version is unknown; updating anyway.");
  }

  const s = p.spinner();
  const stage = tempDir(); // the new release is unpacked here; removed below whatever happens
  try {
    s.start(f.archive ? "Unpacking" : "Downloading the release");
    const rel = f.archive ? { tag: "local archive" } : await fetchRelease(f.version);
    const fresh = join(stage, "release");
    mkdirSync(fresh);
    unpack(fresh, { file: f.archive && resolve(f.archive), bytes: rel.bytes });
    const next = versionOf(existsSync(join(fresh, "backend/Cargo.toml")) ? readFileSync(join(fresh, "backend/Cargo.toml"), "utf8") : "") ?? rel.tag.replace(/^v/, "");
    s.stop(`Unpacked ${next}`);
    if (old && next === old) {
      p.outro(`Already up to date (${old}).`);
      return;
    }

    const entries = entriesToReplace(readdirSync(fresh), readdirSync(dir));
    // A web service dropped at install time stays dropped.
    const compose = read("deploy/compose.yaml");
    if (entries.includes("deploy") && compose && !/^  web:/m.test(compose)) {
      const file = join(fresh, "deploy/compose.yaml");
      writeFileSync(file, dropWebService(readFileSync(file, "utf8")));
    }

    // Everything that is replaced is kept first, so local edits are never lost.
    const had = entries.filter((e) => existsSync(join(dir, e)));
    mkdirSync(join(dir, "backups"), { recursive: true });
    let backup = join(dir, "backups", `vumlo-${old ?? "unknown"}-files.tar.gz`);
    if (existsSync(backup)) backup = backup.replace(/\.tar\.gz$/, `-${Date.now()}.tar.gz`);
    execFileSync("tar", ["-czf", backup, "-C", dir, ...had]);

    s.start("Replacing the files");
    try {
      for (const e of entries) {
        rmSync(join(dir, e), { recursive: true, force: true });
        cpSync(join(fresh, e), join(dir, e), { recursive: true, verbatimSymlinks: true });
      }
    } catch (err) {
      for (const e of entries) rmSync(join(dir, e), { recursive: true, force: true });
      execFileSync("tar", ["-xzf", backup, "-C", dir]);
      throw new Error(`${err.message}. The previous files are back (from ${backup}).`);
    }
    s.stop(`Replaced ${entries.join(", ")}`);

    p.note(
      [
        `cd ${dir}`,
        `# Read "Upgrade notes" in CHANGELOG.md (${old ?? "?"} -> ${next}).`,
        "./vumlo config check && ./vumlo brand apply   # web/ was replaced, and the generated brand files lived there",
        "deploy/update.sh --docker                     # backs up the database, stops the services, rebuilds, migrates, starts",
        "",
        `# Your own edits to the replaced files are in ${backup}`,
        "# vumlo.toml, .env, backups/ and plugins/ were not touched.",
      ].join("\n"),
      "Next",
    );
    p.outro(`Updated ${old ?? "?"} -> ${next}. The services are still running the old version until update.sh has run.`);
  } catch (e) {
    s.stop("Failed");
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// `plugins list` and `plugins add [name...]` (inside an installation), and --list-plugins (anywhere, `dir` undefined).
async function pluginsCmd(f, sub, names, dir) {
  p.intro("Vumlo plugins");
  if (dir) {
    if (!existsSync(join(dir, "vumlo.toml"))) throw new Error(`${dir} has no vumlo.toml: run this inside a Vumlo installation (or pass --dir)`);
    if (sub === "add" && !existsSync(join(dir, ".env"))) throw new Error(`${dir} has no .env`);
  }
  const have = dir && existsSync(join(dir, "plugins")) ? listPlugins(join(dir, "plugins")) : [];
  const s = p.spinner();
  const scratch = tempDir(); // the plugins release is unpacked here; removed below whatever happens
  try {
    const available = await loadPlugins(f, scratch, s);
    if (sub === "list") {
      p.log.info(`Found ${available.length} plugin${available.length === 1 ? "" : "s"}`);
      if (available.length) p.log.message(pluginLines(available, have).join("\n"));
      p.outro("Nothing was installed.");
      return;
    }
    const open = available.filter((x) => !have.includes(x.name));
    const wanted = names.length ? names.join(",") : f.plugins;
    let picked;
    if (wanted !== undefined) {
      picked = resolvePlugins(wanted, available.map((x) => x.name));
      const again = picked.filter((n) => have.includes(n));
      if (again.length) p.log.warn(`Already installed, left as they are: ${again.join(", ")}`);
      picked = picked.filter((n) => !have.includes(n));
    } else if (f.yes || !process.stdin.isTTY) {
      throw new Error("name the plugins to add (plugins add a b, or all)");
    } else if (open.length) {
      picked = await chooseFrom(open);
    } else {
      picked = [];
    }
    if (!picked.length) {
      p.outro("No plugin to add.");
      return;
    }
    addPlugins(dir, scratch, picked);
    p.note(
      [
        `cd ${dir}`,
        `export COMPOSE_FILE=deploy/compose.yaml:plugins/compose.yaml COMPOSE_ENV_FILES=.env   # ./vumlo does this itself`,
        "docker compose up -d --build",
        ...pluginSteps(picked),
      ].join("\n"),
      "Next",
    );
    p.outro(`Added: ${picked.join(", ")}. plugins/compose.yaml now lists ${listPlugins(join(dir, "plugins")).join(", ")}.`);
  } catch (e) {
    s.stop("Failed");
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values: f, positionals } = parseArgs({
    options: {
      dir: { type: "string" },
      version: { type: "string" },
      archive: { type: "string" }, // a local vumlo-X-source.tar.gz instead of a download (no checksum)
      name: { type: "string" },
      mode: { type: "string" },
      origin: { type: "string" },
      "short-name": { type: "string" }, // the name in "Vumlo | <short name>"
      accent: { type: "string" }, // violet | blue | teal | green | orange | red (needs a 0.5.0 release for anything but violet)
      domains: { type: "string" }, // comma separated email domains that may sign up themselves ("" for nobody)
      language: { type: "string" }, // en | uk
      "time-zone": { type: "string" }, // an IANA name, e.g. Europe/Kyiv
      parts: { type: "string" }, // comma separated: web,desktop ("" for the backend alone)
      modules: { type: "string" }, // comma separated
      plugins: { type: "string" }, // comma separated names from the latest vumlo-plugins release, "all", or "" for none
      "list-plugins": { type: "boolean" }, // print the plugins and their descriptions, install nothing
      "plugins-archive": { type: "string" }, // a local plugins tarball instead of the latest release (no checksum either way)
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: true,
  });
  if (f["list-plugins"]) return pluginsCmd(f, "list", [], undefined);
  if (positionals.length === 1 && positionals[0] === "update") return update(f);
  if (positionals[0] === "plugins" && ["list", "add"].includes(positionals[1]) && (positionals[1] === "add" || positionals.length === 2)) {
    return pluginsCmd(f, positionals[1], positionals.slice(2), resolve(f.dir ?? "."));
  }
  if (positionals.length) throw new Error(`unknown command "${positionals.join(" ")}" (there are: update, plugins list, plugins add [name...])`);
  // A flag wins; with --yes or no terminal the default is taken; otherwise ask.
  const quiet = f.yes || !process.stdin.isTTY;
  const ask = async (given, fallback, prompt) => (given !== undefined ? given : quiet ? fallback : ok(await prompt()));

  p.intro("Vumlo installer");
  if (f.accent !== undefined && !ACCENTS.includes(f.accent)) throw new Error(`accent must be one of ${ACCENTS.join(", ")}, not "${f.accent}"`);

  const dir = resolve(
    await ask(f.dir, "vumlo", () => p.text({ message: "Where to install?", placeholder: "vumlo", defaultValue: "vumlo" })),
  );
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty.`);

  const s = p.spinner();
  const created = !existsSync(dir);
  const scratch = tempDir(); // the plugins release is unpacked here; removed below whatever happens
  try {
    s.start(f.archive ? "Unpacking" : "Downloading the latest release");
    const rel = f.archive ? { tag: "local archive" } : await fetchRelease(f.version);
    mkdirSync(dir, { recursive: true });
    unpack(dir, { file: f.archive && resolve(f.archive), bytes: rel.bytes });
    s.stop(`Unpacked ${rel.tag}`);

    const found = existsSync(join(dir, "backend/crates/modules")) ? readdirSync(join(dir, "backend/crates/modules")) : [];
    // The plugins release is only fetched when plugins can be chosen: named by --plugins, or asked for.
    const available = (f.plugins === undefined ? !quiet : f.plugins.trim()) ? await loadPlugins(f, scratch, s) : [];

    const name = await ask(f.name, "Vumlo", () => p.text({ message: "Institution name", placeholder: "Example University", defaultValue: "Vumlo" }));
    const short = await ask(f["short-name"], defaultShort(name), () =>
      p.text({
        message: "Short name (the apps are called Vumlo | <short name>)",
        placeholder: defaultShort(name),
        defaultValue: defaultShort(name),
        validate: (v) => (v.length > 50 ? "50 characters at most" : undefined),
      }),
    );
    const accent = await ask(f.accent, "violet", () =>
      p.select({ message: "Accent colour", options: ACCENTS.map((value) => ({ value })), initialValue: "violet" }),
    );
    const mode = await ask(f.mode, "university", () =>
      p.select({
        message: "School or university? (cannot be changed later)",
        options: [
          { value: "university", label: "University", hint: "points add up to 100 per course" },
          { value: "school", label: "School", hint: "grades 1-12" },
        ],
      }),
    );
    const origin = await ask(f.origin, "http://localhost:3000", () =>
      p.text({ message: "Public address (what people will type)", placeholder: "https://lms.example.edu", defaultValue: "http://localhost:3000" }),
    );
    const domains = parseDomains(
      await ask(f.domains, "", () =>
        p.text({
          message: "Email domains whose people may sign up themselves (comma separated; empty: nobody, you add people)",
          placeholder: guessDomain(origin) || "example.edu",
          defaultValue: "",
          validate: (v) => {
            try {
              parseDomains(v);
            } catch (e) {
              return e.message;
            }
          },
        }),
      ),
    );
    const language = await ask(f.language, "en", () =>
      p.select({ message: "Language of the web app", options: [{ value: "en", label: "English" }, { value: "uk", label: "Ukrainian" }] }),
    );
    if (!["en", "uk"].includes(language)) throw new Error(`language must be en or uk, not "${language}"`);
    const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const timeZone = await ask(f["time-zone"], detectedZone, () =>
      p.text({ message: "Time zone (deadlines are shown in it)", placeholder: detectedZone, defaultValue: detectedZone, validate: zoneError }),
    );
    if (zoneError(timeZone)) throw new Error(zoneError(timeZone));
    // --parts web,desktop still answers both questions at once.
    let parts = f.parts;
    if (parts === undefined && !quiet) {
      parts = [ok(await p.confirm({ message: "Web app (Next.js)?", initialValue: true })) && "web", ok(await p.confirm({ message: "Desktop app (Tauri)?", initialValue: false })) && "desktop"]
        .filter(Boolean)
        .join(",");
    }
    parts = (parts ?? "web").split(",").filter(Boolean);
    for (const x of parts) if (!["web", "desktop"].includes(x)) throw new Error(`--parts takes web and desktop, not "${x}"`);
    if (!found.length && f.modules === undefined && !quiet) p.log.info("This release has no optional modules.");
    const modules =
      f.modules !== undefined
        ? f.modules.split(",").filter(Boolean)
        : found.length && !quiet
          ? ok(await p.multiselect({ message: "Modules", options: found.map((m) => ({ value: m })), required: false }))
          : [];

    for (const m of modules) {
      if (!found.includes(m)) throw new Error(`this release has no module "${m}"`);
    }
    const plugins =
      f.plugins !== undefined
        ? resolvePlugins(f.plugins, available.map((x) => x.name))
        : available.length && !quiet
          ? await chooseFrom(available)
          : [];
    if (!available.length && f.plugins === undefined && !quiet) p.log.info("The plugins release has no plugins.");
    // Only what was picked stays on disk. The desktop app builds from web/, so web/ stays for either.
    if (!parts.includes("web") && !parts.includes("desktop")) rmSync(join(dir, "web"), { recursive: true, force: true });
    if (!parts.includes("desktop")) rmSync(join(dir, "desktop"), { recursive: true, force: true });
    if (!parts.includes("web")) {
      const compose = join(dir, "deploy/compose.yaml");
      writeFileSync(compose, dropWebService(readFileSync(compose, "utf8")));
    }

    const read = (rel) => readFileSync(join(dir, rel), "utf8");
    writeFileSync(join(dir, "vumlo.toml"), patchToml(read("deploy/vumlo.example.toml"), { name, mode, origin, modules, short, accent, domains, language, timeZone }));
    writeFileSync(join(dir, ".env"), patchEnv(read("deploy/env.example"), { password: randomBytes(18).toString("hex"), modules }));
    chmodSync(join(dir, ".env"), 0o600);
    if (plugins.length) addPlugins(dir, scratch, plugins);

    p.note(
      [
        `cd ${dir}`,
        "./vumlo config check && ./vumlo brand apply",
        `export COMPOSE_FILE=deploy/compose.yaml${plugins.length ? ":plugins/compose.yaml" : ""} COMPOSE_ENV_FILES=.env`,
        "docker compose build",
        "docker compose up -d --wait postgres",
        "./vumlo db migrate",
        "./vumlo admin create you@example.edu --name Your --surname Name",
        "docker compose up -d && ./vumlo doctor",
        ...(plugins.length ? ["", "# Plugins: each registers once the core is up (VUMLO__PLUGINS__SECRET_KEY is set in .env).", ...pluginSteps(plugins)] : []),
        "",
        "# To look around first, after the migration: ./vumlo seed --demo",
        "# Later: npx create-vumlo update (inside this folder); the guide is docs/install.md (TLS, mail, upgrades, backups)",
      ].join("\n"),
      "Next",
    );
    p.outro(`Installed: backend${parts.map((x) => ` + ${x}`).join("")}${modules.map((m) => ` + ${m}`).join("")}${plugins.map((n) => ` + plugin ${n}`).join("")}. Secrets are in ${join(dir, ".env")}.`);
  } catch (e) {
    s.stop("Failed");
    if (created) rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Run as a program, not imported by the test. `npx` and `npm i -g` start it through a symlink, so the path is resolved first.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main().catch((e) => {
    p.cancel(e.message);
    process.exit(1);
  });
}
