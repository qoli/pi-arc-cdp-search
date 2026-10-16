import assert from "node:assert/strict";
import extension from "../arc-cdp-search.ts";

const endpoint = (process.env.PI_CDP_URL ?? "http://localhost:9222").replace(/\/+$/, "");
const version = await fetch(`${endpoint}/json/version`);
assert.ok(version.ok, `CDP health check failed: HTTP ${version.status}`);
const tools = new Map();
extension({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} });
const listTabs = async () => {
  const response = await fetch(`${endpoint}/json/list`);
  assert.ok(response.ok, `Tab listing failed: HTTP ${response.status}`);
  return response.json();
};
const before = new Set((await listTabs()).map((tab) => tab.id));

const search = await tools.get("google_search").execute("smoke-search", {
  query: "Chrome DevTools Protocol documentation",
});
assert.ok(search.details.count > 0, search.content[0].text);
console.log(`google_search: ${search.details.count} results`);

const page = await tools.get("visit_page").execute("smoke-visit", { url: "https://example.com" });
assert.match(page.content[0].text, /Example Domain/);
console.log(`visit_page: ${page.details.title}`);

const remaining = (await listTabs()).filter((tab) => !before.has(tab.id) && (
  tab.url.startsWith("https://www.google.com/search?q=Chrome%20DevTools%20Protocol%20documentation") ||
  tab.url === "https://example.com/"
));
assert.equal(remaining.length, 0, "A smoke-test tab was left open");
console.log("Temporary tabs cleaned up");
