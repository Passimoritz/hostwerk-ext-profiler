![Profiler](banner.svg)

# Profiler

Finds out why a page or app is slow: PHP profile with one click (Xdebug), Node and Python apps through the inspector or cProfile.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

![Screenshot](docs/screenshot.png)

## What it does

- PHP profile with one click (Xdebug is switched on just for the call and set back afterwards – also when something fails)
- Node.js apps through the inspector, Python through cProfile – a copy runs on its own port, the real app stays untouched
- The slowest functions, the share of the database and a **flame graph** (click a bar to zoom in)
- **Before and after**: the last 10 measurements are kept – compare any two, down to the function
- **Measure a request**: any address with GET, POST, PUT … and a body; PHP projects are found by their address. The API tester uses the same (`ctx.profiler.runRequest({ url, method, headers, body })`)
- **Small load test**: N calls, several at once, with median, 95 %, slowest and calls per second – only against this computer or your own network
- Plain hints and an AI explanation, tab “Performance” in every project, error states with “Try again”
- Sits under “Develop” right after the projects; a shortcut to assign under Settings → General → Shortcuts

## Install

In Hostwerk: **Extensions → Discover** and click “Install”. If you already used this feature in Hostwerk 2.8, the update installs the extension by itself – with all your data.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/profile` – exactly where Hostwerk always kept it. Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
