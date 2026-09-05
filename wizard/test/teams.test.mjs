/**
 * Tests for Teams enablement: the package Teams accepts, the catalog publish,
 * the per-user install, and the Developer Portal bot registration. Offline —
 * Graph and the Developer Portal are stubbed with the same contract the real
 * clients honour (2xx → body, else throw with .status).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync, inflateSync } from "node:zlib";
import { buildTeamsManifest, buildTeamsPackage, defaultIcons, makeZip, encodePng,
         publishToOrgCatalog, installForUsers, registerMessagingEndpoint, getMessagingEndpoint } from "../lib/teams.mjs";

const APP = "9415b2bd-342a-4777-8fd5-1dcd4b4c35e5";
const base = { blueprintAppId: APP, agentName: "HR Assistant", description: "Answers HR questions.", agentUrl: "https://hr.contoso.com" };

/** Read the entries back out of a zip produced by makeZip (store/deflate, no zip64). */
function unzip(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 30, p + 30 + nlen);
    const data = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 30 + nlen + xlen + csize;
  }
  return out;
}

describe("Teams app package", () => {
  test("the manifest is the blueprint's: id and botId are the blueprint appId, resource is api://botid-<appId>", () => {
    const m = buildTeamsManifest(base);
    assert.equal(m.id, APP);
    assert.equal(m.bots[0].botId, APP);
    assert.equal(m.webApplicationInfo.resource, `api://botid-${APP}`);
    assert.deepEqual(m.bots[0].scopes, ["personal", "team", "groupChat"]);
    assert.ok(m.validDomains.includes("hr.contoso.com"));
  });
  test("respects Teams' length limits and https-only developer links", () => {
    const m = buildTeamsManifest({ ...base, agentName: "A".repeat(50), description: "D".repeat(200) });
    assert.ok(m.name.short.length <= 30);
    assert.ok(m.description.short.length <= 80);
    for (const k of ["websiteUrl", "privacyUrl", "termsOfUseUrl"]) assert.match(m.developer[k], /^https:\/\//);
  });
  test("refuses a non-GUID blueprint id", () => {
    assert.throws(() => buildTeamsManifest({ ...base, blueprintAppId: "not-a-guid" }), /GUID/);
  });
  test("the zip holds manifest.json + two PNGs of the sizes Teams requires", () => {
    const { zip } = buildTeamsPackage(base);
    const files = unzip(zip);
    assert.deepEqual(Object.keys(files).sort(), ["color.png", "manifest.json", "outline.png"]);
    assert.equal(JSON.parse(files["manifest.json"].toString()).id, APP);
    const dims = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.deepEqual(dims(files["color.png"]), [192, 192]);
    assert.deepEqual(dims(files["outline.png"]), [32, 32]);
  });
  test("the outline icon is white and transparent only (Teams rejects anything else)", () => {
    const { outline } = defaultIcons();
    // Decode: IHDR at 8, IDAT chunks follow; the encoder writes one IDAT.
    let p = 8, idat = Buffer.alloc(0);
    while (p < outline.length) {
      const len = outline.readUInt32BE(p), type = outline.toString("ascii", p + 4, p + 8);
      if (type === "IDAT") idat = Buffer.concat([idat, outline.subarray(p + 8, p + 8 + len)]);
      p += 12 + len;
    }
    const raw = inflateSync(idat);
    let opaque = 0, nonWhite = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = y * (32 * 4 + 1) + 1 + x * 4;
      if (raw[i + 3]) { opaque++; if (raw[i] !== 255 || raw[i + 1] !== 255 || raw[i + 2] !== 255) nonWhite++; }
    }
    assert.ok(opaque > 0); assert.equal(nonWhite, 0);
  });
  test("makeZip round-trips arbitrary bytes", () => {
    const data = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const files = unzip(makeZip([{ name: "a.bin", data }, { name: "b.txt", data: "hi" }]));
    assert.deepEqual([...files["a.bin"]], [...data]); assert.equal(files["b.txt"].toString(), "hi");
    assert.equal(encodePng(1, 1, Buffer.from([1, 2, 3, 4])).readUInt32BE(16), 1);
  });
});


/** Graph stub: records calls, answers by path. */
function stubGraph(routes) {
  const calls = [];
  const g = async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    for (const [m, frag, val] of routes) {
      if (m === method && path.includes(frag)) {
        if (val instanceof Error) throw val;
        return typeof val === "function" ? val({ method, path, body }) : val;
      }
    }
    throw Object.assign(new Error(`unstubbed ${method} ${path}`), { status: 500 });
  };
  g.calls = calls;
  return g;
}
const err = (status, msg = "") => Object.assign(new Error(msg || `HTTP ${status}`), { status });

