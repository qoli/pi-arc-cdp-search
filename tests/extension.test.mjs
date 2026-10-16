import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";

const activeTabs = new Map();
const closedTabs = [];
const navigations = [];
let serial = 0;
let rejectEvaluation = false;
let endpointOffline = false;
let port;
let extension;
const tools = new Map();
const commands = new Map();

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/json/version") {
    res.statusCode = endpointOffline ? 503 : 200;
    res.end(JSON.stringify({ Browser: "TestChromium/1.0" }));
  } else if (req.url.startsWith("/json/new?") && req.method === "PUT") {
    const id = String(++serial);
    activeTabs.set(id, { rejectEvaluation, url: "about:blank" });
    rejectEvaluation = false;
    res.end(JSON.stringify({ id, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page/${id}` }));
  } else if (req.url.startsWith("/json/close/")) {
    const id = req.url.split("/").at(-1);
    activeTabs.delete(id);
    closedTabs.push(id);
    res.end(JSON.stringify({ closed: true }));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});

const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket, req) => {
  const tab = activeTabs.get(req.url.split("/").at(-1));
  socket.on("message", (raw) => {
    const { id, method, params } = JSON.parse(String(raw));
    let result = {};
    if (method === "Page.navigate") {
      tab.url = params.url;
      navigations.push(params.url);
    } else if (method === "Runtime.evaluate") {
      if (params.expression.includes("const btns")) {
        result = { result: { value: false } };
      } else if (tab.rejectEvaluation) {
        result = { exceptionDetails: { text: "Fixture extraction failed" } };
      } else if (tab.url.startsWith("https://www.google.com/search")) {
        result = { result: { value: {
          results: [{ title: "CDP documentation", url: "https://example.com/cdp", snippet: "Protocol reference." }],
          finalUrl: tab.url,
        } } };
      } else {
        result = { result: { value: {
          markdown: "# Example Domain\n\nA public example page.",
          finalUrl: tab.url,
          title: "Example Domain",
        } } };
      }
    }
    socket.send(JSON.stringify({ id, result }));
    if (method === "Page.navigate") {
      socket.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
    }
  });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  process.env.PI_CDP_URL = `http://127.0.0.1:${port}/`;
  delete process.env.PI_COMPUTER_USE_CDP_PORT;
  extension = await import("../arc-cdp-search.ts");
  extension.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  });
});

after(async () => {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

test("maps local CDP for optional computer use while preserving an explicit port", () => {
  const mapPort = extension.exposeLocalCdpToComputerUse;
  assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, String(port));
  for (const host of ["localhost", "127.0.0.1"]) {
    const env = {};
    assert.equal(mapPort(`http://${host}:9333`, env), "9333");
    assert.equal(env.PI_COMPUTER_USE_CDP_PORT, "9333");
  }
  const explicit = { PI_COMPUTER_USE_CDP_PORT: "9444" };
  assert.equal(mapPort("http://localhost:9333", explicit), "9444");
  assert.equal(explicit.PI_COMPUTER_USE_CDP_PORT, "9444");
  for (const url of ["https://localhost:9333", "http://remote.example:9333", "invalid"]) {
    const env = {};
    assert.equal(mapPort(url, env), undefined);
    assert.deepEqual(env, {});
  }
});

test("search encodes the query, returns links, and closes its temporary tab", async () => {
  const query = "Pi & CDP 中文";
  const result = await tools.get("google_search").execute("search", { query });
  const url = new URL(navigations.at(-1));
  assert.equal(url.searchParams.get("q"), query);
  assert.match(result.content[0].text, /\[CDP documentation\]\(https:\/\/example.com\/cdp\)/);
  assert.equal(result.details.count, 1);
  assert.equal(activeTabs.size, 0);
});

test("page reading returns text and metadata and closes its temporary tab", async () => {
  const result = await tools.get("visit_page").execute("visit", { url: "https://example.com" });
  assert.match(result.content[0].text, /# Example Domain/);
  assert.equal(result.details.title, "Example Domain");
  assert.equal(result.details.url, "https://example.com/");
  assert.equal(activeTabs.size, 0);
});

test("an extraction failure still closes the tab", async () => {
  const closedBefore = closedTabs.length;
  rejectEvaluation = true;
  await assert.rejects(
    tools.get("visit_page").execute("failure", { url: "https://example.com" }),
    /Fixture extraction failed/,
  );
  assert.equal(closedTabs.length, closedBefore + 1);
  assert.equal(activeTabs.size, 0);
});

test("an unreachable endpoint reports the configured address without creating a tab", async () => {
  const createdBefore = serial;
  endpointOffline = true;
  try {
    await assert.rejects(
      tools.get("google_search").execute("offline", { query: "CDP" }),
      new RegExp(`CDP endpoint http://127.0.0.1:${port} is unreachable`),
    );
    assert.equal(serial, createdBefore);
  } finally {
    endpointOffline = false;
  }
});

test("invalid inputs fail before any browser tab is created", async () => {
  const createdBefore = serial;
  await assert.rejects(tools.get("google_search").execute("empty-search", { query: " " }), /requires a query/);
  await assert.rejects(tools.get("visit_page").execute("empty-url", { url: " " }), /requires a URL/);
  await assert.rejects(tools.get("visit_page").execute("bad-url", { url: "invalid" }), /Invalid URL/);
  assert.equal(serial, createdBefore);
});

test("the status command checks the browser connection", async () => {
  const notices = [];
  await commands.get("cdp-search").handler("", {
    ui: { notify(message, level) { notices.push({ message, level }); } },
  });
  assert.equal(notices[0].level, "info");
  assert.match(notices[0].message, /TestChromium\/1.0/);
});
