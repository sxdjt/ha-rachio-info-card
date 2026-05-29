# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-29

### Added

- "Updated HH:MM" badge in the card header showing the time of the last successful fetch (honours `use_24h`)
- History toggle is now keyboard-activatable (Enter/Space) and exposes `role="button"`, `aria-expanded`, and an `aria-label` for screen readers
- Play/stop buttons are disabled with an explanatory tooltip when the Rachio controller is offline
- Online/offline tooltip on the controller status dot
- Visual editor masks the Rachio API key as a password field and renders the helper text under each input

### Changed

- Stop button label is now "Stop watering" - `/public/device/stop_water` halts ALL watering on the controller (including queued zones in a schedule), and the label now matches that scope
- Polling pauses while the dashboard tab is hidden and resumes (with an immediate refresh) when it becomes visible again
- History section skips its filter/sort/slice work while collapsed
- Last-watered-per-zone map is cached on the instance and only rebuilt when the underlying data changes

### Fixed

- Race condition where a polling tick firing during an in-flight retry could mutate shared state concurrently; `_loadData` now de-duplicates concurrent calls
- Pending retry and post-zone-toggle refresh timers were not cleared on `disconnectedCallback` and could fire on a detached card; they are now tracked and cancelled on disconnect
- `escapeHtml` now also encodes `"` so the function is safe in HTML attribute contexts

### Removed

- Unused `formatShortDate` utility

## [1.1.3] - 2026-05-17

### Removed

- Next scheduled run date from schedule list - the Rachio API does not expose this data and the computed estimate was unreliable when runs are skipped (rain hold, soil saturation)

## [1.1.2] - 2026-05-13

### Fixed
- Replace deprecated `ha-textfield` with `ha-selector` in visual editor for compatibility with HA 2026.5.1+

## [1.1.1] - 2026-04-29

### Fixed

- Next scheduled run date now anchors off the most recent actual zone-complete event for zones in the schedule, rather than the schedule's original `startDate`. This prevents drift when Rachio delays a run (e.g. due to a rain hold), which caused the card to report an incorrect next-run date.
- Fixed a secondary issue where the fallback `startDate`-based calculation could show "today" as the next run even after the schedule had already completed for the day.

## [1.1.0] - 2026-04-28

### Added

- Play/stop button on each enabled zone row for manual zone control directly from the card
- `default_run_minutes` config option: how long to run a zone when started manually (default: 10, max: 120)
- Zones start via `PUT /public/zone/start`; stop via `PUT /public/device/stop_water`
- Card automatically refreshes 10 seconds after a zone is started to allow the controller time to update

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
