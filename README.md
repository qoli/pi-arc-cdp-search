# Pi Arc CDP Search

Give [Pi](https://github.com/earendil-works/pi) Google search and page reading through the browser you already use.

`google_search` searches Google and returns links with snippets. `visit_page` opens a URL and returns its main text as Markdown. Both connect to your running Arc or Chromium browser through the Chrome DevTools Protocol (CDP), reuse its profile and login session, and close the temporary tab afterward.

No search API key, browser download, or separate browser profile is needed for Arc. The extension uses Node's built-in `fetch` and `WebSocket`; Pi supplies its extension API and TypeBox.

[繁體中文](README.zh-TW.md)

## Install

Requires Node.js **22.19+**, [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), and a running Chromium browser with CDP enabled. Verified with Pi 1.1 and 1.3.

```bash
pi install git:github.com/qoli/pi-arc-cdp-search
```

Start Pi, or run `/reload` in an existing session. Run `/cdp-search` to check the connection, then ask:

```text
Search Google for the Chrome DevTools Protocol documentation.
Read https://example.com and summarize it.
```

Pi chooses the tools from your request. The tool arguments are:

```text
google_search({ "query": "Chrome DevTools Protocol" })
visit_page({ "url": "https://example.com" })
```

To remove the package:

```bash
pi remove git:github.com/qoli/pi-arc-cdp-search
```

If you previously installed `arc-cdp-search.ts` manually, remove that old extension entry before installing the package so the tools load once.

## Connect your browser

The default endpoint is `http://localhost:9222`.

For **Arc on macOS**, fully quit Arc, then reopen it with remote debugging:

```bash
open -a "Arc" --args --remote-debugging-port=9222
```

Check that it is reachable:

```bash
curl -fsS http://localhost:9222/json/version
```

For another endpoint, set the variable **before starting Pi**:

```bash
PI_CDP_URL=http://127.0.0.1:9333 pi
```

Other Chromium browsers work when they expose the same HTTP CDP endpoints and page WebSocket connections. Recent Google Chrome versions require a non-default `--user-data-dir` for remote debugging; see [Chrome's remote debugging guidance](https://developer.chrome.com/blog/remote-debugging-port). The extension connects to an existing browser; you start and manage it yourself.

Keep the debugging port on a trusted local interface: it grants access to the browser session. Page text returned by these tools becomes part of the Pi model's context.

## Tools and behavior

| Tool or command | Result |
| --- | --- |
| `google_search({ query })` | Up to 12 extracted results, with titles, URLs, and snippets |
| `visit_page({ url })` | Main text as Markdown, including headings, lists, code blocks, and a links section; capped at 60,000 characters |
| `/cdp-search` | Endpoint reachability, browser version, and the optional computer-use port mapping |

Google's interface is requested in English (`hl=en`); your browser session and location can still influence results. The extractor attempts to click common cookie-consent buttons such as **Accept all** or **I agree** when present.

Authenticated pages can be read when your browser session has access. CAPTCHA, access restrictions, and paywalls can still prevent extraction. There is no automatic alternate search service. If no search results are found, the tool returns the final page URL to help you inspect the problem.

Page reading extracts visible text rather than a full HTML snapshot. Images, tables, shadow DOM, and heavily delayed content may not be represented completely. Google DOM changes may require an extractor update.

## Optional pi-computer-use integration

Search and page reading work on their own. If you also have [`@injaneity/pi-computer-use`](https://www.npmjs.com/package/@injaneity/pi-computer-use), the extension exposes a local HTTP CDP port through `PI_COMPUTER_USE_CDP_PORT`, allowing that package to discover existing tabs:

```text
find_roots({ "kind": "browser_page" })
```

An explicitly set `PI_COMPUTER_USE_CDP_PORT` takes priority. Only `http://localhost` and `http://127.0.0.1` endpoints are mapped automatically, because pi-computer-use connects to `127.0.0.1`. `/cdp-search` reports the mapping; it does not check whether that optional package is installed.

## Development

```bash
git clone https://github.com/qoli/pi-arc-cdp-search.git
cd pi-arc-cdp-search
npm ci
npm run check
npm test
```

The automated tests use a local mock CDP server and require neither a browser nor model credentials. To check the extension against a real running browser:

```bash
npm run test:live
```

This opens temporary tabs for a Google search and `https://example.com`, runs both tools, and checks tab cleanup. It needs CDP at the default endpoint or `PI_CDP_URL`.

To try local changes in Pi:

```bash
pi -e ./arc-cdp-search.ts
```

Packaging follows the [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). A Pi extension is loaded directly from TypeScript; no build step is needed.

## Community

- [LINUX DO](https://linux.do/)

## License

[MIT](LICENSE) © Ronnie W.
