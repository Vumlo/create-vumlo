#!/usr/bin/env node
// create-vumlo: downloads a Vumlo release, keeps only the parts you pick, writes vumlo.toml and .env.
// The result has the same layout as the repository (backend/, web/, desktop/, deploy/, ...).
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

async function main() {
  const { values: f } = parseArgs({
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
      yes: { type: "boolean", short: "y" },
    },
  });
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
  try {
    s.start(f.archive ? "Unpacking" : "Downloading the latest release");
    const rel = f.archive ? { tag: "local archive" } : await fetchRelease(f.version);
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", f.archive ? resolve(f.archive) : "-", "-C", dir, "--strip-components=1"], rel.bytes ? { input: rel.bytes } : {});
    s.stop(`Unpacked ${rel.tag}`);

    const found = existsSync(join(dir, "backend/crates/modules")) ? readdirSync(join(dir, "backend/crates/modules")) : [];

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

    p.note(
      [
        `cd ${dir}`,
        "./vumlo config check && ./vumlo brand apply",
        "export COMPOSE_FILE=deploy/compose.yaml COMPOSE_ENV_FILES=.env",
        "docker compose build",
        "docker compose up -d --wait postgres",
        "./vumlo db migrate",
        "./vumlo admin create you@example.edu --name Your --surname Name",
        "docker compose up -d && ./vumlo doctor",
        "",
        "# To look around first, after the migration: ./vumlo seed --demo",
        "# The guide: docs/install.md (TLS, mail, upgrades, backups)",
      ].join("\n"),
      "Next",
    );
    p.outro(`Installed: backend${parts.map((x) => ` + ${x}`).join("")}${modules.map((m) => ` + ${m}`).join("")}. Secrets are in ${join(dir, ".env")}.`);
  } catch (e) {
    s.stop("Failed");
    if (created) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// Run as a program, not imported by the test. `npx` and `npm i -g` start it through a symlink, so the path is resolved first.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main().catch((e) => {
    p.cancel(e.message);
    process.exit(1);
  });
}
