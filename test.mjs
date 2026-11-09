import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultShort, dropWebService, guessDomain, parseDomains, patchEnv, patchToml } from "./index.mjs";

// Run against the real example files of the sibling checkout: a release that changes them breaks this.
const core = new URL("../vumlo-core/deploy/", import.meta.url);
const read = (n) => readFileSync(new URL(n, core), "utf8");

const toml = patchToml(read("vumlo.example.toml"), { name: 'Uni "X"', mode: "school", origin: "https://lms.example.edu", modules: ["vpl"] });
assert.match(toml, /^name = "Uni \\"X\\""$/m);
assert.match(toml, /^mode = "school"$/m);
assert.match(toml, /^public_origin = "https:\/\/lms.example.edu"$/m);
assert.match(toml, /^cookie_secure = true$/m);
assert.match(toml, /^\[modules\]\nvpl = true$/m);

const env = patchEnv(read("env.example"), { password: "pw", modules: ["vpl", "ai-agent"] });
assert.match(env, /^DATABASE_URL=postgres:\/\/vumlo:pw@postgres:5432\/vumlo$/m);
assert.match(env, /^POSTGRES_PASSWORD=pw$/m);
assert.match(env, /^VUMLO_FEATURES=vpl,ai-agent$/m);

const compose = dropWebService(read("compose.yaml"));
assert.ok(!/^  web:/m.test(compose) && /^volumes:/m.test(compose) && /^  worker:/m.test(compose));
console.log("ok");

