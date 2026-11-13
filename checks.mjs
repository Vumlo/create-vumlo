// The checks that run before an installation is written or started (ADR-0096): can the mail server be logged in to, does the
// bucket answer to these keys. Node's own modules only. Nothing is sent or stored: the SMTP check logs in and quits, the S3
// check is one HEAD of the bucket. A message names what the server said and never a password or a key.
import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// --- S3 -----------------------------------------------------------------------------------------------------------

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// AWS Signature Version 4, header-based. Returns the headers to send, `authorization` among them.
export function signV4({ method, url, region, service, accessKey, secretKey, date, payloadHash = sha256(""), headers = {} }) {
  const u = new URL(url);
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const day = stamp.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join("&");
  const canonical = [method, u.pathname, query, names.map((n) => `${n}:${all[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

// Addressed the way the core does (object_store): AWS by the bucket's own host name, any other endpoint by path.
export async function checkS3({ endpoint, bucket, region }, { accessKey, secretKey }, { timeout = 10000 } = {}) {
  const url = endpoint ? `${endpoint.replace(/\/+$/, "")}/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com/`;
  const headers = signV4({ method: "HEAD", url, region, service: "s3", accessKey, secretKey, date: new Date() });
  const host = new URL(url).host;
  const res = await new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).request(url, { method: "HEAD", headers, timeout }, resolve);
    req.on("timeout", () => req.destroy(Object.assign(new Error("no answer"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  }).catch((e) => {
    throw new Error(`cannot reach ${host}: ${e.code ?? e.message}`);
  });
  res.resume();
  if (res.statusCode === 200) return;
  if (res.statusCode === 403) throw new Error(`${host} answered 403: the keys are refused, or they have no access to the bucket "${bucket}"`);
  if (res.statusCode === 404) throw new Error(`${host} answered 404: no bucket "${bucket}"`);
  const elsewhere = res.headers["x-amz-bucket-region"];
  if (elsewhere) throw new Error(`the bucket "${bucket}" is in the region ${elsewhere}, not ${region}: set --s3-region ${elsewhere}`);
  throw new Error(`${host} answered HTTP ${res.statusCode}`);
}

// --- SMTP ---------------------------------------------------------------------------------------------------------

// Reads replies off a socket: one reply is the lines up to the one whose code is followed by a space.
function session(socket, timeout) {
  let buf = "";
  let waiting = null;
  let failure = null;
  const take = () => {
    const lines = [];
    let rest = buf;
    for (;;) {
      const i = rest.indexOf("\n");
      if (i < 0) return null;
      const line = rest.slice(0, i).replace(/\r$/, "");
      rest = rest.slice(i + 1);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        buf = rest;
        return { code: Number(line.slice(0, 3)), lines, last: line };
      }
    }
  };
  const settle = () => {
    if (!waiting) return;
    const reply = take();
    if (!reply && !failure) return;
    clearTimeout(waiting.timer);
    const { resolve, reject } = waiting;
    waiting = null;
    if (reply) resolve(reply);
    else reject(failure);
  };
  const onData = (d) => {
    buf += d;
    settle();
  };
  socket.on("data", onData);
  socket.on("error", (e) => {
    failure = e;
    settle();
  });
  socket.on("close", () => {
    failure ??= new Error("the server closed the connection");
    settle();
  });
  return {
    reply: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error(`no answer from the server within ${timeout / 1000} s`));
        }, timeout);
        waiting = { resolve, reject, timer };
        settle();
      }),
    send: (line) => socket.write(`${line}\r\n`),
    // Before the socket is wrapped in TLS: the old listener must not see the encrypted bytes.
    detach: () => socket.off("data", onData),
  };
}

const need = (reply, code, what) => {
  if (reply.code !== code) throw new Error(`${what}: the server answered "${reply.last}"`);
};

// Logs in the way the core's transport would, and quits. `mode`: "starttls" | "tls" | "none".
export async function checkSmtp({ host, port, tls: mode, user }, password, { timeout = 10000, ca } = {}) {
  const where = `${host}:${port}`;
  const servername = net.isIP(host) ? undefined : host;
  const sockets = [];
  try {
    const connect = (options, event) =>
      new Promise((resolve, reject) => {
        const socket = options.socket ? tls.connect(options) : mode === "tls" ? tls.connect(options) : net.connect(options);
        sockets.push(socket);
        socket.once(event, () => {
          socket.setTimeout(0);
          resolve(socket);
        });
        socket.once("error", reject);
        socket.once("timeout", () => socket.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      });
    let socket = await (mode === "tls" ? connect({ host, port, servername, ca, timeout }, "secureConnect") : connect({ host, port, timeout }, "connect"));
    let talk = session(socket, timeout);
    need(await talk.reply(), 220, "greeting");
    const ehlo = async () => {
      talk.send("EHLO create-vumlo");
      const reply = await talk.reply();
      need(reply, 250, "EHLO");
      return reply.lines.join("\n");
    };
    let caps = await ehlo();
    if (mode === "starttls") {
      if (!/\bSTARTTLS\b/i.test(caps)) throw new Error("the server offers no STARTTLS: use --mail-tls tls or none");
      talk.send("STARTTLS");
      need(await talk.reply(), 220, "STARTTLS");
      talk.detach();
      socket = await connect({ socket, host, servername, ca }, "secureConnect");
      talk = session(socket, timeout);
      caps = await ehlo();
    }
    if (user) {
      const offered = /^250[ -]AUTH[ =](.*)$/im.exec(caps)?.[1];
      if (!offered) throw new Error(`the server offers no AUTH${mode === "none" ? " (many servers offer it only after STARTTLS or over tls)" : ""}`);
      const mechanisms = offered.toUpperCase().split(/\s+/);
      const b64 = (s) => Buffer.from(s).toString("base64");
      let reply;
      if (mechanisms.includes("PLAIN")) {
        talk.send(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`);
        reply = await talk.reply();
      } else if (mechanisms.includes("LOGIN")) {
        talk.send("AUTH LOGIN");
        need(await talk.reply(), 334, "AUTH LOGIN");
        talk.send(b64(user));
        need(await talk.reply(), 334, "AUTH LOGIN");
        talk.send(b64(password));
        reply = await talk.reply();
      } else {
        throw new Error(`the server offers neither AUTH PLAIN nor AUTH LOGIN (it offers ${offered.trim()})`);
      }
      if (reply.code !== 235) throw new Error(`the server refused the login: ${reply.last}`);
    }
    talk.send("QUIT");
  } catch (e) {
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(e.code ?? "")) {
      throw new Error(`${where}: the certificate is not trusted (${e.code}). Node does not use the system's certificates; if the server is fine, use --skip-checks`);
    }
    if (e.code) throw new Error(`cannot connect to ${where} (${e.code})`);
    throw e;
  } finally {
    for (const s of sockets) s.destroy();
  }
}
