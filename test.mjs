import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminOriginIn, caddyEnv, checkAdminOrigin, defaultAdminOrigin, defaultPort, defaultShort, dropWebService, filesSettings, guessDomain, mailSettings, parseDomains, patchEnv, patchToml, withAdminOrigin } from "./index.mjs";

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
// The admin console is built from web-admin/, which goes with the web app (ADR-0095): its service goes too.
assert.ok(!/^  console:/m.test(compose), "the console service is dropped with the web service");
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

// ADR-0096: mail, file storage and the proxy settings, written into the real example files.
const origin = "https://lms.example.edu";
const mail = mailSettings({ mail: "yes", host: "smtp.example.edu", user: "vumlo" }, "Example", origin);
assert.deepEqual(mail, { from: "Example <no-reply@lms.example.edu>", host: "smtp.example.edu", tls: "starttls", port: 587, user: "vumlo" });
assert.equal(mailSettings({}, "X", origin), null, "mail is off unless asked for");
assert.equal(mailSettings({ mail: "yes", host: "h", tls: "tls" }, "X", origin).port, 465);
assert.equal(mailSettings({ mail: "yes", host: "h", tls: "none" }, "X", origin).port, 25);
assert.equal(mailSettings({ mail: "yes", host: "h", from: "Me <me@x.edu>" }, "X", origin).from, "Me <me@x.edu>");
assert.equal(mailSettings({ mail: "yes", host: "h" }, 'A <"B">', origin).from, "A B <no-reply@lms.example.edu>");
assert.throws(() => mailSettings({ mail: "yes" }, "X", origin), /host/);
assert.throws(() => mailSettings({ mail: "yes", host: "h", tls: "ssl" }, "X", origin), /starttls, tls or none/);
assert.throws(() => mailSettings({ mail: "yes", host: "h", port: "70000" }, "X", origin), /port/);
assert.equal(defaultPort("starttls"), 587);

assert.deepEqual(filesSettings({}), { storage: "local" });
assert.deepEqual(filesSettings({ files: "s3", bucket: "b" }), { storage: "s3", endpoint: undefined, bucket: "b", region: "eu-north-1" });
assert.deepEqual(filesSettings({ files: "s3", bucket: "b", endpoint: "https://s3.example.edu", region: "r" }), { storage: "s3", endpoint: "https://s3.example.edu", bucket: "b", region: "r" });
assert.throws(() => filesSettings({ files: "s3" }), /bucket/);
assert.throws(() => filesSettings({ files: "s3", bucket: "b", endpoint: "http://s3.example.edu" }), /https/);
assert.throws(() => filesSettings({ files: "gcs" }), /local or s3/);

