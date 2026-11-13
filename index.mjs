#!/usr/bin/env node
// create-vumlo: downloads a Vumlo release, keeps only the parts you pick, writes vumlo.toml and .env.
// The result has the same layout as the repository (backend/, web/, desktop/, deploy/, ...).
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { checkS3, checkSmtp } from "./checks.mjs";

const REPO = "Vumlo/vumlo-core";

// Each edit must hit exactly one line: a release that changed the example file fails loudly
// instead of producing a config that quietly differs from what was asked.
export const ACCENTS = ["violet", "blue", "teal", "green", "orange", "red"];

// Modules that cannot start on `name = true` alone (config check refuses them): the settings the installer asks for
// (`fields`: a string each, with a default so a quiet run still passes config check) and, if the module has one, the
// environment variable of its secret `key` (docs/install.md). It is asked about only when the module is picked. Every
// other option of the module keeps its default and is edited in vumlo.toml later. A module not listed here needs nothing:
// a new module with required settings is one more entry here.
export const MODULE_SETTINGS = {
  ai_agent: {
    fields: [
      { name: "endpoint", label: "endpoint (any OpenAI-compatible API)", default: "https://api.openai.com/v1" },
      { name: "model", label: "model", default: "gpt-4o-mini" },
    ],
    key: "VUMLO_AI_AGENT_API_KEY",
  },
};

// The address of the admin console (ADR-0095), a second origin next to the public one: with a domain, `admin.` in front of
// its host; for localhost or an IP address, the next port. The administrator may give another.
export function defaultAdminOrigin(origin) {
  const url = new URL(origin);
  if (/^[a-z]/i.test(url.hostname) && url.hostname !== "localhost" && url.hostname.includes(".")) return `${url.protocol}//admin.${url.host}`;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80)) + 1;
  return `${url.protocol}//${url.hostname}:${port}`;
}

// A real hostname (not localhost, not an IP address): the only kind a certificate and a DNS record are for.
const isDomain = (host) => /^[a-z]/i.test(host) && host !== "localhost" && host.includes(".");

export const defaultPort = (tls) => ({ starttls: 587, tls: 465, none: 25 })[tls];

// Outgoing mail (ADR-0084): null unless it was asked for. Throws what is wrong, in words for the person who typed it.
export function mailSettings({ mail, from, host, tls = "starttls", port, user = "" }, name, origin) {
  if (mail !== "yes") return null;
  if (!host) throw new Error("mail needs the SMTP host (--mail-host)");
  if (!["starttls", "tls", "none"].includes(tls)) throw new Error(`the mail encryption must be starttls, tls or none, not "${tls}"`);
  const number = port === undefined || port === "" ? defaultPort(tls) : Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`the mail port must be 1 to 65535, not "${port}"`);
  return { from: from || `${name.replace(/[<>"]/g, "")} <no-reply@${new URL(origin).hostname}>`, host, tls, port: number, user };
}

// Where uploaded files live (ADR-0069): the local directory, or an S3 bucket (AWS, or a service with an https endpoint).
export function filesSettings({ files = "local", endpoint, bucket, region }) {
  if (!["local", "s3"].includes(files)) throw new Error(`the file storage must be local or s3, not "${files}"`);
  if (files === "local") return { storage: "local" };
  if (!bucket) throw new Error("S3 needs the bucket (--s3-bucket)");
  if (endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`the S3 endpoint "${endpoint}" must be an address like https://s3.example.edu`);
    }
    if (url.protocol !== "https:") throw new Error("the S3 endpoint must start with https://");
  }
  return { storage: "s3", endpoint: endpoint || undefined, bucket, region: region || "eu-north-1" };
}

// What deploy/Caddyfile reads: the two domains, for /etc/default/caddy. Only for two real https hostnames.
export function caddyEnv(origin, adminOrigin) {
  const [a, b] = [origin, adminOrigin].map((o) => new URL(o));
  if (a.protocol !== "https:" || b.protocol !== "https:" || !isDomain(a.hostname) || !isDomain(b.hostname)) return null;
  return `VUMLO_DOMAIN=${a.hostname}\nVUMLO_ADMIN_DOMAIN=${b.hostname}\n`;
}

