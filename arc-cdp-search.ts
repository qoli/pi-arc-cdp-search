/**
 * arc-cdp-search — Google search & page reading through the user's EXISTING browser.
 *
 * Attaches to a running Chromium browser over the Chrome DevTools Protocol
 * (default: Arc at http://localhost:9222, override with PI_CDP_URL).
 * It never launches or kills a browser — it only opens a tab, does the job,
 * and closes the tab again. Uses the real browser profile, so authenticated
 * and localized pages work.
 *
 * It also exposes the same local CDP port to pi-computer-use, making existing
 * Arc tabs available as browser_page roots to every Pi session that loads this
 * user extension. An explicitly configured PI_COMPUTER_USE_CDP_PORT wins.
 *
 * Tools:
 *   - google_search(query)  — Google search, returns markdown links + snippets
 *   - visit_page(url)       — render a URL, return main content as markdown
 *
 * Commands:
 *   - /cdp-search           — show endpoint reachability status
 *
 * No additional runtime dependencies: built-in WebSocket, inline JS extractors.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CDP_URL = (process.env.PI_CDP_URL ?? "http://localhost:9222").replace(/\/+$/, "");

/**
 * Share a loopback HTTP CDP endpoint with pi-computer-use without overriding an
 * explicit operator setting. pi-computer-use currently accepts a port only and
 * connects to 127.0.0.1, so remote and HTTPS PI_CDP_URL values are deliberately
 * not translated.
 */
export function exposeLocalCdpToComputerUse(
  cdpUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.PI_COMPUTER_USE_CDP_PORT !== undefined) {
    return env.PI_COMPUTER_USE_CDP_PORT;
  }

  let endpoint: URL;
  try {
    endpoint = new URL(cdpUrl);
  } catch {
    return undefined;
  }

  if (
    endpoint.protocol !== "http:" ||
    (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")
  ) {
    return undefined;
  }

  const port = endpoint.port || "80";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    return undefined;
  }

  env.PI_COMPUTER_USE_CDP_PORT = port;
  return port;
}

// Extension modules load inside every Pi process, including PI WEB workers.
// Set this before any tool call; pi-computer-use reads the variable dynamically.
exposeLocalCdpToComputerUse(CDP_URL);

const NAV_TIMEOUT_MS = 30_000;
const WS_TIMEOUT_MS = 10_000;
const SETTLE_MS = 900;
const MAX_CHARS = 60_000;