const exampleToml = read("vumlo.example.toml");
const none = patchToml(exampleToml, { ...base, origin });
const withMail = patchToml(exampleToml, { ...base, origin, mail });
assert.match(withMail, /^\[mail\]\nfrom = "Example <no-reply@lms\.example\.edu>"$/m);
assert.match(withMail, /^\[mail\.transport\]\nkind = "smtp"\nhost = "smtp\.example\.edu"\nport = 587\ntls = "starttls"\nusername = "vumlo"$/m);
assert.ok(!/^password\s*=/m.test(withMail), "the password is never in vumlo.toml");
assert.match(withMail, /^# link_base = /m, "what was not asked stays as the example has it");
assert.ok(!/^\[mail\]/m.test(none) && patchToml(exampleToml, { ...base, origin, mail: null }) === none, "no mail answer, no change");
assert.match(patchToml(exampleToml, { ...base, origin, mail: { ...mail, user: "" } }), /^# username = /m, "no login, no username line");
assert.match(patchToml(exampleToml, { ...base, origin, files: { storage: "local" } }), /^storage = "local"/m);
const s3 = patchToml(exampleToml, { ...base, origin, files: filesSettings({ files: "s3", bucket: "vumlo-files", endpoint: "https://s3.example.edu" }) });
assert.match(s3, /^storage = "s3"/m);
assert.match(s3, /^\[files\.s3\]\nendpoint = "https:\/\/s3\.example\.edu"\nbucket = "vumlo-files"\nregion = "eu-north-1"$/m);
assert.match(s3, /^# endpoint = "https:\/\/api\.openai\.com\/v1"$/m, "the Buddy's endpoint is not touched");
assert.ok(!/^endpoint/m.test(patchToml(exampleToml, { ...base, origin, files: filesSettings({ files: "s3", bucket: "b" }) })), "AWS needs no endpoint");
assert.match(patchToml(exampleToml, { ...base, origin, proxy: true }), /^client_ip_header = "x-real-ip"$/m);
assert.match(none, /^# client_ip_header = "x-real-ip"$/m);

const envSecrets = patchEnv(read("env.example"), { password: "pw", modules: [], secrets: { VUMLO__MAIL__TRANSPORT__PASSWORD: "smtp pw", VUMLO__FILES__S3__ACCESS_KEY: "AK", VUMLO__FILES__S3__SECRET_KEY: "" } });
// Single quotes: docker compose and vumlo-cli both strip one pair, and compose does not expand `$` inside them.
assert.match(envSecrets, /^VUMLO__MAIL__TRANSPORT__PASSWORD='smtp pw'$/m);
assert.match(envSecrets, /^VUMLO__FILES__S3__ACCESS_KEY='AK'$/m);
assert.match(patchEnv(read("env.example"), { password: "pw", modules: [], secrets: { VUMLO__MAIL__TRANSPORT__PASSWORD: "p#ss $x" } }), /^VUMLO__MAIL__TRANSPORT__PASSWORD='p#ss \$x'$/m);
assert.throws(() => patchEnv(read("env.example"), { password: "pw", modules: [], secrets: { VUMLO__MAIL__TRANSPORT__PASSWORD: "it's" } }), /single quote or a line break/);
assert.ok(!/^VUMLO__FILES__S3__SECRET_KEY=/m.test(envSecrets), "an empty secret is not written");

assert.equal(caddyEnv("https://lms.example.edu", "https://admin.lms.example.edu"), "VUMLO_DOMAIN=lms.example.edu\nVUMLO_ADMIN_DOMAIN=admin.lms.example.edu\n");
assert.equal(caddyEnv("http://localhost:3000", "http://localhost:3001"), null);
assert.equal(caddyEnv("https://10.0.0.5", "https://10.0.0.5:8443"), null);
assert.equal(caddyEnv("https://lms.example.edu", "http://admin.lms.example.edu"), null);
console.log("ok (mail, files, proxy)");

// ADR-0096: the checks that run before anything is written or started. Fake servers on local ports; no network.
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";
import tlsLib from "node:tls";
import { checkS3, checkSmtp, signV4 } from "./checks.mjs";
{
  // The documented SigV4 example "GET Object" (AWS docs, Signature Version 4, header-based authentication).
  const signed = signV4({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", service: "s3",
    accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"), headers: { range: "bytes=0-9" },
  });
  assert.match(signed.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /);

  // A scripted SMTP server: PLAIN and LOGIN with one right password, STARTTLS when it has a certificate.
  const pems = (() => {
    try {
      const dir = mkdtempSync(join(tmpdir(), "create-vumlo-cert-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
      return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
    } catch {
      return null;
    }
  })();
  const fakeSmtp = async ({ password = "right", certs, implicit = false, silent = false, caps = "AUTH PLAIN LOGIN" } = {}) => {
    const serve = (sock) => {
      let buf = "";
      let step = "";
      const say = (s) => sock.write(`${s}\r\n`);
      const onLine = (line) => {
        if (step === "login-user") {
          step = "login-pass";
          return say("334 UGFzc3dvcmQ6");
        }
        if (step === "login-pass") {
          step = "";
          return Buffer.from(line, "base64").toString() === password ? say("235 2.7.0 accepted") : say("535 5.7.8 authentication failed");
        }
        if (/^EHLO /i.test(line)) return say(["250-fake.example", ...(certs && !sock.encrypted ? ["250-STARTTLS"] : []), `250 ${caps}`].join("\r\n"));
        if (/^STARTTLS/i.test(line)) {
          say("220 go ahead");
          sock.removeAllListeners("data");
          const secure = new tlsLib.TLSSocket(sock, { isServer: true, secureContext: tlsLib.createSecureContext(certs) });
          secure.encrypted = true;
          secure.on("error", () => {});
          return serve(secure);
        }
        if (/^AUTH PLAIN /i.test(line)) {
          const [, u, pw] = Buffer.from(line.slice(11), "base64").toString().split("\0");
          return u && pw === password ? say("235 2.7.0 accepted") : say("535 5.7.8 authentication failed");
        }
        if (/^AUTH LOGIN/i.test(line)) {
          step = "login-user";
          return say("334 VXNlcm5hbWU6");
        }
        if (/^QUIT/i.test(line)) {
          say("221 bye");
          return sock.end();
        }
        return say("500 what");
      };
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          onLine(line);
        }
      });
      sock.on("error", () => {});
      if (!silent && !sock.encrypted) say("220 fake ESMTP");
    };
    const server = implicit
      ? tlsLib.createServer(certs, (s) => {
          s.encrypted = true;
          say220(s);
          serve(s);
        })
      : netServer(serve);
    const say220 = (s) => s.write("220 fake ESMTP\r\n");
    server.on("tlsClientError", () => {});
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return { port: server.address().port, close: () => server.close() };
  };
  const smtp = (port, extra = {}) => ({ host: "127.0.0.1", port, tls: "none", user: "u", ...extra });

  let s = await fakeSmtp();
  await checkSmtp(smtp(s.port), "right");
  await checkSmtp(smtp(s.port, { user: "" }), "");
  await assert.rejects(() => checkSmtp(smtp(s.port), "SECRET-wrong"), (e) => /535 5\.7\.8 authentication failed/.test(e.message) && !e.message.includes("SECRET-wrong"));
  s.close();
  s = await fakeSmtp({ caps: "AUTH LOGIN" });
  await checkSmtp(smtp(s.port), "right");
  await assert.rejects(() => checkSmtp(smtp(s.port), "wrong"), /535/);
  s.close();
  s = await fakeSmtp({ caps: "8BITMIME" });
  await assert.rejects(() => checkSmtp(smtp(s.port), "right"), /offers no AUTH/);
  s.close();
  s = await fakeSmtp({ silent: true });
  await assert.rejects(() => checkSmtp(smtp(s.port), "right", { timeout: 200 }), /no answer/);
  s.close();
  await assert.rejects(() => checkSmtp(smtp(1), "right"), /cannot connect to 127\.0\.0\.1:1/);

  if (pems) {
    s = await fakeSmtp({ certs: pems });
    await checkSmtp(smtp(s.port, { tls: "starttls" }), "right", { ca: pems.cert });
    await assert.rejects(() => checkSmtp(smtp(s.port, { tls: "starttls" }), "right"), /certificate is not trusted.*--skip-checks/s);
    s.close();
    s = await fakeSmtp({ certs: pems, implicit: true });
    await checkSmtp(smtp(s.port, { tls: "tls" }), "right", { ca: pems.cert });
    await assert.rejects(() => checkSmtp(smtp(s.port, { tls: "tls" }), "wrong", { ca: pems.cert }), /535/);
    s.close();
  } else console.log("skipped the TLS checks (no openssl)");

  // A fake bucket: answers by the access key it is given, and records what it was sent.
  const seen = [];
  const bucket = httpServer((req, res) => {
    seen.push(req.headers.authorization);
    const key = /Credential=([^/]+)\//.exec(req.headers.authorization ?? "")?.[1];
    if (req.url === "/gone") {
      res.writeHead(404);
      return res.end();
    }
    if (key === "moved") {
      res.writeHead(301, { "x-amz-bucket-region": "eu-west-1" });
      return res.end();
    }
    res.writeHead(key === "good" ? 200 : 403);
    res.end();
  });
  await new Promise((done) => bucket.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${bucket.address().port}`;
  await checkS3({ endpoint, bucket: "vumlo", region: "eu-north-1" }, { accessKey: "good", secretKey: "s" });
  assert.match(seen[0], /^AWS4-HMAC-SHA256 Credential=good\/\d{8}\/eu-north-1\/s3\/aws4_request, /);
  await assert.rejects(() => checkS3({ endpoint, bucket: "vumlo", region: "eu-north-1" }, { accessKey: "bad", secretKey: "SECRET-key" }), (e) => /403.*keys/.test(e.message) && !e.message.includes("SECRET-key"));
  await assert.rejects(() => checkS3({ endpoint, bucket: "gone", region: "eu-north-1" }, { accessKey: "good", secretKey: "s" }), /no bucket "gone"/);
  await assert.rejects(() => checkS3({ endpoint, bucket: "vumlo", region: "eu-north-1" }, { accessKey: "moved", secretKey: "s" }), /region eu-west-1/);
  await assert.rejects(() => checkS3({ endpoint: "http://127.0.0.1:1", bucket: "b", region: "r" }, { accessKey: "good", secretKey: "s" }), /cannot reach 127\.0\.0\.1:1/);
  bucket.close();
}
console.log("ok (checks)");


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
assert.ok(entriesToReplace([...top, "web-admin"], ["backend", "web", "deploy"]).includes("web-admin"), "the admin console is replaced with the web app");
assert.ok(!entriesToReplace([...top, "web-admin"], ["backend", "deploy"]).includes("web-admin"), "and not given to an installation without it");
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
const release = (v, vumloScript = `#!/bin/sh\n# ${v}\n`, withAdmin = false) => {
  const root = join(work, `src-${v}`);
  const top = join(root, `vumlo-${v}`);
  put(top, "deploy/vumlo.example.toml", `name = "Vumlo"\nmode = "university"\npublic_origin = "http://localhost:3000"\n${withAdmin ? 'admin_origin = "http://localhost:3001"\n' : ""}# short_name = "UCU"\n# accent = "violet"\nallowed_domains = []\n# language = "en"\n# time_zone = "UTC"\ncookie_secure = false\n\n# [modules]\n# some-module = true\n`);
  put(top, "deploy/env.example", "DATABASE_URL=postgres://x\nPOSTGRES_PASSWORD=x\n# VUMLO_FEATURES=\n# VUMLO__PLUGINS__SECRET_KEY=\n");
  put(top, "deploy/compose.yaml", composeFixture(v));
  put(top, "deploy/update.sh", "#!/bin/sh\n", 0o755);
  put(top, "backend/Cargo.toml", `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${v}"\n`);
  put(top, "backend/crates/modules/ai_agent/Cargo.toml", "");
  put(top, "web/index.txt", `web ${v}\n`);
  put(top, "web-admin/index.txt", `web-admin ${v}\n`);
  put(top, "desktop/index.txt", `desktop ${v}\n`);
  put(top, "vumlo", vumloScript, 0o755);
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
assert.ok(!existsSync(join(a, "web-admin")), "the admin console is built with the web app: without it, not there either");
assert.match(text(a, "vumlo.toml"), /^accent = "teal"$/m);
// The Buddy cannot start on `ai_agent = true` (config check wants an endpoint and a model): it gets its table, the defaults
// when nothing was asked, and an empty key line to fill in later. Nothing else of the module is written.
assert.match(text(a, "vumlo.toml"), /^\[modules\.ai_agent\]\nenabled = true\nendpoint = "https:\/\/api\.openai\.com\/v1"\nmodel = "gpt-4o-mini"$/m);
assert.ok(!/^ai_agent = true$/m.test(text(a, "vumlo.toml")) && !/^daily_cap/m.test(text(a, "vumlo.toml")));
assert.match(text(a, ".env"), /^VUMLO_AI_AGENT_API_KEY=$/m);
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

// Flags and the environment answer the Buddy's questions; a module without settings stays `name = true`.
{
  const m = join(work, "buddy");
  const x = spawnSync(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, "--archive", v1, "--yes", "--dir", m, "--modules", "ai_agent", "--set", "ai_agent.endpoint=http://localhost:11434/v1", "--set", "ai_agent.model=llama3"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VUMLO_AI_AGENT_API_KEY: "k-123" } });
  assert.equal(x.status, 0, `${x.stdout}${x.stderr}`);
  assert.match(text(m, "vumlo.toml"), /^endpoint = "http:\/\/localhost:11434\/v1"\nmodel = "llama3"$/m);
  assert.match(text(m, ".env"), /^VUMLO_AI_AGENT_API_KEY=k-123$/m);
  // A setting of a module that was not picked is refused: the questions exist only for the modules that are on.
  const off = spawnSync(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, "--archive", v1, "--yes", "--dir", join(work, "buddy-off"), "--set", "ai_agent.model=x"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.notEqual(off.status, 0);
  assert.match(`${off.stdout}${off.stderr}`, /--set ai_agent\.model: not a setting of a module you picked/);
  assert.ok(!existsSync(join(work, "buddy-off")));
  const cfg = patchToml(read("vumlo.example.toml"), { name: "X", mode: "school", origin: "http://localhost:3000", modules: ["vpl", "ai_agent"], settings: { ai_agent: { endpoint: "https://e", model: "m" } } });
  assert.match(cfg, /^\[modules\]\nvpl = true\n\n\[modules\.ai_agent\]\nenabled = true\nendpoint = "https:\/\/e"\nmodel = "m"$/m);
}

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

// --start: the whole sequence, with a fake docker and a fake ./vumlo that log what they were asked and print what the real
// ones print. The order is the one of docs/install.md; the token and secret land in .env; no plugin shares a port.
{
  const bin = join(work, "bin");
  const log = join(work, "calls.log");
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`, 0o755);
  const fake = (v) => release(v, `#!/bin/sh
echo "vumlo $*" >> "${log}"
case "$*" in
  "admin create"*) read -r pw; echo "pw=$pw" >> "${log}" ;;
  "plugin install"*"--dry-run"*)
    if [ -n "\${FAKE_BAD:-}" ] && [ "$3" = "http://plugin-\${FAKE_BAD}:8000" ]; then
      echo "error: the manifest is not valid: route GET '/': the path needs at least one segment" >&2; exit 1
    fi
    echo "plugin x 1"; echo "  asks for scopes: read:courses, read:grades" ;;
  "plugin install"*) printf 'installed\\n  VUMLO_PLUGIN_TOKEN=tok-%s\\n  VUMLO_WEBHOOK_SECRET=sec-%s\\n' "$3" "$3" ;;
esac
exit 0
`);
  const start = join(work, "start");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VUMLO_ADMIN_PASSWORD: "correct horse battery" };
  const goWith = (extra, ...args) => {
    const x = spawnSync(process.execPath, [new URL("./index.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...extra } });
    return { code: x.status, out: `${x.stdout}${x.stderr}` };
  };
  const go = (...args) => goWith({}, ...args);
  r = go("--archive", fake("0.9.0"), "--yes", "--dir", start, "--start", "--grant-plugins", "--admin-email", "a@example.edu", "--plugins", "text-metrics,ical-feed", "--plugins-archive", pl);
  assert.equal(r.code, 0, r.out);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const at = (re) => calls.findIndex((c) => re.test(c));
  const order = [/^vumlo config check/, /^vumlo brand apply/, /^docker compose build/, /^docker compose up -d --wait postgres/, /^vumlo db migrate/, /^vumlo admin create a@example.edu --name Admin --surname Admin --password-stdin/, /^docker compose up -d$/, /^vumlo doctor/, /^docker compose up -d --build plugin-ical-feed$/, /^vumlo plugin install http:\/\/plugin-ical-feed:8000 --grant none.*--dry-run/, /^vumlo plugin install http:\/\/plugin-ical-feed:8000 --grant read:courses,read:grades --courses all$/, /^docker compose up -d plugin-/];
  let from = -1;
  for (const re of order) {
    const i = calls.findIndex((c, j) => j > from && re.test(c));
    assert.ok(i > from, `${re} is missing or out of order in:\n${calls.join("\n")}`);
    from = i;
  }
  assert.ok(at(/^pw=correct horse battery$/) > -1, "the password goes in on standard input, not as an argument");
  assert.ok(!calls.some((c) => /correct horse/.test(c) && !c.startsWith("pw=")), "the password is never an argument");
  assert.match(text(start, ".env"), /^PLUGIN_ICAL_FEED_TOKEN=tok-http:\/\/plugin-ical-feed:8000$/m);
  assert.match(text(start, ".env"), /^PLUGIN_TEXT_METRICS_SECRET=sec-http:\/\/plugin-text-metrics:8000$/m);
  assert.match(r.out, /Vumlo is running/);
  assert.ok(!/ports:/.test(text(start, "plugins/compose.yaml")), "every plugin listens on 8000 in a container of its own: nothing is published, so no port clashes");

  // A plugin that does not build is left out: the install finishes, the others are registered, nothing waits for it.
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\ncase "$*" in *--build\\ plugin-text-metrics) echo "pip failed" >&2; exit 1;; esac\nexit 0\n`, 0o755);
  const skip = join(work, "start-skip");
  r = go("--archive", fake("0.9.3"), "--yes", "--dir", skip, "--start", "--grant-plugins", "--plugins", "text-metrics,ical-feed", "--plugins-archive", pl);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Not started, they are left out: text-metrics \(pip failed\)/);
  const skipped = readFileSync(log, "utf8");
  assert.ok(!/plugin install http:\/\/plugin-text-metrics/.test(skipped), "a plugin that did not start is not registered");
  assert.match(text(skip, ".env"), /^PLUGIN_ICAL_FEED_TOKEN=tok-/m);
  assert.match(text(skip, ".env"), /^PLUGIN_TEXT_METRICS_TOKEN=$/m);

  // A failing step keeps the files and says which step failed.
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\ncase "$*" in "compose build") echo "boom" >&2; exit 3;; esac\nexit 0\n`, 0o755);
  const kept2 = join(work, "start-fail");
  r = go("--archive", fake("0.9.1"), "--yes", "--dir", kept2, "--start");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Building the images.*failed/s);
  assert.match(r.out, /boom/);
  assert.ok(existsSync(join(kept2, "vumlo.toml")) && existsSync(join(kept2, ".env")), "the files stay after a failed step");
  assert.ok(!readFileSync(log, "utf8").includes("db migrate"), "nothing runs after the failed step");

  // Without --start, and without a terminal, nothing is run.
  rmSync(log, { force: true });
  assert.equal(go("--archive", fake("0.9.2"), "--yes", "--dir", join(work, "nostart")).code, 0);
  assert.deepEqual((existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((c) => c && c !== "docker compose version"), [], "no command runs without --start");

  // One plugin whose manifest the core refuses (pdf-optimizer once declared `GET /`) does not stop the others: it is not
  // waited for, the rest are registered and restarted, and the reason is shown at the end.
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`, 0o755);
  const mixed = join(work, "mixed");
  const t0 = Date.now();
  r = goWith({ FAKE_BAD: "ical-feed" }, "--archive", fake("0.9.4"), "--yes", "--dir", mixed, "--start", "--grant-plugins", "--plugins", "text-metrics,ical-feed,at-risk-students", "--plugins-archive", pl);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - t0 < 20000, "a refused manifest is final: no waiting for it");
  assert.match(r.out, /Not registered, they are left out: ical-feed \(error: the manifest is not valid: route GET '\/': the path needs at least one segment\)\. The others are running\./);
  assert.match(text(mixed, ".env"), /^PLUGIN_TEXT_METRICS_TOKEN=tok-/m);
  assert.match(text(mixed, ".env"), /^PLUGIN_AT_RISK_STUDENTS_TOKEN=tok-/m);
  assert.match(text(mixed, ".env"), /^PLUGIN_ICAL_FEED_TOKEN=$/m);
  assert.ok(!readFileSync(log, "utf8").split("\n").some((c) => /plugin install http:\/\/plugin-ical-feed:8000 --grant read/.test(c)), "the refused plugin is not registered");
  assert.match(r.out, /Vumlo is running/, "the run goes on to the end, with the administrator's note");

  // `plugins register` takes the ones without a token (the fixed plugin, later) and only those.
  rmSync(log, { force: true });
  r = go("plugins", "register", "--dir", mixed, "--grant-plugins");
  assert.equal(r.code, 0, r.out);
  const again = readFileSync(log, "utf8").split("\n");
  assert.ok(again.some((c) => /^vumlo plugin install http:\/\/plugin-ical-feed:8000 --grant read:courses,read:grades --courses all$/.test(c)));
  assert.ok(!again.some((c) => /--courses all/.test(c) && /plugin-(text-metrics|at-risk-students)/.test(c)), "registered plugins are left alone");
  assert.match(text(mixed, ".env"), /^PLUGIN_ICAL_FEED_TOKEN=tok-/m);
  assert.match(go("plugins", "register", "--dir", mixed).out, /nothing to register/);
  assert.match(go("plugins", "register", "nope", "--dir", mixed).out, /no plugin "nope"/);

  // The plugins that were not granted are left for later, not registered.
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`, 0o755);
  r = go("--archive", fake("0.9.3"), "--yes", "--dir", join(work, "nograntt"), "--start", "--plugins", "text-metrics", "--plugins-archive", pl);
  assert.equal(r.code, 0, r.out);
  assert.ok(!readFileSync(log, "utf8").split("\n").some((c) => /^vumlo plugin install .*--courses all/.test(c)), "no grant, no registration");
  assert.match(r.out, /Not registered \(no grant given\): text-metrics/);

  // A retry starts over (ADR-0096): a failed run leaves nothing behind, a failed --start leaves a marker and the next run
  // removes the folder with its containers and volumes, and a folder that is not an unfinished installation is never touched.
  const marker = ".create-vumlo-unfinished";
  const emptyDir = join(work, "retry-empty");
  mkdirSync(emptyDir);
  r = go("--archive", fake("0.9.5"), "--yes", "--dir", emptyDir, "--modules", "nope");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /this release has no module "nope"/);
  assert.deepEqual(readdirSync(emptyDir), [], "a failed run leaves an existing empty folder empty");
  const foreign = join(work, "retry-foreign");
  put(foreign, "keep.txt", "mine\n");
  r = go("--archive", fake("0.9.5"), "--yes", "--dir", foreign);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is not empty/);
  assert.ok(existsSync(join(foreign, "keep.txt")), "a folder without the marker is never wiped");
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\ncase "$*" in "compose build") echo "boom" >&2; exit 3;; esac\nexit 0\n`, 0o755);
  const again1 = join(work, "retry-start");
  r = go("--archive", fake("0.9.5"), "--yes", "--dir", again1, "--start");
  assert.notEqual(r.code, 0);
  assert.ok(existsSync(join(again1, marker)), "a failed --start keeps the marker");
  put(again1, "leftover.txt", "old\n");
  rmSync(log, { force: true });
  put(bin, "docker", `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`, 0o755);
  r = go("--archive", fake("0.9.5"), "--yes", "--dir", again1, "--start");
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(again1, "leftover.txt")), "the unfinished installation was removed");
  assert.ok(!existsSync(join(again1, marker)), "a finished installation has no marker");
  const retryCalls = readFileSync(log, "utf8").split("\n");
  const downAt = retryCalls.findIndex((c) => c === "docker compose -f deploy/compose.yaml down -v --remove-orphans");
  assert.ok(downAt > -1 && downAt < retryCalls.findIndex((c) => c === "docker compose build"), "containers and volumes go before the reinstall");
  assert.ok(!existsSync(join(work, "nostart", marker)), "no marker without --start either");
}
console.log("ok (--start)");