// Throws what is wrong with `adminOrigin`: it must be an origin, and not the public one.
export function checkAdminOrigin(adminOrigin, origin) {
  let url;
  try {
    url = new URL(adminOrigin);
  } catch {
    throw new Error(`the admin address "${adminOrigin}" must start with a scheme, as in https://admin.lms.example.edu`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`the admin address "${adminOrigin}" must start with http:// or https://`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`the admin address "${adminOrigin}" must have no path: just scheme, host and port`);
  if (url.origin === new URL(origin).origin) throw new Error("the admin address must differ from the public address: the console is its own origin");
}

// `server.admin_origin` of a vumlo.toml, or undefined when it has none (it is required since 0.7.0).
export const adminOriginIn = (text) => /^admin_origin = "(.*)"$/m.exec(text)?.[1];

// Puts `admin_origin` under `public_origin`; throws when there is no such line to put it under.
export function withAdminOrigin(text, adminOrigin) {
  const line = /^public_origin = ".*"$/m;
  if (!line.test(text)) throw new Error("vumlo.toml has no public_origin line to put admin_origin under: add admin_origin to [server] yourself");
  return text.replace(line, (l) => `${l}\nadmin_origin = ${JSON.stringify(adminOrigin)}`);
}

// `settings`: { module: { endpoint, model } } for the modules that have them; they get a table of their own.
export function patchToml(text, { name, mode, origin, adminOrigin, modules, short, accent, domains = [], language, timeZone, settings = {}, mail, files, proxy }) {
  const set = (re, to) => {
    if (!re.test(text)) throw new Error(`vumlo.toml: the example has no line matching ${re}`);
    text = text.replace(re, () => to);
  };
  set(/^name = "Vumlo"$/m, `name = ${JSON.stringify(name)}`);
  set(/^mode = "university"$/m, `mode = "${mode}"`);
  set(/^public_origin = ".*"$/m, `public_origin = ${JSON.stringify(origin)}`);
  // The example of a release before 0.7.0 has no such line, and its server does not know the key.
  if (/^admin_origin = ".*"$/m.test(text)) set(/^admin_origin = ".*"$/m, `admin_origin = ${JSON.stringify(adminOrigin ?? defaultAdminOrigin(origin))}`);
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
  // Behind a proxy that overwrites X-Real-IP (deploy/Caddyfile does), the login limits see the client and not the proxy.
  if (proxy) set(/^# client_ip_header = "x-real-ip"$/m, 'client_ip_header = "x-real-ip"');
  if (mail) {
    set(/^# \[mail\]$/m, "[mail]");
    set(/^# from = .*$/m, `from = ${JSON.stringify(mail.from)}`);
    set(/^# \[mail\.transport\]$/m, "[mail.transport]");
    set(/^# kind = "smtp".*$/m, 'kind = "smtp"');
    set(/^# host = .*$/m, `host = ${JSON.stringify(mail.host)}`);
    set(/^# port = 587.*$/m, `port = ${mail.port}`);
    set(/^# tls = .*$/m, `tls = "${mail.tls}"`);
    if (mail.user) set(/^# username = .*$/m, `username = ${JSON.stringify(mail.user)}`);
  }
  if (files?.storage === "s3") {
    set(/^storage = "local".*$/m, 'storage = "s3"');
    set(/^# \[files\.s3\].*$/m, "[files.s3]");
    if (files.endpoint) set(/^# endpoint = "https:\/\/s3\.example\.edu".*$/m, `endpoint = ${JSON.stringify(files.endpoint)}`);
    set(/^# bucket = .*$/m, `bucket = ${JSON.stringify(files.bucket)}`);
    set(/^# region = .*$/m, `region = ${JSON.stringify(files.region)}`);
  }
  if (modules.length) {
    const plain = modules.filter((m) => !settings[m]);
    const tables = modules.filter((m) => settings[m]).map((m) => [`[modules.${m}]`, "enabled = true", ...Object.entries(settings[m]).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)].join("\n"));
    set(/^# \[modules\]\n# some-module = true$/m, [plain.length && `[modules]\n${plain.map((m) => `${m} = true`).join("\n")}`, ...tables].filter(Boolean).join("\n\n"));
  }
  return text;
}

// `keys`: { VARIABLE: value } of the secrets of modules, written after the rest (empty: left to be filled in later).
export function patchEnv(text, { password, modules, keys = {}, secrets = {} }) {
  const set = (re, to) => {
    if (!re.test(text)) throw new Error(`.env: the example has no line matching ${re}`);
    text = text.replace(re, () => to);
  };
  set(/^DATABASE_URL=.*$/m, `DATABASE_URL=postgres://vumlo:${password}@postgres:5432/vumlo`);
  set(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${password}`);
  if (modules.length) set(/^# VUMLO_FEATURES=$/m, `VUMLO_FEATURES=${modules.join(",")}`);
  // The secrets of the mail server and the bucket. Single quotes: docker compose and vumlo-cli each strip one pair, and compose
  // does not expand `$` or start a comment at ` #` inside them. An empty one is not written (the example's line stays).
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    if (/['\r\n]/.test(value)) throw new Error(`${name} cannot hold a single quote or a line break: set a value without one`);
    text = setEnvVar(text, name, `'${value}'`);
  }
  const lines = Object.entries(keys).map(([name, value]) => `${name}=${value}\n`);
  return lines.length ? `${text.replace(/\n*$/, "\n")}\n# Keys of the modules.\n${lines.join("")}` : text;
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

// Written into an installation as soon as it is unpacked and removed when the run is over: a folder that has it is an
// unfinished installation of ours, the only kind a retry may remove (ADR-0096).
export const UNFINISHED = ".create-vumlo-unfinished";

// Everything inside `dir`, not `dir` itself.
export function removeContents(dir) {
  for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
}

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

// --- Bringing an installation up: what the "Next" note used to leave to the administrator ---------------------------

// NAME=value in an .env text: the line is replaced, or added at the end when there is none.
export function setEnvVar(text, name, value) {
  const line = new RegExp(`^${name}=.*$`, "m");
  return line.test(text) ? text.replace(line, () => `${name}=${value}`) : `${text.replace(/\n*$/, "\n")}${name}=${value}\n`;
}

// What `plugin install` prints, once: the token and the secret of the plugin.
export function parseInstalled(out) {
  const token = out.match(/^\s*VUMLO_PLUGIN_TOKEN=(\S+)\s*$/m)?.[1];
  const secret = out.match(/^\s*VUMLO_WEBHOOK_SECRET=(\S+)\s*$/m)?.[1];
  if (!token || !secret) throw new Error("`plugin install` printed no token and secret");
  return { token, secret };
}

// The scopes a plugin asks for, from the "  asks for scopes: a, b" line of `plugin install` ("none": no scope).
export function parseAsked(out) {
  const list = out.match(/^\s*asks for scopes: (.*)$/m)?.[1];
  if (list === undefined) throw new Error("`plugin install` did not say which scopes the plugin asks for");
  return list.trim() === "none" ? [] : list.split(",").map((x) => x.trim()).filter(Boolean);
}

const hasDocker = () => spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A command in the installation, with what ./vumlo sets for itself. `capture` returns its output (stdout and stderr) as
// `out` instead of showing it; there is never a terminal on standard input, so `docker compose run` asks nothing.
function runIn(dir, args, { input, capture, core } = {}) {
  const env = {
    ...process.env,
    // `core`: only the core's services, so that a plugin which does not build cannot stop them.
    COMPOSE_FILE: !core && existsSync(join(dir, "plugins/compose.yaml")) ? "deploy/compose.yaml:plugins/compose.yaml" : "deploy/compose.yaml",
    COMPOSE_ENV_FILES: ".env",
    VUMLO_UID: String(process.getuid?.() ?? 1000),
    VUMLO_GID: String(process.getgid?.() ?? 1000),
  };
  const [cmd, ...rest] = args;
  const r = spawnSync(cmd, rest, { cwd: dir, env, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// One labelled step; a failure stops everything, and the files stay where they are.
function step(dir, label, args, opts) {
  p.log.step(label);
  const r = runIn(dir, args, opts);
  if (r.status !== 0) throw new Error(`${label}: failed (${args.slice(0, 3).join(" ")} exited ${r.status}).${r.out ? `\n${r.out.trim()}` : ""}\nThe files are in ${dir}; fix the cause and run the failed command again, then the ones after it (docs/install.md).`);
  return r.out;
}

// An unfinished installation (it has the marker) is removed with its containers and volumes, so that the database password
// of the new run cannot meet the volume of the old one. Docker being absent or failing is a warning: the files go anyway.
async function startOver(dir, quiet) {
  if (!quiet && !ok(await p.confirm({ message: `${dir} holds an unfinished installation. Remove it and start over?`, initialValue: true }))) {
    throw new Error(`${dir} is left as it is.`);
  }
  if (existsSync(join(dir, "deploy/compose.yaml")) && hasDocker()) {
    p.log.step("Removing the containers and volumes of the unfinished installation");
    const r = runIn(dir, ["docker", "compose", "-f", "deploy/compose.yaml", "down", "-v", "--remove-orphans"], { capture: true });
    if (r.status !== 0) p.log.warn(`docker compose down failed, the files are removed anyway:\n${r.out.trim()}`);
  }
  removeContents(dir);
}

// Builds and starts each plugin on its own. One that does not build or start is reported and left out; the others run.
// Returns the names that are up. The files of a failed one stay, `plugins register` tries it again.
function startPlugins(dir, names) {
  const up = [];
  const failed = [];
  for (const n of names) {
    p.log.step(`Building and starting the plugin ${n}`);
    const r = runIn(dir, ["docker", "compose", "up", "-d", "--build", `plugin-${n}`], { capture: true });
    if (r.status === 0) up.push(n);
    else failed.push(`${n} (${r.out.trim().split("\n").at(-1) || `exited ${r.status}`})`);
  }
  if (failed.length) p.log.error(`Not started, they are left out: ${failed.join("; ")}. The others are running. Fix the cause, then: npx create-vumlo plugins register (inside ${dir}).`);
  return up;
}

// Registers the plugins that are running with the core and keeps what it prints in .env, where the containers read it.
// `consent`: true grants what each plugin asks for (all courses), false registers none, "ask" asks per plugin.
// One plugin that cannot be registered does not stop the others: its reason is kept and shown at the end (a manifest the
// core refuses is final and is not waited for; a plugin that does not answer is waited for ~30 s). Returns what happened.
export async function registerPlugins(dir, names, consent) {
  const registered = [];
  const left = [];
  const failed = [];
  const reasonOf = (out) => out.match(/^error: .*$/m)?.[0] ?? out.trim().split("\n").at(-1) ?? "no answer";
  for (const n of names) {
    const url = `http://plugin-${n}:8000`;
    // The manifest is read from the container, which may still be starting.
    let asked;
    let last = "";
    for (let i = 0; i < 15 && !asked; i++) {
      const r = runIn(dir, ["./vumlo", "plugin", "install", url, "--grant", "none", "--courses", "none", "--dry-run"], { capture: true });
      if (r.status === 0) asked = parseAsked(r.out);
      else {
        last = r.out;
        if (/the manifest is not valid/.test(r.out)) break;
        await sleep(2000);
      }
    }
    if (!asked) {
      failed.push({ name: n, reason: reasonOf(last) });
      continue;
    }
    const yes = consent === "ask" ? ok(await p.confirm({ message: `Plugin ${n} asks for: ${asked.join(", ") || "no scope"}. Grant it, for all courses?` })) : consent;
    if (!yes) {
      left.push(n);
      continue;
    }
    p.log.step(`Registering the plugin ${n}`);
    const r = runIn(dir, ["./vumlo", "plugin", "install", url, "--grant", asked.join(",") || "none", "--courses", "all"], { capture: true });
    if (r.status !== 0) {
      failed.push({ name: n, reason: reasonOf(r.out) });
      continue;
    }
    const { token, secret } = parseInstalled(r.out);
    const env = join(dir, ".env");
    writeFileSync(env, setEnvVar(setEnvVar(readFileSync(env, "utf8"), pluginVar(n, "TOKEN"), token), pluginVar(n, "SECRET"), secret));
    registered.push(n);
  }
  if (registered.length) step(dir, "Restarting the plugins with their tokens", ["docker", "compose", "up", "-d", ...registered.map((n) => `plugin-${n}`)]);
  if (left.length) p.log.warn(`Not registered (no grant given): ${left.join(", ")}. Later: npx create-vumlo plugins register --grant-plugins (inside ${dir}), or one by one: ./vumlo plugin install http://plugin-<name>:8000 and the printed token and secret in .env.`);
  if (failed.length) p.log.error(`Not registered, they are left out: ${failed.map((x) => `${x.name} (${x.reason})`).join("; ")}. The others are running.`);
  return { registered, left, failed };
}

// The plugins in plugins/ that have no token in .env yet: not registered (a failed or declined run), whatever the reason.
export function unregistered(names, envText) {
  return names.filter((n) => !new RegExp(`^${pluginVar(n, "TOKEN")}=\\S`, "m").test(envText));
}

// `plugins register [name...]`: registers the plugins of an installation that have no token yet. Builds and starts them first.
async function registerCmd(f, names, dir) {
  p.intro("Vumlo plugins");
  if (!existsSync(join(dir, "plugins/compose.yaml")) || !existsSync(join(dir, ".env"))) throw new Error(`${dir} has no plugins/compose.yaml and .env: run this inside an installation with plugins (or pass --dir)`);
  if (!hasDocker()) throw new Error("registering needs Docker with the Compose plugin (docker compose)");
  const have = listPlugins(join(dir, "plugins"));
  for (const n of names) if (!have.includes(n)) throw new Error(`no plugin "${n}" in ${join(dir, "plugins")} (it has: ${have.join(", ") || "none"})`);
  const todo = unregistered(names.length ? names : have, readFileSync(join(dir, ".env"), "utf8"));
  if (!todo.length) {
    p.outro("Every plugin already has a token: nothing to register.");
    return;
  }
  const quiet = f.yes || !process.stdin.isTTY;
  const { failed } = await registerPlugins(dir, startPlugins(dir, todo), f["grant-plugins"] ? true : quiet ? false : "ask");
  p.outro(failed.length ? `Done, ${failed.length} plugin(s) could not be registered (above).` : "Done.");
}

// config check .. doctor, then the plugins: the steps of the old "Next" note, in order. The first failure stops with its output.
async function bringUp(dir, { admin, plugins, consent }) {
  // Captured, so the reason of a failure is in the error message and not only on the screen.
  step(dir, "Checking vumlo.toml and .env", ["./vumlo", "config", "check"], { capture: true });
  step(dir, "Writing the brand files", ["./vumlo", "brand", "apply"], { capture: true });
  step(dir, "Building the images (the first build takes a while)", ["docker", "compose", "build"], { core: true });
  step(dir, "Starting PostgreSQL", ["docker", "compose", "up", "-d", "--wait", "postgres"]);
  step(dir, "Applying the migrations", ["./vumlo", "db", "migrate"]);
  if (admin) step(dir, `Creating the administrator ${admin.email}`, ["./vumlo", "admin", "create", admin.email, "--name", admin.name, "--surname", admin.surname, "--password-stdin"], { input: `${admin.password}\n`, capture: true });
  step(dir, "Starting the services", ["docker", "compose", "up", "-d"], { core: true });
  p.log.step("Waiting for the core (vumlo doctor)");
  let doctor;
  for (let i = 0; i < 15; i++) {
    doctor = runIn(dir, ["./vumlo", "doctor"], { capture: true });
    if (doctor.status === 0) break;
    await sleep(4000);
  }
  if (doctor.status !== 0) throw new Error(`vumlo doctor still fails:\n${doctor.out.trim()}\nThe files are in ${dir}; see docs/install.md.`);
  if (plugins.length) await registerPlugins(dir, startPlugins(dir, plugins), consent);
}

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
  // The admin console is built with the web app and has no use without it (ADR-0095).
  if (!installEntries.includes("web")) skip.add("web-admin");
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

    // A release that needs `server.admin_origin` (0.7.0 and later) does not start without it. It is asked for once, here, and never
    // written without an answer: a bad one stops the update before any file is touched.
    const publicNow = /^public_origin = "(.*)"$/m.exec(read("vumlo.toml"))?.[1];
    const needsAdminOrigin =
      existsSync(join(fresh, "deploy/vumlo.example.toml")) &&
      adminOriginIn(readFileSync(join(fresh, "deploy/vumlo.example.toml"), "utf8")) !== undefined &&
      adminOriginIn(read("vumlo.toml")) === undefined;
    let adminOrigin = f["admin-origin"];
    if (needsAdminOrigin && publicNow) {
      if (adminOrigin === undefined && !f.yes && process.stdin.isTTY) {
        adminOrigin = ok(await p.text({ message: "This release has an admin console. Its address (administrators sign in there)", placeholder: defaultAdminOrigin(publicNow), defaultValue: defaultAdminOrigin(publicNow) }));
      }
      if (adminOrigin !== undefined) checkAdminOrigin(adminOrigin, publicNow);
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
    if (needsAdminOrigin && adminOrigin !== undefined) {
      writeFileSync(join(dir, "vumlo.toml"), withAdminOrigin(read("vumlo.toml"), adminOrigin));
      p.log.success(`Wrote server.admin_origin = ${adminOrigin} to vumlo.toml`);
    }

    p.note(
      [
        `cd ${dir}`,
        `# Read "Upgrade notes" in CHANGELOG.md (${old ?? "?"} -> ${next}).`,
        ...(needsAdminOrigin && adminOrigin === undefined ? [`# This release needs server.admin_origin in vumlo.toml, the admin console's own address: add it under public_origin (for example admin_origin = "${publicNow ? defaultAdminOrigin(publicNow) : "https://admin.lms.example.edu"}"), or run again with --admin-origin.`] : []),
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
    const quiet = f.yes || !process.stdin.isTTY;
    const docker = hasDocker();
    const start = f.start ?? (quiet || !docker ? false : ok(await p.confirm({ message: "Build, start and register them now?", initialValue: true })));
    if (start && !docker) throw new Error("--start needs Docker with the Compose plugin (docker compose)");
    if (start) {
      const up = startPlugins(dir, picked);
      await registerPlugins(dir, up, f["grant-plugins"] ? true : quiet ? false : "ask");
      p.outro(up.length === picked.length ? `Added: ${picked.join(", ")}. They are running.` : `Added: ${picked.join(", ")}. Running: ${up.join(", ") || "none"}.`);
      return;
    }
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
      mail: { type: "string" }, // yes | no: outgoing mail (sign-up, password reset, mail plugins); the password: VUMLO__MAIL__TRANSPORT__PASSWORD
      "mail-from": { type: "string" },
      "mail-host": { type: "string" },
      "mail-tls": { type: "string" }, // starttls | tls | none
      "mail-port": { type: "string" },
      "mail-user": { type: "string" },
      files: { type: "string" }, // local | s3; the keys: VUMLO__FILES__S3__ACCESS_KEY and VUMLO__FILES__S3__SECRET_KEY
      "s3-endpoint": { type: "string" }, // https only; empty: AWS
      "s3-bucket": { type: "string" },
      "s3-region": { type: "string" },
      "skip-checks": { type: "boolean" }, // do not log in to the mail server and ask the bucket before writing anything
      "admin-origin": { type: "string" }, // the admin console's own address (default: admin. before the host, or the next port on localhost)
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
      start: { type: "boolean" }, // after installing (or `plugins add`): build, migrate, create the administrator, start; needs Docker
      "admin-email": { type: "string" }, // with --start: the first administrator (the password: VUMLO_ADMIN_PASSWORD, else one is generated)
      "admin-name": { type: "string" },
      "admin-surname": { type: "string" },
      set: { type: "string", multiple: true }, // module.setting=value, e.g. ai_agent.model=gpt-4o-mini (a module's secret key comes from its environment variable)
      "grant-plugins": { type: "boolean" }, // with --start: register each plugin with all it asks for, for all courses (without it: asked, or left for later)
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: true,
  });
  if (f["list-plugins"]) return pluginsCmd(f, "list", [], undefined);
  if (positionals.length === 1 && positionals[0] === "update") return update(f);
  if (positionals[0] === "plugins" && positionals[1] === "register") return registerCmd(f, positionals.slice(2), resolve(f.dir ?? "."));
  if (positionals[0] === "plugins" && ["list", "add"].includes(positionals[1]) && (positionals[1] === "add" || positionals.length === 2)) {
    return pluginsCmd(f, positionals[1], positionals.slice(2), resolve(f.dir ?? "."));
  }
  if (positionals.length) throw new Error(`unknown command "${positionals.join(" ")}" (there are: update, plugins list, plugins add [name...], plugins register [name...])`);
  // A flag wins; with --yes or no terminal the default is taken; otherwise ask.
  const quiet = f.yes || !process.stdin.isTTY;
  const ask = async (given, fallback, prompt) => (given !== undefined ? given : quiet ? fallback : ok(await prompt()));

  p.intro("Vumlo installer");
  if (f.accent !== undefined && !ACCENTS.includes(f.accent)) throw new Error(`accent must be one of ${ACCENTS.join(", ")}, not "${f.accent}"`);

  const dir = resolve(
    await ask(f.dir, "vumlo", () => p.text({ message: "Where to install?", placeholder: "vumlo", defaultValue: "vumlo" })),
  );
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!existsSync(join(dir, UNFINISHED))) throw new Error(`${dir} is not empty.`);
    await startOver(dir, quiet);
  }

  const s = p.spinner();
  const created = !existsSync(dir);
  const scratch = tempDir(); // the plugins release is unpacked here; removed below whatever happens
  let setup; // set when the installation is to be started: run after the files are safely written
  try {
    s.start(f.archive ? "Unpacking" : "Downloading the latest release");
    const rel = f.archive ? { tag: "local archive" } : await fetchRelease(f.version);
    mkdirSync(dir, { recursive: true });
    unpack(dir, { file: f.archive && resolve(f.archive), bytes: rel.bytes });
    writeFileSync(join(dir, UNFINISHED), "");
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
        validate: (v = "") => (v.length > 50 ? "50 characters at most" : undefined),
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
    const adminOrigin = await ask(f["admin-origin"], defaultAdminOrigin(origin), () =>
      p.text({ message: "Address of the admin console (administrators sign in there)", placeholder: defaultAdminOrigin(origin), defaultValue: defaultAdminOrigin(origin) }),
    );
    checkAdminOrigin(adminOrigin, origin);
    const domains = parseDomains(
      await ask(f.domains, "", () =>
        p.text({
          message: "Email domains whose people may sign up themselves (comma separated; empty: nobody, you add people)",
          placeholder: guessDomain(origin) || "example.edu",
          defaultValue: "",
          validate: (v) => {
            try {
              parseDomains(v ?? "");
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
    // What a module cannot start without. Quiet runs take the defaults, so config check passes; the key can come later.
    const settings = {};
    const keys = {};
    const given = Object.fromEntries((f.set ?? []).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)])); // --set module.field=value
    for (const [name] of Object.entries(given)) {
      const [m, field] = name.split(".");
      if (!modules.includes(m) || !MODULE_SETTINGS[m]?.fields.some((x) => x.name === field)) throw new Error(`--set ${name}: not a setting of a module you picked`);
    }
    for (const m of modules.filter((x) => MODULE_SETTINGS[x])) {
      const d = MODULE_SETTINGS[m];
      p.log.info(`${m}: its other options keep their defaults; edit [modules.${m}] in vumlo.toml later.`);
      settings[m] = {};
      for (const x of d.fields) {
        settings[m][x.name] = await ask(given[`${m}.${x.name}`], x.default, () => p.text({ message: `${m}: ${x.label}`, defaultValue: x.default, placeholder: x.default }));
      }
      if (d.key) {
        keys[d.key] = process.env[d.key] ?? (quiet ? "" : ok(await p.password({ message: `${m}: secret key (empty: put ${d.key} in .env later)` })));
        if (!keys[d.key]) p.log.warn(`${m} may answer nothing until ${d.key} is set in .env (then docker compose up -d).`);
      }
    }
    const plugins =
      f.plugins !== undefined
        ? resolvePlugins(f.plugins, available.map((x) => x.name))
        : available.length && !quiet
          ? await chooseFrom(available)
          : [];
    if (!available.length && f.plugins === undefined && !quiet) p.log.info("The plugins release has no plugins.");

    // What the first run needs (ADR-0096): outgoing mail and where files live, checked before anything is written or started.
    const required = (v) => (v?.trim() ? undefined : "required");
    if (f.mail !== undefined && !["yes", "no"].includes(f.mail)) throw new Error(`--mail takes yes or no, not "${f.mail}"`);
    const mailAnswers = {
      mail: f.mail ?? (quiet ? "no" : ok(await p.confirm({ message: "Send mail? (sign-up, password reset and mail plugins need it)", initialValue: false })) ? "yes" : "no"),
    };
    let mailPassword = "";
    if (mailAnswers.mail === "yes") {
      mailAnswers.host = await ask(f["mail-host"], "", () => p.text({ message: "SMTP host", placeholder: "smtp.example.edu", validate: required }));
      mailAnswers.tls = await ask(f["mail-tls"], "starttls", () =>
        p.select({ message: "Encryption", options: [{ value: "starttls", hint: "port 587" }, { value: "tls", hint: "port 465" }, { value: "none", hint: "port 25, a local server" }] }),
      );
      const port = String(defaultPort(mailAnswers.tls) ?? "");
      mailAnswers.port = await ask(f["mail-port"], port, () => p.text({ message: "Port", placeholder: port, defaultValue: port }));
      mailAnswers.user = await ask(f["mail-user"], "", () => p.text({ message: "User name (empty: no login)", defaultValue: "" }));
      const fallbackFrom = mailSettings({ mail: "yes", host: "x" }, name, origin).from;
      mailAnswers.from = await ask(f["mail-from"], fallbackFrom, () => p.text({ message: "Sender", placeholder: fallbackFrom, defaultValue: fallbackFrom }));
      mailPassword = process.env.VUMLO__MAIL__TRANSPORT__PASSWORD ?? (quiet || !mailAnswers.user ? "" : ok(await p.password({ message: "SMTP password" })));
    }
    const mail = mailSettings(mailAnswers, name, origin);
    const filesAnswers = {
      files: await ask(f.files, "local", () =>
        p.select({ message: "Where do uploaded files live?", options: [{ value: "local", label: "On this server (a directory)" }, { value: "s3", label: "In an S3 bucket" }] }),
      ),
    };
    if (filesAnswers.files === "s3") {
      filesAnswers.endpoint = await ask(f["s3-endpoint"], "", () => p.text({ message: "S3 endpoint (empty: AWS)", placeholder: "https://s3.example.edu", defaultValue: "" }));
      filesAnswers.bucket = await ask(f["s3-bucket"], "", () => p.text({ message: "S3 bucket", validate: required }));
      filesAnswers.region = await ask(f["s3-region"], "eu-north-1", () => p.text({ message: "S3 region", placeholder: "eu-north-1", defaultValue: "eu-north-1" }));
    }
    const files = filesSettings(filesAnswers);
    const s3Keys = { accessKey: "", secretKey: "" };
    if (files.storage === "s3") {
      s3Keys.accessKey = process.env.VUMLO__FILES__S3__ACCESS_KEY ?? (quiet ? "" : ok(await p.password({ message: "S3 access key" })));
      s3Keys.secretKey = process.env.VUMLO__FILES__S3__SECRET_KEY ?? (quiet ? "" : ok(await p.password({ message: "S3 secret key" })));
    }
    if (!f["skip-checks"]) {
      if (mail) {
        s.start("Checking the mail server");
        await checkSmtp(mail, mailPassword);
        s.stop("The mail server accepts the login");
      }
      if (files.storage === "s3") {
        if (!s3Keys.accessKey || !s3Keys.secretKey) throw new Error("S3 needs the keys: set VUMLO__FILES__S3__ACCESS_KEY and VUMLO__FILES__S3__SECRET_KEY in the environment (or --skip-checks to fill them in .env later)");
        s.start("Checking the bucket");
        await checkS3(files, s3Keys);
        s.stop("The bucket answers");
      }
    } else if (files.storage === "s3" && !(s3Keys.accessKey && s3Keys.secretKey)) {
      p.log.warn("The S3 keys are not set: put VUMLO__FILES__S3__ACCESS_KEY and VUMLO__FILES__S3__SECRET_KEY in .env before starting.");
    }

    // Whether to go on and run it: the steps of docs/install.md, with the administrator asked for here.
    const docker = hasDocker();
    if (!docker && !quiet && f.start === undefined) p.log.info("Docker with Compose was not found: the installer only prepares the files.");
    const start =
      f.start ??
      (quiet || !docker ? false : ok(await p.confirm({ message: "Build and start it now? (build, migrate, create the administrator, start, register the plugins)", initialValue: true })));
    if (start && !docker) throw new Error("--start needs Docker with the Compose plugin (docker compose)");
    let admin;
    if (start) {
      const email = await ask(f["admin-email"], "", () =>
        p.text({ message: "Administrator email (empty: create it later)", defaultValue: "", validate: (v) => (v && !/^\S+@\S+\.\S+$/.test(v) ? "that is not an email address" : undefined) }),
      );
      if (email) {
        const required = (v) => (v?.trim() ? undefined : "required");
        const adminName = await ask(f["admin-name"], "Admin", () => p.text({ message: "Administrator first name", validate: required }));
        const surname = await ask(f["admin-surname"], "Admin", () => p.text({ message: "Administrator last name", validate: required }));
        const given = process.env.VUMLO_ADMIN_PASSWORD ?? (quiet ? "" : ok(await p.password({ message: "Administrator password (empty: generate one, shown once at the end)" })));
        admin = { email, name: adminName, surname, password: given || randomBytes(12).toString("base64url"), generated: !given };
      }
    }
    const consent = f["grant-plugins"] ? true : quiet ? false : "ask";
    // Only what was picked stays on disk. The desktop app builds from web/, so web/ stays for either.
    if (!parts.includes("web") && !parts.includes("desktop")) rmSync(join(dir, "web"), { recursive: true, force: true });
    if (!parts.includes("desktop")) rmSync(join(dir, "desktop"), { recursive: true, force: true });
    // The admin console is built with the web app (ADR-0095).
    if (!parts.includes("web")) rmSync(join(dir, "web-admin"), { recursive: true, force: true });
    if (!parts.includes("web")) {
      const compose = join(dir, "deploy/compose.yaml");
      writeFileSync(compose, dropWebService(readFileSync(compose, "utf8")));
    }

    const read = (rel) => readFileSync(join(dir, rel), "utf8");
    writeFileSync(join(dir, "vumlo.toml"), patchToml(read("deploy/vumlo.example.toml"), { name, mode, origin, adminOrigin, modules, short, accent, domains, language, timeZone, settings, mail, files, proxy: origin.startsWith("https://") }));
    writeFileSync(join(dir, ".env"), patchEnv(read("deploy/env.example"), {
        password: randomBytes(18).toString("hex"),
        modules,
        keys,
        secrets: { VUMLO__MAIL__TRANSPORT__PASSWORD: mail ? mailPassword : "", VUMLO__FILES__S3__ACCESS_KEY: s3Keys.accessKey, VUMLO__FILES__S3__SECRET_KEY: s3Keys.secretKey },
      }));
    chmodSync(join(dir, ".env"), 0o600);
    // For /etc/default/caddy (deploy/Caddyfile reads the two domains from there): only for two real https hostnames.
    const caddy = caddyEnv(origin, adminOrigin);
    if (caddy) writeFileSync(join(dir, "caddy.env"), caddy);
    const proxyNote = caddy
      ? [
          "",
          "# The proxy: Caddy in front, with the two domains in caddy.env. It must overwrite X-Real-IP:",
          "# vumlo.toml has server.client_ip_header, which trusts it.",
          "sudo cp deploy/Caddyfile /etc/caddy/Caddyfile",
          "sudo tee -a /etc/default/caddy < caddy.env",
          "sudo systemctl restart caddy",
        ]
      : [];
    if (plugins.length) addPlugins(dir, scratch, plugins);

    const installed = `Installed: backend${parts.map((x) => ` + ${x}`).join("")}${modules.map((m) => ` + ${m}`).join("")}${plugins.map((n) => ` + plugin ${n}`).join("")}. Secrets are in ${join(dir, ".env")}.`;
    if (start) {
      p.log.success(installed);
      setup = { dir, admin, plugins, consent, origin, adminOrigin, proxyNote };
    } else {
      rmSync(join(dir, UNFINISHED), { force: true });
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
          ...(adminOriginIn(readFileSync(join(dir, "vumlo.toml"), "utf8")) ? [`# The admin console is ${adminOrigin} (docker compose starts it on 127.0.0.1:3001; a domain needs its own Caddy block, docs/install.md)`] : []),
          ...proxyNote,
          ...(plugins.length ? ["", "# Plugins: each registers once the core is up (VUMLO__PLUGINS__SECRET_KEY is set in .env).", ...pluginSteps(plugins)] : []),
          "",
          "# To look around first, after the migration: ./vumlo seed --demo",
          "# Later: npx create-vumlo update (inside this folder); the guide is docs/install.md (TLS, mail, upgrades, backups)",
          "# All of this in one go: npx create-vumlo --start",
        ].join("\n"),
        "Next",
      );
      p.outro(installed);
    }
  } catch (e) {
    s.stop("Failed");
    // The folder was empty when the run began (or did not exist), so everything in it is this run's.
    if (created) rmSync(dir, { recursive: true, force: true });
    else if (existsSync(dir)) removeContents(dir);
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Outside the try above: a step that fails here must not remove the files that were just written.
  if (setup) {
    await bringUp(setup.dir, setup);
    rmSync(join(setup.dir, UNFINISHED), { force: true });
    const { admin: a } = setup;
    p.note(
      [
        `Open ${setup.origin}`,
        ...(adminOriginIn(readFileSync(join(setup.dir, "vumlo.toml"), "utf8")) ? [`Administration is at ${setup.adminOrigin}: the same email and password, its own sign-in`] : []),
        ...(a ? [`Sign in as ${a.email}${a.generated ? `  with the password ${a.password}  (shown once: change it)` : ""}`] : ["No administrator yet: ./vumlo admin create you@example.edu --name Your --surname Name"]),
        "",
        ...setup.proxyNote,
        "",
        `cd ${setup.dir}`,
        "./vumlo seed --demo      # sample data, to look around",
        "./vumlo doctor           # check the installation",
        "npx create-vumlo update  # later, a newer release; the guide is docs/install.md (TLS, mail, upgrades, backups)",
      ].join("\n"),
      "Running",
    );
    p.outro("Vumlo is running.");
  }
}

// Run as a program, not imported by the test. `npx` and `npm i -g` start it through a symlink, so the path is resolved first.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main().catch((e) => {
    p.cancel(e.message);
    process.exit(1);
  });
}