describe("org catalog publish", () => {
  test("publishes a new app as raw zip to /appCatalogs/teamsApps", async () => {
    const g = stubGraph([
      ["GET", "appCatalogs/teamsApps?$filter", { value: [] }],
      ["POST", "/v1.0/appCatalogs/teamsApps", { id: "cat-1" }],
    ]);
    const { zip } = buildTeamsPackage(base);
    const r = await publishToOrgCatalog(g, zip, APP);
    assert.deepEqual(r, { teamsAppId: "cat-1", action: "published" });
    const post = g.calls.find((c) => c.method === "POST");
    assert.ok(Buffer.isBuffer(post.body), "zip is sent as bytes, not JSON");
    assert.equal(post.headers["content-type"], "application/zip");
    assert.match(g.calls[0].path, new RegExp(`externalId eq '${APP}'`));
  });
  test("an existing app gets a new app definition, not a duplicate app", async () => {
    const g = stubGraph([
      ["GET", "appCatalogs/teamsApps?$filter", { value: [{ id: "cat-1" }] }],
      ["POST", "/appCatalogs/teamsApps/cat-1/appDefinitions", { id: "def-2" }],
    ]);
    const r = await publishToOrgCatalog(g, Buffer.from("zip"), APP);
    assert.deepEqual(r, { teamsAppId: "cat-1", action: "updated" });
    assert.equal(g.calls.some((c) => c.method === "POST" && c.path === "/v1.0/appCatalogs/teamsApps"), false);
  });
  test("the same version already published is 'unchanged', not an error", async () => {
    const g = stubGraph([
      ["GET", "appCatalogs/teamsApps?$filter", { value: [{ id: "cat-1" }] }],
      ["POST", "/appDefinitions", err(409, "Conflict")],
    ]);
    assert.equal((await publishToOrgCatalog(g, Buffer.from("zip"), APP)).action, "unchanged");
  });
  test("a manifest validation error is surfaced verbatim", async () => {
    const g = stubGraph([
      ["GET", "appCatalogs/teamsApps?$filter", { value: [] }],
      ["POST", "/v1.0/appCatalogs/teamsApps", err(400, "InvalidOutlineIconHeightAndWidth")],
    ]);
    await assert.rejects(publishToOrgCatalog(g, Buffer.from("zip"), APP), /InvalidOutlineIcon/);
  });
});

describe("install for users", () => {
  test("installs once per user, treats 409 as already installed, reports failures per user", async () => {
    const g = stubGraph([
      ["POST", "/users/u-1/teamwork/installedApps", null],
      ["POST", "/users/u-2/teamwork/installedApps", err(409, "already installed")],
      ["POST", "/users/u-3/teamwork/installedApps", err(403, "no licence")],
    ]);
    const r = await installForUsers(g, "cat-1", ["u-1", "u-1", "u-2", "u-3"]);
    assert.deepEqual(r.map((x) => [x.userId, x.status]), [["u-1", "installed"], ["u-2", "already"], ["u-3", "failed"]]);
    assert.equal(g.calls.length, 3, "duplicate user ids are collapsed");
    assert.match(g.calls[0].body["teamsApp@odata.bind"], /appCatalogs\/teamsApps\/cat-1$/);
  });
});

describe("Developer Portal bot registration (the messaging endpoint)", () => {
  test("creates the bot with botId = blueprint appId and the https endpoint", async () => {
    const dp = stubGraph([
      ["GET", `/api/botframework/${APP}`, err(404)],
      ["POST", "/api/botframework", { botId: APP }],
    ]);
    const r = await registerMessagingEndpoint(dp, { botId: APP, name: "HR Assistant", messagingEndpoint: "https://hr.contoso.com/api/messages" });
    assert.equal(r.action, "created");
    const post = dp.calls.find((c) => c.method === "POST");
    assert.equal(post.body.botId, APP);
    assert.equal(post.body.messagingEndpoint, "https://hr.contoso.com/api/messages");
    assert.deepEqual(post.body.configuredChannels, ["msteams"]);
  });
  test("updates an existing bot only when the endpoint changed", async () => {
    const existing = { botId: APP, name: "HR Assistant", messagingEndpoint: "https://old/api/messages" };
    const dp = stubGraph([
      ["GET", `/api/botframework/${APP}`, existing],
      ["POST", `/api/botframework/${APP}`, existing],
    ]);
    const r = await registerMessagingEndpoint(dp, { botId: APP, name: "HR Assistant", messagingEndpoint: "https://hr.contoso.com/api/messages" });
    assert.equal(r.action, "updated");
    const same = stubGraph([["GET", `/api/botframework/${APP}`, { ...existing, messagingEndpoint: "https://hr.contoso.com/api/messages" }]]);
    assert.equal((await registerMessagingEndpoint(same, { botId: APP, name: "HR Assistant", messagingEndpoint: "https://hr.contoso.com/api/messages" })).action, "unchanged");
    assert.equal(same.calls.length, 1, "no write when nothing changed");
  });
  test("refuses a non-https endpoint before touching the portal", async () => {
    const dp = stubGraph([]);
    await assert.rejects(registerMessagingEndpoint(dp, { botId: APP, name: "x", messagingEndpoint: "http://plain" }), /https/);
    assert.equal(dp.calls.length, 0);
  });
  test("getMessagingEndpoint reads back what is registered, null when nothing is", async () => {
    assert.equal(await getMessagingEndpoint(stubGraph([["GET", "/api/botframework/", { messagingEndpoint: "https://x/api/messages" }]]), APP), "https://x/api/messages");
    assert.equal(await getMessagingEndpoint(stubGraph([["GET", "/api/botframework/", err(404)]]), APP), null);
  });
});