// The pure helpers of --start.
import { parseAsked, parseInstalled, setEnvVar, unregistered } from "./index.mjs";
assert.deepEqual(unregistered(["a-b", "c", "d"], "PLUGIN_A_B_TOKEN=t\nPLUGIN_C_TOKEN=\n"), ["c", "d"], "an empty token or none at all is not registered");
assert.equal(setEnvVar("A=1\nB=\nC=3\n", "B", "x=y/z"), "A=1\nB=x=y/z\nC=3\n");
assert.equal(setEnvVar("A=1", "B", "2"), "A=1\nB=2\n");
assert.equal(setEnvVar("A=1\n# B=old\n", "B", "2"), "A=1\n# B=old\nB=2\n", "a commented line is not the variable");
assert.deepEqual(parseInstalled("installed x\nThese are shown once.\n  VUMLO_PLUGIN_TOKEN=t0k_en-1\n  VUMLO_WEBHOOK_SECRET=s3c=ret\n"), { token: "t0k_en-1", secret: "s3c=ret" });
assert.throws(() => parseInstalled("nothing here"), /printed no token/);
assert.deepEqual(parseAsked("plugin a 1\n  subscribes to: nothing\n  asks for scopes: read:courses, read:grades\n"), ["read:courses", "read:grades"]);
assert.deepEqual(parseAsked("  asks for scopes: none\n"), []);
assert.throws(() => parseAsked("error: unreachable"), /did not say/);
console.log("ok (--start helpers)");

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

