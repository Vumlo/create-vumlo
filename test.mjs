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
const withAccent = read("vumlo.example.toml").replace(/^# short_name = .*$/m, (l) => `${l}\n# accent = "violet"`);
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