// The questions added in 0.2.0.
const full = patchToml(read("vumlo.example.toml"), { name: "Example University", mode: "university", origin: "https://lms.example.edu", modules: [], short: "EU", domains: ["example.edu", "cs.example.edu"], language: "uk", timeZone: "Europe/Kyiv" });
assert.match(full, /^short_name = "EU"$/m);
assert.match(full, /^allowed_domains = \["example.edu","cs.example.edu"\]$/m);
assert.match(full, /^language = "uk"$/m);
assert.match(full, /^time_zone = "Europe\/Kyiv"$/m);
// Left as the example has them when nothing was asked for.
const plain = patchToml(read("vumlo.example.toml"), { name: "X", mode: "school", origin: "http://localhost:3000", modules: [] });
assert.match(plain, /^allowed_domains = \[\]/m);
assert.match(plain, /^# short_name = /m);

assert.equal(defaultShort("Example University"), "EU");
assert.equal(defaultShort("Northfield"), "Northfield");
assert.equal(defaultShort("  "), "Vumlo");
assert.equal(guessDomain("https://lms.example.edu"), "example.edu");
assert.equal(guessDomain("http://localhost:3000"), "");
assert.equal(guessDomain("http://192.168.1.5:3000"), "");
assert.deepEqual(parseDomains("Example.edu, @cs.example.edu ,"), ["example.edu", "cs.example.edu"]);
assert.deepEqual(parseDomains(""), []);
assert.throws(() => parseDomains("not a domain"), /not an email domain/);
console.log("ok (0.2.0)");

// 0.3.0: the accent. The real example only has the line from release 0.5.0 on, so the text is built here.
const base = { name: "X", mode: "school", origin: "http://localhost:3000", modules: [] };
// (a core checkout that already has the line gets it once, not twice)
const withAccent = read("vumlo.example.toml").replace(/^# accent = .*\n/m, "").replace(/^# short_name = .*$/m, (l) => `${l}\n# accent = "violet"`);
assert.match(patchToml(withAccent, { ...base, accent: "teal" }), /^accent = "teal"$/m);
assert.match(patchToml(withAccent, { ...base, accent: "violet" }), /^# accent = "violet"$/m);
assert.match(patchToml(withAccent, base), /^# accent = "violet"$/m);
const noAccent = withAccent.replace(/^# accent = .*\n/m, "");
assert.doesNotThrow(() => patchToml(noAccent, { ...base, accent: "violet" }));
assert.throws(() => patchToml(noAccent, { ...base, accent: "red" }), /older than 0\.5\.0/);
console.log("ok (accent)");

// `npx` runs the program through a symlink: it must still start (0.1.0 and 0.2.0 silently did nothing then).
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const link = join(mkdtempSync(join(tmpdir(), "create-vumlo-")), "create-vumlo");
symlinkSync(new URL("./index.mjs", import.meta.url).pathname, link);
const run = (extra) => { try { return execFileSync(process.execPath, [link, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `${e.stdout}${e.stderr}`; } };
assert.match(run(["--archive", "/nonexistent.tar.gz", "--dir", join(tmpdir(), "create-vumlo-never"), "--yes"]), /Vumlo installer/, "the program did not start through a symlink");
console.log("ok (symlink)");

// 0.3.0: plugins, as written to plugins/compose.yaml.
import { addPluginEnv, composeVersionOf, describePlugin, entriesToReplace, listPlugins, pluginCompose, pluginLines, resolvePlugins, versionOf } from "./index.mjs";
const pc = pluginCompose(["text-metrics", "ical-feed"]);
assert.match(pc, /^services:\n {2}plugin-text-metrics:\n {4}build:\n {6}context: \.\.\/plugins\n {6}args:\n {8}PLUGIN: text-metrics$/m);
assert.match(pc, /^ {2}plugin-ical-feed:$/m);
assert.match(pc, /VUMLO_API: http:\/\/core:8080$/m);
assert.match(pc, /VUMLO_PLUGIN_TOKEN: \$\{PLUGIN_TEXT_METRICS_TOKEN:-\}$/m);
assert.match(pc, /VUMLO_WEBHOOK_SECRET: \$\{PLUGIN_ICAL_FEED_SECRET:-\}$/m);
assert.ok(!/ports:/.test(pc), "a plugin must not publish a port");
// .env: what is missing is added, what is there is never touched.
const e1 = addPluginEnv("DATABASE_URL=x\n# VUMLO__PLUGINS__SECRET_KEY=\n", ["text-metrics"], "k1");
assert.match(e1, /^VUMLO__PLUGINS__SECRET_KEY=k1$/m);
assert.match(e1, /^PLUGIN_TEXT_METRICS_TOKEN=\nPLUGIN_TEXT_METRICS_SECRET=\n$/m);
const e2 = addPluginEnv(e1.replace("TOKEN=", "TOKEN=tok").replace("k1", "mine"), ["text-metrics", "ical-feed"], "k2");
assert.match(e2, /^VUMLO__PLUGINS__SECRET_KEY=mine$/m);
assert.match(e2, /^PLUGIN_TEXT_METRICS_TOKEN=tok$/m);
assert.equal(e2.match(/^PLUGIN_TEXT_METRICS_TOKEN=/gm).length, 1);
assert.match(e2, /^PLUGIN_ICAL_FEED_TOKEN=\nPLUGIN_ICAL_FEED_SECRET=\n$/m);
assert.equal(addPluginEnv(e2, ["ical-feed"], "k3"), e2);
assert.match(addPluginEnv("A=1", [], "k"), /^A=1\nVUMLO__PLUGINS__SECRET_KEY=k\n$/);
// The menu line of a plugin: the first prose line of its README.
assert.equal(describePlugin("# Text metrics\n\n[![ci](x)](y)\n\nWord and **reading-time** counts for `text` fields.\n\nMore."), "Word and reading-time counts for text fields.");
assert.equal(describePlugin("# Only a heading\n"), "");
assert.equal(describePlugin(undefined), "");
assert.equal(describePlugin(`# T\n\n${"word ".repeat(30)}`).length, 80);
assert.ok(describePlugin(`# T\n\n${"word ".repeat(30)}`).endsWith("…"));
assert.deepEqual(resolvePlugins("b, a,b", ["a", "b", "c"]), ["b", "a"]);
assert.deepEqual(resolvePlugins("all", ["a", "b"]), ["a", "b"]);
assert.throws(() => resolvePlugins("zz", ["a", "b"]), /no plugin "zz" \(it has: a, b\)/);
assert.deepEqual(pluginLines([{ name: "a", description: "One" }, { name: "bcd", description: "" }], ["bcd"]), ["a    One", "bcd  (installed)"]);
console.log("ok (plugins)");

// 0.3.0: update helpers.
assert.equal(versionOf('[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.4.1"\nedition = "2024"\n\n[workspace.dependencies]\nversion = "9"\n'), "0.4.1");
assert.equal(versionOf('[package]\nversion = "1.0.0"\n'), undefined);
assert.equal(composeVersionOf("image: vumlo-web:${VUMLO_VERSION:-0.4.1}"), "0.4.1");
const top = ["backend", "web", "desktop", "deploy", "vumlo", ".dockerignore", "vumlo.toml.example"];
assert.deepEqual(entriesToReplace(top, ["backend", "web", "desktop", "vumlo.toml", ".env", "plugins", "backups"]), top);
assert.deepEqual(entriesToReplace([...top, "plugins", "backups"], ["backend", "web", "vumlo.toml"]), ["backend", "web", "deploy", "vumlo", ".dockerignore", "vumlo.toml.example"]);
assert.deepEqual(entriesToReplace(top, ["backend", "deploy"]), ["backend", "deploy", "vumlo", ".dockerignore", "vumlo.toml.example"]);
console.log("ok (update helpers)");

// 0.3.0: the whole program against fixture archives (a fake release layout; no network).
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const work = mkdtempSync(join(tmpdir(), "create-vumlo-test-"));
const put = (root, rel, text, mode) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mode) chmodSync(join(root, rel), mode);
};
// The shape of vumlo-core/deploy/compose.yaml, shortened.
const composeFixture = (v) => `name: vumlo

services:
  postgres:
    image: postgres:18

  core:
    image: vumlo-backend:\${VUMLO_VERSION:-${v}}
    command: ["vumlo-server", "serve", "--no-worker"]

  # The browser-facing origin (server.public_origin in vumlo.toml) points here, or at a reverse
  # proxy in front of it (deploy/Caddyfile). The web app forwards /api/v1 to the core.
  web:
    build:
      context: ..
    image: vumlo-web:\${VUMLO_VERSION:-${v}}
    depends_on:
      - core

volumes:
  postgres-data:
`;
const release = (v) => {
  const root = join(work, `src-${v}`);
  const top = join(root, `vumlo-${v}`);
  put(top, "deploy/vumlo.example.toml", 'name = "Vumlo"\nmode = "university"\npublic_origin = "http://localhost:3000"\n# short_name = "UCU"\n# accent = "violet"\nallowed_domains = []\n# language = "en"\n# time_zone = "UTC"\ncookie_secure = false\n\n# [modules]\n# some-module = true\n');
  put(top, "deploy/env.example", "DATABASE_URL=postgres://x\nPOSTGRES_PASSWORD=x\n# VUMLO_FEATURES=\n# VUMLO__PLUGINS__SECRET_KEY=\n");
  put(top, "deploy/compose.yaml", composeFixture(v));
  put(top, "deploy/update.sh", "#!/bin/sh\n", 0o755);
  put(top, "backend/Cargo.toml", `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${v}"\n`);
  put(top, "backend/crates/modules/ai_agent/Cargo.toml", "");
  put(top, "web/index.txt", `web ${v}\n`);
  put(top, "desktop/index.txt", `desktop ${v}\n`);
  put(top, "vumlo", `#!/bin/sh\n# ${v}\n`, 0o755);
  put(top, "CHANGELOG.md", `# ${v}\n`);
  const file = join(root, `vumlo-${v}-source.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", root, `vumlo-${v}`]);
  return file;
};
const pluginsRelease = () => {
  const root = join(work, "src-plugins");
  const top = join(root, "Vumlo-vumlo-plugins-abc123");
  for (const n of ["text-metrics", "ical-feed", "at-risk-students"]) put(top, `${n}/app.py`, "app = 1\n");
  put(top, "text-metrics/README.md", "# text-metrics\n\nCounts words and reading time of text fields.\n");
  put(top, "ical-feed/README.md", "# ical-feed\n\nA calendar feed of your deadlines.\n");
  put(top, "text-metrics/__pycache__/app.pyc", "x");
  put(top, "tests/test_x.py", "");
  for (const n of ["vumlo_plugins/__init__.py", "pyproject.toml", "uv.lock", "Dockerfile", "LICENSE"]) put(top, n, `${n}\n`);
  const file = join(root, "plugins.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", root, "Vumlo-vumlo-plugins-abc123"]);
  return file;
};
const v1 = release("0.5.0");
const v2 = release("0.6.0");
const pl = pluginsRelease();
const cli = (...args) => {
  const r = spawnSync(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const text = (...parts) => readFileSync(join(...parts), "utf8");
const tree = (dir) => readdirSync(dir, { recursive: true });

// Install: the desktop app alone keeps web/ but not the web service; plugins land in plugins/.
const scratchDirs = () => readdirSync(tmpdir()).filter((x) => x.startsWith("create-vumlo-")).sort();
const scratchBefore = scratchDirs();
const a = join(work, "a");
let r = cli("--archive", v1, "--yes", "--dir", a, "--accent", "teal", "--parts", "desktop", "--modules", "ai_agent", "--plugins", "text-metrics,ical-feed", "--plugins-archive", pl);
assert.equal(r.code, 0, r.out);
assert.ok(existsSync(join(a, "web/index.txt")) && existsSync(join(a, "desktop/index.txt")), "web/ must stay for the desktop app");
assert.ok(!/^ {2}web:/m.test(text(a, "deploy/compose.yaml")), "the web service must be dropped");
assert.match(text(a, "vumlo.toml"), /^accent = "teal"$/m);
assert.match(text(a, "vumlo.toml"), /^\[modules\]\nai_agent = true$/m);
assert.match(text(a, ".env"), /^VUMLO_FEATURES=ai_agent$/m);
assert.match(text(a, ".env"), /^VUMLO__PLUGINS__SECRET_KEY=.{40,}$/m);
assert.match(text(a, ".env"), /^PLUGIN_TEXT_METRICS_TOKEN=$/m);
assert.match(text(a, ".env"), /^PLUGIN_TEXT_METRICS_SECRET=$/m);
assert.equal(statSync(join(a, ".env")).mode & 0o777, 0o600);
assert.match(text(a, ".env"), /^PLUGIN_ICAL_FEED_TOKEN=$/m);
assert.equal(text(a, "plugins/compose.yaml"), pluginCompose(["ical-feed", "text-metrics"]));
assert.deepEqual(listPlugins(join(a, "plugins")), ["ical-feed", "text-metrics"], "two plugins in one go");
for (const n of ["Dockerfile", "LICENSE", "pyproject.toml", "uv.lock", "vumlo_plugins/__init__.py", "text-metrics/app.py", "ical-feed/app.py"]) assert.ok(existsSync(join(a, "plugins", n)), n);
assert.ok(!existsSync(join(a, "plugins/at-risk-students")) && !existsSync(join(a, "plugins/tests")) && !existsSync(join(a, "plugins/text-metrics/__pycache__")));
assert.ok(!tree(a).some((x) => x.split("/").includes(".vumlo")), "no .vumlo folder");
assert.deepEqual(scratchDirs(), scratchBefore, "the scratch dir must be removed");

// Wrong values are refused with a clear message, and nothing is left behind.
r = cli("--archive", v1, "--yes", "--dir", join(work, "bad"), "--accent", "pink");
assert.notEqual(r.code, 0);
assert.match(r.out, /accent must be one of violet, blue/);
r = cli("--archive", v1, "--yes", "--dir", join(work, "bad"), "--plugins", "nope", "--plugins-archive", pl);
assert.notEqual(r.code, 0);
assert.match(r.out, /no plugin "nope" \(it has: at-risk-students, ical-feed, text-metrics\)/);

// --list-plugins and `plugins list` print the plugins with their descriptions and install nothing.
const lp = join(work, "listed");
r = cli("--list-plugins", "--plugins-archive", pl, "--dir", lp);
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Found 3 plugins/);
assert.match(r.out, /ical-feed +A calendar feed of your deadlines\./);
assert.match(r.out, /text-metrics +Counts words and reading time of text fields\./);
assert.match(r.out, /at-risk-students/);
assert.ok(!existsSync(lp) && !existsSync(join(work, "vumlo")), "--list-plugins installs nothing");
assert.ok(!existsSync(join(work, "bad")));

// Backend alone: neither web/ nor desktop/.
const b = join(work, "b");
assert.equal(cli("--archive", v1, "--yes", "--dir", b, "--parts", "").code, 0);
assert.ok(!existsSync(join(b, "web")) && !existsSync(join(b, "desktop")) && !existsSync(join(b, "plugins")));
assert.match(text(b, "vumlo.toml"), /^# accent = "violet"$/m);

// Update: replaces what the release has, keeps what is the administrator's, backs up first.
put(a, "web/local-edit.txt", "mine\n");
put(a, "plugins/text-metrics/mine.txt", "mine\n");
const kept = { toml: text(a, "vumlo.toml"), env: text(a, ".env"), compose: text(a, "plugins/compose.yaml") };
assert.equal(cli("update", "--dir", join(work, "nowhere")).code, 1);
assert.match(cli("update", "--dir", work).out, /has no vumlo\.toml/);
r = cli("update", "--archive", v2, "--dir", a);
assert.equal(r.code, 0, r.out);
assert.equal(text(a, "web/index.txt"), "web 0.6.0\n");
assert.equal(text(a, "desktop/index.txt"), "desktop 0.6.0\n");
assert.ok(!existsSync(join(a, "web/local-edit.txt")), "web/ is replaced as a whole");
assert.match(text(a, "backend/Cargo.toml"), /version = "0\.6\.0"/);
assert.ok(statSync(join(a, "vumlo")).mode & 0o100, "the wrapper must stay executable");
assert.ok(!/^ {2}web:/m.test(text(a, "deploy/compose.yaml")) && /:-0\.6\.0\}/.test(text(a, "deploy/compose.yaml")), "the new compose keeps the web service dropped");
assert.equal(text(a, "vumlo.toml"), kept.toml);
assert.equal(text(a, ".env"), kept.env);
assert.equal(text(a, "plugins/compose.yaml"), kept.compose);
assert.equal(text(a, "plugins/text-metrics/mine.txt"), "mine\n");
const backup = join(a, "backups/vumlo-0.5.0-files.tar.gz");
assert.ok(existsSync(backup), r.out);
const listed = execFileSync("tar", ["-tzf", backup], { encoding: "utf8" });
assert.match(listed, /^web\/local-edit\.txt$/m);
assert.match(listed, /^web\/index\.txt$/m);
assert.ok(!/^(plugins|vumlo\.toml|\.env)/m.test(listed), "the backup holds only replaced files");
assert.ok(!tree(a).some((x) => x.split("/").includes(".vumlo")));
assert.match(cli("update", "--archive", v2, "--dir", a).out, /Already up to date \(0\.6\.0\)/);

// `plugins list` marks the installed ones; `plugins add` adds a third without touching the first two or the .env values.
r = cli("plugins", "list", "--dir", a, "--plugins-archive", pl);
assert.match(r.out, /text-metrics .*\(installed\)/);
assert.match(r.out, /at-risk-students/);
assert.ok(!/at-risk-students.*\(installed\)/.test(r.out));
const envBefore = text(a, ".env").replace("PLUGIN_TEXT_METRICS_TOKEN=", "PLUGIN_TEXT_METRICS_TOKEN=tok-1");
writeFileSync(join(a, ".env"), envBefore);
put(a, "plugins/ical-feed/mine.txt", "mine\n");
put(a, "plugins/Dockerfile", "# edited by the administrator\n");
assert.notEqual(cli("plugins", "add", "--dir", a, "--plugins-archive", pl).code, 0, "no names and no terminal");
assert.match(cli("plugins", "add", "nope", "--dir", a, "--plugins-archive", pl).out, /no plugin "nope"/);
assert.match(cli("plugins", "add", "x", "--dir", work, "--plugins-archive", pl).out, /has no vumlo\.toml/);
r = cli("plugins", "add", "at-risk-students", "text-metrics", "--dir", a, "--plugins-archive", pl);
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Already installed, left as they are: text-metrics/);
assert.ok(existsSync(join(a, "plugins/at-risk-students/app.py")));
assert.equal(text(a, "plugins/ical-feed/mine.txt"), "mine\n");
assert.equal(text(a, "plugins/text-metrics/mine.txt"), "mine\n");
assert.equal(text(a, "plugins/Dockerfile"), "# edited by the administrator\n");
assert.equal(text(a, "plugins/compose.yaml"), pluginCompose(["at-risk-students", "ical-feed", "text-metrics"]));
const envAfter = text(a, ".env");
assert.ok(envAfter.startsWith(envBefore), "existing .env content is untouched, new lines come after it");
assert.match(envAfter, /^PLUGIN_TEXT_METRICS_TOKEN=tok-1$/m);
assert.match(envAfter, /^PLUGIN_AT_RISK_STUDENTS_TOKEN=\nPLUGIN_AT_RISK_STUDENTS_SECRET=\n$/m);
assert.equal(statSync(join(a, ".env")).mode & 0o777, 0o600);
assert.match(r.out, /plugin install http:\/\/plugin-at-risk-students:8000/);
assert.ok(!/plugin install http:\/\/plugin-text-metrics/.test(r.out));
assert.equal(cli("plugins", "add", "all", "--dir", a, "--plugins-archive", pl).code, 0);
assert.equal(text(a, ".env"), envAfter, "adding what is there changes nothing");
assert.equal(text(a, "vumlo.toml"), kept.toml);
assert.deepEqual(scratchDirs(), scratchBefore, "the scratch dir must be removed");

// An installation without web/ and desktop/ does not get them back.
assert.equal(cli("update", "--archive", v2, "--dir", b).code, 0);
assert.ok(!existsSync(join(b, "web")) && !existsSync(join(b, "desktop")) && existsSync(join(b, "backups/vumlo-0.5.0-files.tar.gz")));
assert.ok(!/^ {2}web:/m.test(text(b, "deploy/compose.yaml")));

// An unknown installed version needs --yes.
rmSync(join(b, "backend/Cargo.toml"));
rmSync(join(b, "deploy/compose.yaml"));
assert.match(cli("update", "--archive", v1, "--dir", b).out, /cannot tell which version/);
rmSync(work, { recursive: true, force: true });
console.log("ok (install and update, fixtures)");
