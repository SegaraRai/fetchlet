---
"@fetchlet-crates/fetchlet-http": minor
---

fetchlet-http serves a webview's custom URI scheme, such as Tauri's, in-process. `WebviewScheme` names the scheme and gives the URL a window opens on each platform and the origin the application sees on all of them. `WebviewResponder` answers each request with a Tower service it makes for that request, such as the current build of `DevReload`, and collects the response within a body budget the caller sets, answering 502 above it. With the `axum` feature, `Server::webview` starts a `Server`'s application for a scheme instead of a listener and returns a `Webview` that answers requests, hands out the current `AppHandle`, and with `dev` yields each new build through `reloads()`.