// ── CDP plumbing ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class PageCDP {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP WebSocket connect timeout"));
      }, WS_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket error"));
      };
      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.id == null) {
          if (msg.method) {
            for (const h of this.listeners.get(msg.method) ?? []) h(msg.params);
          }
          return;
        }
        const cb = this.pending.get(msg.id);
        if (!cb) return;
        this.pending.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message ?? "CDP error"));
        else cb.resolve(msg.result);
      };
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(handler);
    this.listeners.set(method, arr);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP WebSocket not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "JS evaluation failed",
      );
    }
    return result.result?.value;
  }

  disconnect(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

interface TabInfo {
  id: string;
  webSocketDebuggerUrl: string;
}

async function checkCdp(): Promise<string> {
  const resp = await fetch(`${CDP_URL}/json/version`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { Browser?: string };
  return data.Browser ?? "unknown";
}

async function openTab(): Promise<TabInfo> {
  const resp = await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" });
  if (!resp.ok) throw new Error(`Cannot open tab: HTTP ${resp.status}`);
  return (await resp.json()) as TabInfo;
}

async function closeTab(id: string): Promise<void> {
  try {
    await fetch(`${CDP_URL}/json/close/${id}`);
  } catch {
    /* best effort */
  }
}

/**
 * Open a tab in the user's browser, navigate to `url`, run `expression`,
 * close the tab. Throws a friendly error when the CDP endpoint is down.
 */
async function withPage<T>(url: string, expression: string, preScript?: string): Promise<T> {
  let browser: string;
  try {
    browser = await checkCdp();
  } catch {
    throw new Error(
      `CDP endpoint ${CDP_URL} is unreachable. Start Arc or Chromium with ` +
        `--remote-debugging-port=9222, ` +
        `or point PI_CDP_URL at another Chromium CDP endpoint.`,
    );
  }

  const tab = await openTab();
  const cdp = new PageCDP();
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.call("Page.enable");

    const loaded = new Promise<void>((resolve) => {
      navigationTimer = setTimeout(resolve, NAV_TIMEOUT_MS);
      cdp.on("Page.loadEventFired", () => {
        clearTimeout(navigationTimer);
        resolve();
      });
    });
    await cdp.call("Page.navigate", { url });
    await loaded;
    await sleep(SETTLE_MS);

    if (preScript) {
      try {
        const rerun = await cdp.evaluate(preScript);
        if (rerun) {
          // preScript triggered a reload/redirect (e.g. consent accepted)
          await sleep(2500);
        }
      } catch {
        /* non-fatal */
      }
    }

    const value = await cdp.evaluate(expression);
    return value as T;
  } finally {
    clearTimeout(navigationTimer);
    cdp.disconnect();
    await closeTab(tab.id);
    void browser;
  }
}

// ── In-page extractors ────────────────────────────────────────────────────

/** Click a cookie-consent button if one is present. Returns true if clicked. */
const CONSENT_JS = `(() => {
  const btns = [...document.querySelectorAll('button, [role="button"]')];
  const b = btns.find((el) => /^(accept all|i agree|agree|同意|接受|全部接受)$/i.test((el.textContent || '').trim()));
  if (b) { b.click(); return true; }
  return false;
})()`;

/** Google search results → [{title, url, snippet}] */
const GOOGLE_RESULTS_JS = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a')) {
    const h3 = a.querySelector('h3');
    if (!h3) continue;
    const href = a.href;
    if (!href || !href.startsWith('http') || seen.has(href)) continue;
    seen.add(href);
    const title = (h3.textContent || '').trim();
    let container = a;
    for (let i = 0; i < 6 && container && (container.innerText || '').length < 150; i++) {
      container = container.parentElement;
    }
    let snippet = '';
    if (container) {
      snippet = (container.innerText || '')
        .split('\\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 40 && !s.startsWith('http') && s !== title)
        .slice(0, 2)
        .join(' ');
    }
    out.push({ title, url: href, snippet: snippet.slice(0, 300) });
    if (out.length >= 12) break;
  }
  return { results: out, finalUrl: location.href };
})()`;

/** Generic page → markdown-ish main content. */
const PAGE_MARKDOWN_JS = `(() => {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  const els = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote')];
  const set = new Set(els);
  const parts = [];
  let len = 0;
  const LIMIT = ${MAX_CHARS};
  for (const el of els) {
    if (el.closest('nav,header,footer,aside,script,style,noscript,form,[aria-hidden="true"]')) continue;
    let skip = false;
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (set.has(p)) { skip = true; break; }
    }
    if (skip) continue;
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || '').trim();
    if (!text) continue;
    let line;
    if (tag.startsWith('h')) line = '\\n' + '#'.repeat(Number(tag[1])) + ' ' + text.replace(/\\n/g, ' ') + '\\n';
    else if (tag === 'li') line = '- ' + text.replace(/\\n/g, ' ');
    else if (tag === 'pre') line = '\\n\`\`\`\\n' + text + '\\n\`\`\`\\n';
    else if (tag === 'blockquote') line = '> ' + text.replace(/\\n/g, '\\n> ');
    else line = text;
    parts.push(line);
    len += line.length;
    if (len > LIMIT) { parts.push('\\n…[truncated]'); break; }
  }
  const links = [];
  const seenLinks = new Set();
  for (const a of root.querySelectorAll('a[href]')) {
    const t = (a.textContent || '').trim();
    const h = a.href;
    if (!t || t.length < 2 || !h.startsWith('http') || seenLinks.has(h)) continue;
    if (a.closest('nav,header,footer,aside')) continue;
    seenLinks.add(h);
    links.push('[' + t.slice(0, 80).replace(/[\\[\\]]/g, '') + '](' + h + ')');
    if (links.length >= 60) break;
  }
  const title = document.title || '';
  let md = '# ' + title + '\\n\\n' + parts.join('\\n');
  if (links.length) md += '\\n\\n## Links\\n' + links.map((l) => '- ' + l).join('\\n');
  return { markdown: md, finalUrl: location.href, title };
})()`;

// ── Formatting ────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(query: string, results: SearchResult[], finalUrl: string): string {
  if (!results.length) {
    return `No results extracted for "${query}" (page: ${finalUrl}). Google may have shown a captcha or consent wall — try again, or open ${finalUrl} in the browser to check.`;
  }
  const lines = results.map(
    (r, i) => `${i + 1}. [${r.title}](${r.url})${r.snippet ? `\n   ${r.snippet}` : ""}`,
  );
  return `Google results for "${query}":\n\n${lines.join("\n")}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + "\n\n…[truncated]";
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function arcCdpSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "google_search",
    label: "Google Search (CDP)",
    description:
      "Search Google using the user's existing Chromium browser via CDP " +
      `(${CDP_URL}). Uses the real browser profile and requires no search API key. ` +
      "Returns a compact markdown list of results.",
    promptSnippet: "google_search: search Google via the user's browser (CDP), returns markdown links",
    promptGuidelines: [
      "Use google_search when you need real-time web information. It opens a tab in the user's browser, searches, and closes the tab.",
      "If pi-computer-use is installed, existing local browser tabs are available as browser_page roots. For interactive browser work, call find_roots with kind browser_page first; use launch_browser only when a separate managed profile is explicitly needed or local CDP is unavailable.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query to send to Google" }),
    }),
    async execute(_id, params) {
      const query = params.query?.trim();
      if (!query) {
        throw new Error("google_search requires a query.");
      }
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
      const data = await withPage<{ results: SearchResult[]; finalUrl: string }>(
        searchUrl,
        GOOGLE_RESULTS_JS,
        CONSENT_JS,
      );
      return {
        content: [{ type: "text" as const, text: formatResults(query, data.results, data.finalUrl) }],
        details: { url: data.finalUrl, count: data.results.length },
      };
    },
  });

  pi.registerTool({
    name: "visit_page",
    label: "Visit Page (CDP)",
    description:
      "Open a URL in the user's existing Chromium browser via CDP " +
      `(${CDP_URL}) and return the main content as markdown (headings, paragraphs, ` +
      "lists, code blocks, plus a links section). Works with authenticated sites " +
      "because it reuses the real browser profile and cookies.",
    promptSnippet: "visit_page: read a URL via the user's browser (CDP), returns main content as markdown",
    promptGuidelines: [
      "Use visit_page to read pages found with google_search. It uses the user's real browser session and can read pages that session has access to.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to visit" }),
    }),
    async execute(_id, params) {
      const raw = params.url?.trim();
      if (!raw) {
        throw new Error("visit_page requires a URL.");
      }
      let url: string;
      try {
        url = new URL(raw).toString();
      } catch {
        throw new Error(`Invalid URL: ${raw}`);
      }
      const data = await withPage<{ markdown: string; finalUrl: string; title: string }>(
        url,
        PAGE_MARKDOWN_JS,
        CONSENT_JS,
      );
      return {
        content: [{ type: "text" as const, text: truncate(data.markdown) }],
        details: { url: data.finalUrl, title: data.title, chars: data.markdown.length },
      };
    },
  });

  pi.registerCommand("cdp-search", {
    description: "Show CDP search endpoint status",
    handler: async (_args, ctx) => {
      const computerUsePort = exposeLocalCdpToComputerUse(CDP_URL);
      const integration = computerUsePort
        ? `pi-computer-use: browser_page discovery enabled on 127.0.0.1:${computerUsePort}`
        : "pi-computer-use: not configured from PI_CDP_URL (use a loopback HTTP endpoint or set PI_COMPUTER_USE_CDP_PORT explicitly)";
      try {
        const browser = await checkCdp();
        ctx.ui.notify(
          `CDP endpoint ${CDP_URL} OK (${browser})\n${integration}\nFull control: find_roots({ kind: \"browser_page\" })`,
          "info",
        );
      } catch {
        ctx.ui.notify(
          `CDP endpoint ${CDP_URL} unreachable — start Arc with remote debugging or set PI_CDP_URL.\n${integration}`,
          "error",
        );
      }
    },
  });
}
