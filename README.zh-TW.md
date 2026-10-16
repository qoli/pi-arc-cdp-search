# Pi Arc CDP Search

讓 [Pi](https://github.com/earendil-works/pi) 透過你正在使用的瀏覽器搜尋 Google、讀取網頁。

`google_search` 回傳搜尋連結與摘要，`visit_page` 把網頁主要文字轉成 Markdown。兩者都透過 CDP 連接既有 Arc 或 Chromium，沿用登入狀態，完成後關閉自己建立的臨時分頁。

不需要搜尋 API key。使用 Arc 時，不必另外下載瀏覽器或建立另一份 profile。

[English](README.md)

## 安裝

需要 Node.js **22.19+**、[Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)，以及已啟用 CDP 的 Chromium 瀏覽器。已驗證 Pi 1.1 與 1.3。

```bash
pi install git:github.com/qoli/pi-arc-cdp-search
```

啟動 Pi；已開啟的 session 執行 `/reload`。再用 `/cdp-search` 確認連線，之後直接對 Pi 說：

```text
幫我搜尋 Google，找 Chrome DevTools Protocol 的文件。
讀取 https://example.com 並整理重點。
```

工具介面：

```text
google_search({ "query": "Chrome DevTools Protocol" })
visit_page({ "url": "https://example.com" })
```

解除安裝：

```bash
pi remove git:github.com/qoli/pi-arc-cdp-search
```

如果之前手動安裝過 `arc-cdp-search.ts`，請先移除舊的 extension 入口，避免同一組工具載入兩次。

## 連接瀏覽器

預設端點是 `http://localhost:9222`。

macOS 上使用 **Arc** 時，先完全退出 Arc，再執行：

```bash
open -a "Arc" --args --remote-debugging-port=9222
```

確認端點可連線：

```bash
curl -fsS http://localhost:9222/json/version
```

使用其他端點時，在啟動 Pi 前設定：

```bash
PI_CDP_URL=http://127.0.0.1:9333 pi
```

其他 Chromium 瀏覽器只要提供相同 HTTP CDP 與分頁 WebSocket 介面也能使用。近期 Google Chrome 需要搭配非預設的 `--user-data-dir`，詳見 [Chrome 官方說明](https://developer.chrome.com/blog/remote-debugging-port)。插件只連接現有瀏覽器，由你自行啟動與管理。

CDP 端點能控制你的瀏覽器 session，請維持在可信任的本機介面。工具擷取的網頁文字會送進 Pi 模型的上下文。

## 功能與限制

| 工具／指令 | 功能 |
| --- | --- |
| `google_search({ query })` | 最多 12 筆擷取結果，包含標題、網址與摘要 |
| `visit_page({ url })` | 擷取主要文字、標題、清單、程式碼區塊與連結；最多 60,000 字元 |
| `/cdp-search` | 顯示 CDP 連線、瀏覽器版本及選用的 computer-use port 對應 |

搜尋會要求英文 Google 介面（`hl=en`），瀏覽器 session 與所在地仍可能影響結果。擷取器遇到常見 Cookie 同意按鈕時，會嘗試點擊 **Accept all** 或 **I agree** 等按鈕。

已登入頁面須以你的 session 確實有權存取為前提。CAPTCHA、存取限制與付費牆仍可能阻擋讀取；插件不會自動改用其他搜尋服務。沒有搜尋結果時，會回傳最後網址供檢查。

讀頁功能擷取可見文字；圖片、表格、shadow DOM 或較晚載入的內容可能不完整。Google 改版時，擷取器也可能需要更新。

## 選用：pi-computer-use

搜尋與讀頁可以獨立使用。若另外安裝 [`@injaneity/pi-computer-use`](https://www.npmjs.com/package/@injaneity/pi-computer-use)，插件會把本機 HTTP CDP port 設到 `PI_COMPUTER_USE_CDP_PORT`，讓它找到既有分頁：

```text
find_roots({ "kind": "browser_page" })
```

你明確設定的 `PI_COMPUTER_USE_CDP_PORT` 優先。自動對應只接受 `http://localhost` 與 `http://127.0.0.1`，因為 pi-computer-use 連接的是 `127.0.0.1`。`/cdp-search` 顯示對應狀態，不代表已確認選用套件有安裝。

## 開發與驗證

```bash
git clone https://github.com/qoli/pi-arc-cdp-search.git
cd pi-arc-cdp-search
npm ci
npm run check
npm test
```

自動測試使用本機模擬 CDP server，不需要瀏覽器或模型憑證。實際瀏覽器驗證：

```bash
npm run test:live
```

這會搜尋 Google、讀取 `https://example.com`，並確認臨時分頁已關閉。端點使用預設值或 `PI_CDP_URL`。

在 Pi 試用本機修改：

```bash
pi -e ./arc-cdp-search.ts
```

套件遵循 [Pi package 格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)，直接載入 TypeScript，不需要編譯步驟。

## 授權

[MIT](LICENSE) © Ronnie W.
