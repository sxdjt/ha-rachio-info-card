# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-28

### Added

- Zone list with last watered date/time and duration per zone
- Currently running zone highlighted with a "Running" badge
- Schedule list with Fixed/Smart type badges, total duration, and next scheduled run date
- Collapsible watering history section
- Online/offline status indicator for the controller
- Periodic auto-refresh with configurable interval (15-3600 seconds)
- `use_24h` config option for 12/24-hour time display (default: true)
- `show_disabled_zones` and `show_disabled_schedules` config options
- `device_index` config option for multi-controller setups
- `history_days` config option (1-90 days)
- Visual editor support in the Lovelace UI
- HACS installation support
- Graceful degradation: renders cached data on API failure with stale indicator
- XSS protection on all API-sourced strings