// The address of the admin console (ADR-0095): derived from the public one, written into vumlo.toml, and asked for by an update.
assert.equal(defaultAdminOrigin("http://localhost:3000"), "http://localhost:3001");
assert.equal(defaultAdminOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8081");
assert.equal(defaultAdminOrigin("https://lms.example.edu"), "https://admin.lms.example.edu");
assert.equal(defaultAdminOrigin("https://lms.example.edu:8443"), "https://admin.lms.example.edu:8443");
assert.doesNotThrow(() => checkAdminOrigin("https://admin.a.edu", "https://a.edu"));
assert.throws(() => checkAdminOrigin("https://a.edu", "https://a.edu"), /differ/);
assert.throws(() => checkAdminOrigin("admin.a.edu", "https://a.edu"), /scheme/);
assert.throws(() => checkAdminOrigin("https://admin.a.edu/x", "https://a.edu"), /path/);
{
  const example = read("vumlo.example.toml");
  assert.match(patchToml(example, { name: "X", mode: "school", origin: "https://lms.example.edu", modules: [] }), /^admin_origin = "https:\/\/admin\.lms\.example\.edu"$/m, "derived when not given");
  assert.match(patchToml(example, { name: "X", mode: "school", origin: "https://lms.example.edu", adminOrigin: "https://console.example.edu", modules: [] }), /^admin_origin = "https:\/\/console\.example\.edu"$/m);
  // An example of an older release has no such line: nothing is written and nothing breaks.
  const older = example.replace(/^admin_origin = .*\n/m, "");
  assert.doesNotThrow(() => patchToml(older, { name: "X", mode: "school", origin: "https://lms.example.edu", modules: [] }));
  assert.ok(!/^admin_origin/m.test(patchToml(older, { name: "X", mode: "school", origin: "https://lms.example.edu", modules: [] })));
}
assert.equal(adminOriginIn('[server]\npublic_origin = "https://a.edu"\nadmin_origin = "https://admin.a.edu"\n'), "https://admin.a.edu");
assert.equal(adminOriginIn('[server]\npublic_origin = "https://a.edu"\n# admin_origin = "x"\n'), undefined);
assert.equal(withAdminOrigin('[server]\npublic_origin = "https://a.edu"\nbind_addr = "x"\n', "https://admin.a.edu"), '[server]\npublic_origin = "https://a.edu"\nadmin_origin = "https://admin.a.edu"\nbind_addr = "x"\n');
assert.throws(() => withAdminOrigin("[server]\n", "https://admin.a.edu"), /public_origin/);

// An update to a release that needs the key: never written without an answer, written with one.
{
  const v3 = release("0.7.0", undefined, true);
  const old = join(work, "needs-admin-origin");
  assert.equal(cli("--archive", v1, "--yes", "--dir", old, "--origin", "https://lms.example.edu").code, 0);
  assert.ok(!/^admin_origin/m.test(text(old, "vumlo.toml")), "a release before 0.7.0 writes none");
  const silent = cli("update", "--archive", v3, "--dir", old, "--yes");
  assert.equal(silent.code, 0, silent.out);
  assert.ok(!/^admin_origin/m.test(text(old, "vumlo.toml")), "no answer: nothing is written");
  assert.match(silent.out, /admin_origin/, "and the note says it is missing");
  const bad = cli("update", "--archive", release("0.7.1", undefined, true), "--dir", old, "--yes", "--admin-origin", "https://lms.example.edu");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /differ/);
  assert.ok(!/^admin_origin/m.test(text(old, "vumlo.toml")));
  const answered = cli("update", "--archive", release("0.7.2", undefined, true), "--dir", old, "--yes", "--admin-origin", "https://admin.lms.example.edu");
  assert.equal(answered.code, 0, answered.out);
  assert.match(text(old, "vumlo.toml"), /^public_origin = "https:\/\/lms\.example\.edu"\nadmin_origin = "https:\/\/admin\.lms\.example\.edu"$/m);
  assert.match(answered.out, /admin\.lms\.example\.edu/);
  // Once there, an update leaves it alone.
  const again = cli("update", "--archive", release("0.7.3", undefined, true), "--dir", old, "--yes", "--admin-origin", "https://other.example.edu");
  assert.equal(again.code, 0, again.out);
  assert.match(text(old, "vumlo.toml"), /^admin_origin = "https:\/\/admin\.lms\.example\.edu"$/m);
}

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
