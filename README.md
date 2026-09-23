# Spread Monitor

A Chrome extension that tracks the spread between the **last price** and the **fair (mark) price** of perpetual futures across **10 crypto exchanges** in real time, and shows it right on the exchange's trading page.

## Features

- **Real-time monitoring** of last vs. fair price for futures pairs on 10 exchanges (polling every ~1 second)
- **On-page widget** on any supported exchange: spreads for the current pair across all exchanges, max available leverage, and one-click links to open the same pair on another exchange
- **Futures / Spot toggle** in the widget
- **Popup dashboard** with a full spread table: ticker search, exchange filter, minimum spread filter and sorting
- **Anomaly detection**: flags large spreads combined with high leverage and sharp price moves within 1–2 minutes, filtered by market cap (CoinGecko), with a cooldown per pair
- **Anomaly log** tab with every trigger, including ones skipped by cooldown
- Draggable widget with saved position, badge on the extension icon, graceful handling of slow or unavailable exchanges

## Supported exchanges

Binance · Bybit · OKX · MEXC · Gate · KuCoin · Bitget · BingX · Ourbit · Aster

## Tech stack

- JavaScript (ES6+, ES modules), HTML, CSS
- Chrome Extensions API, **Manifest V3**: service worker, content scripts, popup, `chrome.storage`, `chrome.alarms`, runtime messaging
- REST APIs of 10 exchanges + CoinGecko API

## How it works

1. The **background service worker** polls the public REST APIs of all exchanges in parallel (`Promise.allSettled`, `AbortController` timeouts), normalizes tickers and responses into a single format and caches the results. A `chrome.alarms` keepalive prevents the worker from going idle.
2. Leverage limits, spot prices and market caps are refreshed on separate, slower schedules.
3. The **content script** detects the current pair from the exchange page, requests data from the worker and renders the widget.
4. The **popup** shows the full table and the anomaly log.

## Installation

1. Download or clone this repository:
   ```bash
   git clone https://github.com/yukiiyome/spread-monitor.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open a futures pair on any supported exchange — the widget will appear on the page.

## Project structure

```
├── manifest.json      # Extension config (Manifest V3)
├── background.js      # Service worker: polling, data normalization, anomaly detection
├── content.js         # On-page widget
├── content.css        # Widget styles
├── popup.html         # Popup layout
├── popup.js           # Popup logic: table, filters, logs
├── popup.css          # Popup styles
└── icons/             # Extension and exchange icons
```

## Disclaimer

This tool is for informational purposes only and is not financial advice. It uses only public market data and does not require API keys or access to your account.

## Author

Telegram: [@cellbaker](https://t.me/cellbaker)
