# ha-rachio-info-card

A Home Assistant Lovelace card for Rachio irrigation controllers. Displays zone status, schedules, and watering history using the Rachio REST API directly - no Home Assistant Rachio integration required.

[![AI Assisted](https://img.shields.io/badge/AI-Claude%20Code-AAAAAA.svg)](https://claude.ai/code)

## Features

- Zone list with last watered date/time and duration per zone
- Currently running zone highlighted with a "Running" badge
- Schedule list with Fixed/Smart type badges and total duration
- Collapsible watering history section
- Online/offline status indicator for the controller
- Periodic auto-refresh (configurable)
- Visual editor support

## Installation

### Manual

1. Download `rachio-card.js` and copy it to `/config/www/rachio-card.js` on your Home Assistant instance.
2. Go to **Settings -> Dashboards -> Resources** and add `/local/rachio-card.js` as a JavaScript module.
3. Hard-refresh your browser.

### HACS

Add this repository as a custom repository in HACS (type: Lovelace), then install via the HACS UI.

## Configuration

Get your Rachio API key from the Rachio app: **Account -> API Access**.

### Minimal

```yaml
type: custom:rachio-card
api_key: your-rachio-api-key
```

### All options

```yaml
type: custom:rachio-card
api_key: your-rachio-api-key
title: Rachio Irrigation       # default: "Rachio Irrigation"
update_interval: 60            # seconds between API polls, default: 60, min: 15
history_days: 7                # days of history to show, default: 7, max: 90
show_disabled_zones: false     # show disabled zones in the zone list, default: false
show_disabled_schedules: false # show disabled schedules, default: false
use_24h: true                  # 24-hour time display, default: true
device_index: 0                # which controller to show (0 = first), default: 0
```

## Requirements

- Home Assistant 2023.x or later
- A Rachio irrigation controller with API access enabled
- Rachio API key (free tier supports the required endpoints)

## License

MIT
