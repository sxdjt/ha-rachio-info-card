/**
 * Rachio Card - v1.1.2
 * Home Assistant Lovelace card for Rachio irrigation controllers.
 * Displays zone status, schedules, and watering history via the Rachio REST API.
 * https://github.com/sxdjt/ha-rachio-card
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the Rachio v1 REST API */
const RACHIO_API_BASE = 'https://api.rach.io/1';

/** Default polling interval in seconds */
const DEFAULT_UPDATE_INTERVAL = 60;

/** Default number of days of history to display */
const DEFAULT_HISTORY_DAYS = 7;

/** Maximum number of history events to display in the card */
const MAX_HISTORY_EVENTS = 30;

/** Fetch retry settings */
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5000; // doubled each attempt (5s, 10s, 20s)

/**
 * Default run duration in minutes used when no default_run_minutes is set in config.
 * The Rachio zone/start endpoint requires a duration; 10 minutes is a sensible default.
 */
const DEFAULT_RUN_MINUTES = 10;

/**
 * Rachio event topic value for all watering-related events.
 * Both zone-level and schedule-level watering events share this topic.
 */
const WATERING_TOPIC = 'WATERING';

/**
 * Rachio event type value for zone-level events specifically.
 * Used when building the last-watered map (requires a zoneId).
 */
const ZONE_EVENT_TYPE = 'ZONE_STATUS';

/**
 * Event subtypes that indicate a watering run ended (zone or schedule level).
 * ZONE_COMPLETED / ZONE_STOPPED       = zone finished or was manually stopped.
 * SCHEDULE_COMPLETED / SCHEDULE_STOPPED = full schedule finished or was stopped.
 */
const WATERING_COMPLETE_SUBTYPES = new Set([
  'ZONE_COMPLETED',
  'ZONE_STOPPED',
  'SCHEDULE_COMPLETED',
  'SCHEDULE_STOPPED'
]);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe insertion into innerHTML.
 * Prevents XSS when rendering API-supplied strings.
 *
 * @param {*} value - Value to escape (coerced to string)
 * @returns {string} HTML-safe string
 */
function escapeHtml(value) {
  if (value == null) return '';
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

/**
 * Format a Unix timestamp (milliseconds) as a localized date + time string.
 * E.g., "Jan 5, 10:30 AM".
 *
 * @param {number|string} timestampMs - Unix timestamp in milliseconds
 * @returns {string} Formatted string, or 'N/A' on failure
 */
function formatDateTime(timestampMs, hour12 = false) {
  if (!timestampMs) return 'N/A';
  try {
    const date = new Date(Number(timestampMs));
    if (isNaN(date.getTime())) return 'N/A';
    const day = date.getDate().toString().padStart(2, '0');
    const month = date.toLocaleString(undefined, { month: 'short' });
    if (hour12) {
      // Locale handles AM/PM placement correctly
      const time = date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      return `${day} ${month} ${time}`;
    }
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day} ${month} ${hours}:${minutes}`;
  } catch {
    return 'N/A';
  }
}

/**
 * Format a Unix timestamp (milliseconds) as a short date string.
 * E.g., "Jan 5". Used for the "last watered" label on zones.
 *
 * @param {number} timestampMs - Unix timestamp in milliseconds
 * @returns {string} Formatted string, or 'N/A' on failure
 */
function formatShortDate(timestampMs) {
  if (!timestampMs) return 'N/A';
  try {
    const date = new Date(Number(timestampMs));
    if (isNaN(date.getTime())) return 'N/A';
    const day = date.getDate().toString().padStart(2, '0');
    const month = date.toLocaleString(undefined, { month: 'short' });
    return `${day} ${month}`;
  } catch {
    return 'N/A';
  }
}

/**
 * Parse a duration in seconds from a Rachio event summary string.
 * The Rachio API embeds duration as text at the end of summary strings,
 * e.g. "Front Beds stopped watering at 01:58 PM (PDT) for 3 minutes."
 *
 * Handles: "for X hours Y minutes", "for X minutes", "for X seconds".
 *
 * @param {string} summary - Rachio event summary string
 * @returns {number|null} Duration in seconds, or null if not parseable
 */
function parseDurationFromSummary(summary) {
  if (!summary) return null;

  const hoursAndMinutes = summary.match(/for (\d+) hours? (\d+) minutes?/i);
  if (hoursAndMinutes) {
    return parseInt(hoursAndMinutes[1], 10) * 3600 + parseInt(hoursAndMinutes[2], 10) * 60;
  }

  const minutesOnly = summary.match(/for (\d+) minutes?/i);
  if (minutesOnly) return parseInt(minutesOnly[1], 10) * 60;

  const secondsOnly = summary.match(/for (\d+) seconds?/i);
  if (secondsOnly) return parseInt(secondsOnly[1], 10);

  return null;
}

/**
 * Format a duration in seconds as a human-readable string.
 * E.g., 90 -> "1m 30s", 3660 -> "1h 1m", 30 -> "30s".
 *
 * @param {number} seconds - Duration in seconds
 * @returns {string} Human-readable duration
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

/**
 * Compute the next scheduled run date for a fixed schedule.
 *
 * The Rachio API does not provide a precomputed next-run timestamp. For
 * INTERVAL_N schedules, the next run is derived from the schedule's startDate
 * (the reference anchor) and the repeat interval in days.
 *
 * @param {object} schedule - Rachio scheduleRule object
 * @returns {number|null} Unix timestamp (ms) of the next run, or null if
 *   the schedule type is not supported or data is missing
 */
function computeNextRunDate(schedule, lastRunMs = null) {
  const jobTypes = schedule.scheduleJobTypes || [];

  // Only handle INTERVAL_N types (e.g. "INTERVAL_3" = every 3 days)
  const intervalType = jobTypes.find(t => /^INTERVAL_\d+$/.test(t));
  if (!intervalType) return null;

  const intervalDays = parseInt(intervalType.split('_')[1], 10);
  if (!intervalDays) return null;

  const msPerDay = 24 * 60 * 60 * 1000;

  // Prefer anchoring off the last actual run date rather than startDate.
  // startDate is the original schedule creation anchor and does not update
  // when Rachio delays a run (e.g. due to rain hold), causing drift.
  if (lastRunMs) {
    return lastRunMs + intervalDays * msPerDay;
  }

  // Fall back to startDate-based calculation when no history is available.
  if (!schedule.startDate) return null;

  const startMs = Number(schedule.startDate);
  const nowMs = Date.now();

  // Schedule hasn't started yet - next run is the start date itself
  if (nowMs < startMs) return startMs;

  const daysSinceStart = Math.floor((nowMs - startMs) / msPerDay);
  const daysIntoCycle = daysSinceStart % intervalDays;

  // When daysIntoCycle === 0, today is a cycle day but we cannot tell whether
  // the schedule has already run today. Always advance to the next interval to
  // avoid showing a stale "today" after the run has already completed.
  const daysUntilNext = daysIntoCycle === 0 ? intervalDays : (intervalDays - daysIntoCycle);
  return nowMs + daysUntilNext * msPerDay;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated GET request to the Rachio REST API.
 * Throws if the response status is not OK (2xx).
 *
 * @param {string} apiKey - Rachio API key used as Bearer token
 * @param {string} path   - API path starting with '/', e.g. '/public/person/info'
 * @returns {Promise<object>} Parsed JSON response body
 */
async function rachioGet(apiKey, path) {
  const response = await fetch(`${RACHIO_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Rachio API ${response.status}: ${response.statusText} (${path})`);
  }

  return response.json();
}

/**
 * Perform an authenticated PUT request to the Rachio REST API.
 * Used for write operations such as starting or stopping a zone.
 *
 * @param {string} apiKey - Rachio API key used as Bearer token
 * @param {string} path   - API path starting with '/', e.g. '/public/zone/start'
 * @param {object} body   - Request body (serialised as JSON)
 * @returns {Promise<object|null>} Parsed JSON response, or null for 204 No Content
 */
async function rachioPut(apiKey, path, body) {
  const response = await fetch(`${RACHIO_API_BASE}${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Rachio API ${response.status}: ${response.statusText} (${path})`);
  }

  // zone/start and device/stop_water return 204 No Content on success
  return response.status === 204 ? null : response.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Build and return a <style> element containing all card CSS.
 *
 * @returns {HTMLStyleElement}
 */
function createStyleElement() {
  const style = document.createElement('style');
  style.textContent = `
    :host {
      display: block;
    }
    ha-card {
      padding: 0 16px 16px;
      display: block;
    }

    /* Card header */
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0 8px;
      margin-bottom: 4px;
      gap: 8px;
      border-bottom: 1px solid var(--divider-color);
    }
    .card-title {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
      letter-spacing: -0.02em;
      color: var(--primary-text-color);
    }
    .controller-info {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--secondary-text-color);
      flex-shrink: 0;
    }

    /* Online status dot - pulses when controller is online */
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--disabled-color, #888);
    }
    .status-dot.online {
      background: var(--success-color, #28a745);
    }

    /* Section headers */
    .section-header {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--secondary-text-color);
      opacity: 0.65;
      margin: 14px 0 4px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--divider-color);
    }
    .section-header:first-of-type {
      margin-top: 8px;
    }

    /* Zone rows */
    .zone-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 6px;
      margin: 0 -6px;
      border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 55%, transparent);
      gap: 8px;
      border-radius: 5px;
      transition: background 0.12s ease;
    }
    .zone-row:last-child {
      border-bottom: none;
    }
    .zone-row:hover {
      background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    }
    /* Running zone: inset left accent + subtle tint */
    .zone-row.zone-running {
      background: color-mix(in srgb, var(--success-color, #28a745) 8%, transparent);
      box-shadow: inset 3px 0 0 var(--success-color, #28a745);
    }
    .zone-row.zone-running:hover {
      background: color-mix(in srgb, var(--success-color, #28a745) 12%, transparent);
    }

    .zone-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    /* Zone number rendered as a small square pill */
    .zone-number {
      font-size: 10px;
      font-weight: 700;
      color: var(--secondary-text-color);
      min-width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--secondary-text-color) 12%, transparent);
      border-radius: 4px;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    .zone-name {
      font-size: 14px;
      color: var(--primary-text-color);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .zone-name.disabled {
      color: var(--disabled-color, #999);
      font-style: italic;
    }
    .zone-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .zone-last-watered {
      font-size: 11px;
      color: var(--secondary-text-color);
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      opacity: 0.8;
    }
    .zone-duration {
      font-size: 11px;
      color: var(--secondary-text-color);
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      opacity: 0.8;
      min-width: 40px;
    }

    /* Schedule rows */
    .schedule-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 6px;
      margin: 0 -6px;
      border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 55%, transparent);
      gap: 8px;
      border-radius: 5px;
      transition: background 0.12s ease;
    }
    .schedule-row:last-child {
      border-bottom: none;
    }
    .schedule-row:hover {
      background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    }
    .schedule-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .schedule-name {
      font-size: 14px;
      color: var(--primary-text-color);
    }
    .schedule-name.disabled {
      color: var(--disabled-color, #999);
      font-style: italic;
    }
    .schedule-meta {
      font-size: 11px;
      color: var(--secondary-text-color);
      opacity: 0.8;
    }
    .schedule-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    /* History rows */
    .history-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 6px 6px;
      margin: 0 -6px;
      border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 55%, transparent);
      gap: 8px;
      border-radius: 5px;
    }
    .history-row:last-child {
      border-bottom: none;
    }
    .history-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .history-zone-name {
      font-size: 13px;
      color: var(--primary-text-color);
    }
    .history-meta {
      font-size: 11px;
      color: var(--secondary-text-color);
      opacity: 0.8;
      font-variant-numeric: tabular-nums;
    }
    .history-duration {
      font-size: 11px;
      font-weight: 600;
      color: var(--secondary-text-color);
      flex-shrink: 0;
    }

    /* Badges */
    .badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      white-space: nowrap;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .badge-running {
      background: color-mix(in srgb, var(--success-color, #28a745) 15%, transparent);
      color: var(--success-color, #28a745);
      border: 1px solid color-mix(in srgb, var(--success-color, #28a745) 35%, transparent);
    }
    .badge-disabled {
      background: color-mix(in srgb, var(--secondary-text-color) 10%, transparent);
      color: var(--secondary-text-color);
      opacity: 0.7;
    }
    .badge-fixed {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: color-mix(in srgb, var(--primary-color) 14%, transparent);
      color: var(--primary-color);
    }
    .badge-flex {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: color-mix(in srgb, var(--accent-color, #ff9800) 14%, transparent);
      color: var(--accent-color, #ff9800);
    }

    /* Collapsible history toggle */
    .section-header-toggle {
      cursor: pointer;
      user-select: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: opacity 0.12s ease;
    }
    .section-header-toggle:hover {
      opacity: 1;
      color: var(--primary-color);
    }
    .toggle-chevron {
      font-size: 9px;
      opacity: 0.55;
    }

    /* State messages */
    .no-data {
      font-size: 13px;
      color: var(--secondary-text-color);
      padding: 6px 0;
      font-style: italic;
      opacity: 0.65;
    }
    .error-message {
      padding: 10px 12px;
      border-radius: 5px;
      color: var(--error-color, #dc3545);
      background: color-mix(in srgb, var(--error-color, #dc3545) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--error-color, #dc3545) 25%, transparent);
      font-size: 13px;
      margin: 4px 0;
    }
    .loading-message {
      font-size: 13px;
      color: var(--secondary-text-color);
      padding: 8px 0;
      opacity: 0.65;
    }
    .stale-indicator {
      font-size: 11px;
      color: var(--warning-color, #ffc107);
      opacity: 0.85;
    }

    /* Zone play/stop toggle button */
    .zone-toggle-btn {
      background: none;
      border: 1px solid color-mix(in srgb, var(--secondary-text-color) 30%, transparent);
      border-radius: 4px;
      cursor: pointer;
      padding: 3px 6px;
      color: var(--secondary-text-color);
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }
    .zone-toggle-btn:hover {
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      color: var(--primary-color);
      border-color: color-mix(in srgb, var(--primary-color) 50%, transparent);
    }
    .zone-toggle-btn.zone-toggle-stop {
      color: var(--error-color, #dc3545);
      border-color: color-mix(in srgb, var(--error-color, #dc3545) 40%, transparent);
    }
    .zone-toggle-btn.zone-toggle-stop:hover {
      background: color-mix(in srgb, var(--error-color, #dc3545) 12%, transparent);
    }
    .zone-toggle-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
  `;
  return style;
}

// ---------------------------------------------------------------------------
// Visual Editor
// ---------------------------------------------------------------------------

/**
 * Visual editor for rachio-card.
 * Rendered inside the HA card picker editor panel.
 */
class RachioCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._rendered = false;
  }

  setConfig(config) {
    this._config = { ...config };
    // Render once on first setConfig. Subsequent calls preserve DOM to avoid
    // losing focus from textfields mid-edit.
    if (!this._rendered) {
      this._render();
      this._rendered = true;
    }
  }

  set hass(hass) {
    this._hass = hass;
    // Propagate hass to all ha-selector elements (required for proper rendering)
    this.shadowRoot?.querySelectorAll('ha-selector').forEach(s => {
      s.hass = hass;
    });
  }

  /** Dispatch the config-changed event so HA updates the card preview. */
  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      bubbles: true,
      composed: true,
      detail: { config: this._config }
    }));
  }

  /**
   * Update a single config field and fire config-changed.
   * Deletes the field if the value is empty/null/undefined.
   */
  _valueChanged(field, value) {
    if (value === '' || value === undefined || value === null) {
      const updated = { ...this._config };
      delete updated[field];
      this._config = updated;
    } else {
      this._config = { ...this._config, [field]: value };
    }
    this._fireConfigChanged();
  }

  /** Build a labeled ha-selector wrapped in a .field div. */
  _createTextfield(field, label, value, helperText, type = 'text') {
    const container = document.createElement('div');
    container.className = 'field';

    const selector = document.createElement('ha-selector');
    selector.hass = this._hass;
    selector.label = label;
    if (type === 'number') {
      selector.selector = { number: { mode: 'box', step: 1 } };
    } else {
      selector.selector = { text: {} };
    }
    selector.value = value ?? '';

    selector.addEventListener('value-changed', (e) => {
      e.stopPropagation();
      const raw = e.detail.value;
      const newValue = type === 'number'
        ? (raw === '' ? undefined : Number(raw))
        : raw;
      this._valueChanged(field, newValue);
    });

    container.appendChild(selector);
    return container;
  }

  /** Build a labeled ha-switch toggle row. */
  _createSwitch(field, label, checked, helperText) {
    const container = document.createElement('div');
    container.className = 'toggle-row';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;

    const toggle = document.createElement('ha-switch');
    toggle.checked = Boolean(checked);
    toggle.addEventListener('change', (e) => {
      this._valueChanged(field, e.target.checked);
    });

    container.appendChild(labelEl);
    container.appendChild(toggle);

    if (helperText) {
      const helper = document.createElement('div');
      helper.className = 'toggle-helper';
      helper.textContent = helperText;
      container.appendChild(helper);
    }

    return container;
  }

  /** Wrap content in a ha-expansion-panel. */
  _createExpansionPanel(header, content) {
    const panel = document.createElement('ha-expansion-panel');
    panel.header = header;
    panel.outlined = true;
    panel.appendChild(content);
    return panel;
  }

  _render() {
    if (!this.shadowRoot) return;

    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; padding: 16px; }
      .field { display: block; margin-bottom: 16px; }
      .field ha-selector { display: block; width: 100%; }
      ha-expansion-panel { display: block; margin-bottom: 8px; }
      .panel-content { padding: 12px; }
      .section-note {
        font-size: 12px;
        color: var(--secondary-text-color);
        font-style: italic;
        margin-bottom: 12px;
      }
      .toggle-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        flex-wrap: wrap;
      }
      .toggle-row label { font-size: 14px; color: var(--primary-text-color); }
      .toggle-helper {
        width: 100%;
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-top: 4px;
      }
      h3 { margin: 0 0 12px 0; font-size: 16px; font-weight: 500; }
    `;

    const root = document.createElement('div');

    // -- Required settings (always visible) --
    const basicSection = document.createElement('div');
    basicSection.innerHTML = '<h3>Required Settings</h3>';
    basicSection.appendChild(this._createTextfield(
      'api_key', 'Rachio API Key', this._config.api_key,
      'Found in the Rachio app under Account Settings. In YAML mode you can use !secret rachio_api_key.'
    ));
    basicSection.appendChild(this._createTextfield(
      'title', 'Card Title', this._config.title,
      'Displayed at the top of the card (default: Rachio Irrigation)'
    ));
    root.appendChild(basicSection);

    // -- Display options --
    const displayContent = document.createElement('div');
    displayContent.className = 'panel-content';
    displayContent.appendChild(this._createTextfield(
      'update_interval', 'Update Interval (seconds)', this._config.update_interval,
      'How often to poll the Rachio API (default: 60, min: 15)', 'number'
    ));
    displayContent.appendChild(this._createTextfield(
      'history_days', 'History Days', this._config.history_days,
      'Days of watering history to show (default: 7, max: 90)', 'number'
    ));
    displayContent.appendChild(this._createTextfield(
      'default_run_minutes', 'Default Run Time (minutes)', this._config.default_run_minutes,
      'How long to run a zone when started manually (default: 10, max: 120)', 'number'
    ));
    displayContent.appendChild(this._createSwitch(
      'show_disabled_zones', 'Show Disabled Zones', this._config.show_disabled_zones,
      'Include zones marked disabled in the zone list'
    ));
    displayContent.appendChild(this._createSwitch(
      'show_disabled_schedules', 'Show Disabled Schedules', this._config.show_disabled_schedules,
      'Include schedules marked disabled in the schedule list'
    ));
    displayContent.appendChild(this._createSwitch(
      'use_24h', '24-hour Clock', this._config.use_24h,
      'Display times in 24-hour format instead of 12-hour AM/PM'
    ));
    root.appendChild(this._createExpansionPanel('Display Options', displayContent));

    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(root);
  }
}

customElements.define('rachio-card-editor', RachioCardEditor);

// ---------------------------------------------------------------------------
// Main Card Component
// ---------------------------------------------------------------------------

/**
 * RachioCard - main Lovelace card element.
 *
 * Lifecycle:
 *   setConfig() -> connectedCallback() -> polling starts
 *   hass setter  -> ignored (card talks directly to Rachio API)
 *   disconnectedCallback() -> polling stops
 *
 * Data is fetched from the Rachio REST API using the configured API key.
 * No Home Assistant entities or services are used.
 */
class RachioCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._config = {};
    this._hass = null;     // Available but unused - card calls Rachio directly
    this._interval = null; // setInterval handle for periodic refresh
    this._retryCount = 0;

    // Cached API data, updated on each successful fetch
    this._deviceData = null;
    this._currentSchedule = null;
    this._historyEvents = [];

    // UI state preserved across re-renders
    this._historyExpanded = false; // history section starts collapsed
    this._isStale = false;        // tracks stale state for toggle re-renders

    // Build shadow DOM structure once
    this.shadowRoot.appendChild(createStyleElement());
    this._content = document.createElement('ha-card');
    this.shadowRoot.appendChild(this._content);

    // Delegated listener for zone play/stop buttons. Attached once here so it
    // survives innerHTML replacements on each re-render.
    this._content.addEventListener('click', (e) => {
      const btn = e.target.closest('.zone-toggle-btn');
      if (!btn || btn.disabled) return;
      this._toggleZone(
        btn.dataset.zoneId,
        btn.dataset.deviceId,
        btn.dataset.running === 'true'
      );
    });
  }

  set hass(hass) {
    // Stored for potential future use (e.g., calling HA services).
    // Not currently used since all data comes from the Rachio API.
    this._hass = hass;
  }

  /**
   * Validate and store card configuration.
   * Called by Home Assistant when the card YAML config is parsed.
   *
   * @param {object} config - Card configuration from Lovelace YAML
   * @throws {Error} If required fields are missing
   */
  setConfig(config) {
    if (!config.api_key) {
      throw new Error("rachio-card: 'api_key' is required. Add it to your card config.");
    }

    this._config = {
      title: 'Rachio Irrigation',
      update_interval: DEFAULT_UPDATE_INTERVAL,
      history_days: DEFAULT_HISTORY_DAYS,
      show_disabled_zones: false,
      show_disabled_schedules: false,
      use_24h: true,
      default_run_minutes: DEFAULT_RUN_MINUTES,
      device_index: 0, // which device to display if the account has multiple controllers
      ...config
    };

    // Clamp update_interval to a safe range so we don't hammer the API
    this._config.update_interval = Math.max(15, Math.min(3600, this._config.update_interval));

    // Clamp history_days to a reasonable range
    this._config.history_days = Math.max(1, Math.min(90, this._config.history_days));

    // Clamp default_run_minutes to 1-120
    this._config.default_run_minutes = Math.max(1, Math.min(120, this._config.default_run_minutes));
  }

  connectedCallback() {
    this._renderLoading();
    this._startPolling();
  }

  disconnectedCallback() {
    this._stopPolling();
  }

  _startPolling() {
    this._stopPolling();
    this._loadData();
    this._interval = setInterval(
      () => this._loadData(),
      this._config.update_interval * 1000
    );
  }

  _stopPolling() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Data Loading
  // ---------------------------------------------------------------------------

  /**
   * Main data loading sequence. Fetches all required data from the Rachio API
   * and triggers a re-render on success.
   *
   * On failure, retries up to MAX_RETRIES times with exponential backoff.
   * If retries are exhausted and cached data exists, renders stale data.
   */
  async _loadData() {
    try {
      // Step 1: Resolve person ID from the authenticated API key
      const personInfo = await rachioGet(this._config.api_key, '/public/person/info');
      const personId = personInfo.id;

      if (!personId) {
        throw new Error('No person ID returned - check your API key.');
      }

      // Step 2: Fetch person record which contains all devices, zones, and schedules
      const personData = await rachioGet(this._config.api_key, `/public/person/${personId}`);
      const devices = personData.devices;

      if (!devices || devices.length === 0) {
        this._renderError('No Rachio controllers found for this account.');
        return;
      }

      // Select the target device (default: first device)
      const deviceIndex = Math.min(this._config.device_index, devices.length - 1);
      const device = devices[deviceIndex];
      this._deviceData = device;

      // Step 3: Fetch current schedule and event history in parallel.
      // Both are non-critical - if either fails, we degrade gracefully.
      const deviceId = device.id;
      const endTimeMs = Date.now();
      const startTimeMs = endTimeMs - (this._config.history_days * 24 * 60 * 60 * 1000);

      const [scheduleResult, historyResult] = await Promise.allSettled([
        rachioGet(this._config.api_key, `/public/device/${deviceId}/current_schedule`),
        rachioGet(
          this._config.api_key,
          `/public/device/${deviceId}/event?startTime=${startTimeMs}&endTime=${endTimeMs}`
        )
      ]);

      // current_schedule returns {} when nothing is running - treat as null
      const schedule = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
      this._currentSchedule = (schedule && schedule.zoneId) ? schedule : null;

      // history returns an array; fall back to empty on error
      this._historyEvents = historyResult.status === 'fulfilled'
        ? (Array.isArray(historyResult.value) ? historyResult.value : [])
        : [];

      if (historyResult.status === 'rejected') {
        console.warn('Rachio Card: History fetch failed:', historyResult.reason);
      }


      this._retryCount = 0;

      this._renderCard(/* stale= */ false);

    } catch (err) {
      console.error('Rachio Card: Data fetch failed:', err);

      if (this._retryCount < MAX_RETRIES) {
        this._retryCount++;
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, this._retryCount - 1);
        console.log(`Rachio Card: Retry ${this._retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s`);
        setTimeout(() => this._loadData(), delayMs);
      } else {
        // Retries exhausted - show stale data if we have it, otherwise show error
        if (this._deviceData) {
          console.warn('Rachio Card: Using cached data after fetch failures.');
          this._renderCard(/* stale= */ true);
        } else {
          this._renderError(`Unable to load Rachio data: ${err.message}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _renderLoading() {
    this._content.innerHTML = `
      <div class="card-header">
        <h2 class="card-title">${escapeHtml(this._config.title)}</h2>
      </div>
      <div class="loading-message">Loading...</div>
    `;
  }

  _renderError(message) {
    this._content.innerHTML = `
      <div class="card-header">
        <h2 class="card-title">${escapeHtml(this._config.title)}</h2>
      </div>
      <div class="error-message">${escapeHtml(message)}</div>
    `;
  }

  /**
   * Render the full card content using cached device data.
   *
   * @param {boolean} stale - When true, shows a "(stale)" indicator to signal
   *   that the displayed data could not be refreshed from the API.
   */
  _renderCard(stale) {
    this._isStale = stale;
    const device = this._deviceData;
    const isOnline = device.online === true || device.status === 'ONLINE';
    const staleMark = stale
      ? '<span class="stale-indicator"> (stale)</span>'
      : '';

    let html = `
      <div class="card-header">
        <h2 class="card-title">${escapeHtml(this._config.title)}</h2>
        <div class="controller-info">
          <div class="status-dot ${isOnline ? 'online' : ''}"></div>
          <span>${escapeHtml(device.name || 'Controller')}</span>
          ${staleMark}
        </div>
      </div>
    `;

    // Build a zone ID -> name lookup used by the history section
    const zoneNameById = new Map(
      (device.zones || []).map(zone => [zone.id, zone.name || 'Zone'])
    );

    // Build once and share: both zones and schedules need last-watered data.
    const lastWateredByZoneId = this._buildLastWateredMap(device.zones || []);

    html += this._renderZonesSection(device, lastWateredByZoneId);
    html += this._renderSchedulesSection(device, lastWateredByZoneId);
    html += this._renderHistorySection(zoneNameById);

    this._content.innerHTML = html;

    // Attach toggle listener after innerHTML is set, since the element is recreated each render.
    const historyToggle = this._content.querySelector('.history-toggle');
    if (historyToggle) {
      historyToggle.addEventListener('click', () => {
        this._historyExpanded = !this._historyExpanded;
        this._renderCard(this._isStale);
      });
    }
  }

  /**
   * Build HTML for the Zones section.
   * Zones are sorted by zoneNumber. The currently running zone (from
   * current_schedule) gets a "Running" badge. Each zone shows its last
   * watered date, derived from the event history.
   *
   * @param {object} device - Rachio device object
   * @returns {string} HTML string
   */
  _renderZonesSection(device, lastWateredByZoneId) {
    const allZones = (device.zones || []).filter(zone => {
      // Optionally hide disabled zones based on config
      return this._config.show_disabled_zones || zone.enabled !== false;
    });

    // Sort by zone number (1-indexed position on the controller)
    allZones.sort((a, b) => (a.zoneNumber || 0) - (b.zoneNumber || 0));

    let html = '<div class="section-header">Zones</div>';

    if (allZones.length === 0) {
      return html + '<div class="no-data">No zones found.</div>';
    }

    // The zone currently being watered (null when controller is idle)
    const activeZoneId = this._currentSchedule ? this._currentSchedule.zoneId : null;

    allZones.forEach(zone => {
      const isRunning = zone.id === activeZoneId;
      const isDisabled = zone.enabled === false;
      const lastRun = lastWateredByZoneId.get(zone.id);

      // Build the "last run" columns: datetime and duration rendered as separate
      // flex items so they align independently across all zone rows.
      let lastRunHtml = '';
      if (lastRun && !isRunning) {
        const dateStr = formatDateTime(lastRun.timestamp, !this._config.use_24h);
        const durHtml = lastRun.duration
          ? `<span class="zone-duration">${escapeHtml(formatDuration(lastRun.duration))}</span>`
          : '';
        lastRunHtml = `<span class="zone-last-watered">${escapeHtml(dateStr)}</span>${durHtml}`;
      }

      // Play icon (triangle) for idle zones, stop icon (square) for the running zone.
      // Disabled zones get no button since the Rachio API will reject start requests for them.
      const toggleBtnHtml = !isDisabled ? `
        <button
          class="zone-toggle-btn${isRunning ? ' zone-toggle-stop' : ''}"
          title="${isRunning ? 'Stop zone' : 'Start zone'}"
          data-zone-id="${escapeHtml(zone.id)}"
          data-device-id="${escapeHtml(device.id)}"
          data-running="${isRunning}"
          aria-label="${isRunning ? 'Stop' : 'Start'} ${escapeHtml(zone.name || 'zone')}"
        >
          ${isRunning
            ? '<svg viewBox="0 0 10 10" width="11" height="11"><rect x="1.5" y="1.5" width="7" height="7" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 10 10" width="11" height="11"><polygon points="2,1 9,5 2,9" fill="currentColor"/></svg>'
          }
        </button>
      ` : '';

      html += `
        <div class="zone-row${isRunning ? ' zone-running' : ''}">
          <div class="zone-left">
            <span class="zone-number">${escapeHtml(zone.zoneNumber || '')}</span>
            <span class="zone-name${isDisabled ? ' disabled' : ''}">
              ${escapeHtml(zone.name || 'Zone')}
            </span>
          </div>
          <div class="zone-right">
            ${toggleBtnHtml}
            ${isRunning ? '<span class="badge badge-running">Running</span>' : ''}
            ${isDisabled ? '<span class="badge badge-disabled">Disabled</span>' : ''}
            ${lastRunHtml}
          </div>
        </div>
      `;
    });

    return html;
  }

  /**
   * Scan the event history to find the most recent completed watering for each zone.
   *
   * The Rachio event API does not include a zoneId field on ZONE_STATUS events.
   * The only zone identifier available is the zone name embedded at the start of
   * the event summary string (e.g., "Front Beds stopped watering at...").
   * We build a reverse lookup (zone name -> zone ID) from the device zone list and
   * match it against each event summary. Zone names are sorted longest-first so that
   * a name like "Front Beds" is matched before a shorter prefix like "Front".
   *
   * @param {Array} zones - Array of zone objects from the Rachio device record
   * @returns {Map<string, {timestamp: number, duration: number|null}>}
   *   Map of zone ID -> { timestamp in ms, duration in seconds (parsed from summary, or null) }
   */
  _buildLastWateredMap(zones) {
    // Build reverse lookup: zone name (lowercase) -> zone id.
    // Sort by name length descending so longer names are checked first,
    // preventing a short name from matching a summary that belongs to a longer-named zone.
    const zoneIdByName = zones
      .filter(zone => zone.name && zone.id)
      .sort((a, b) => b.name.length - a.name.length)
      .map(zone => [zone.name.toLowerCase(), zone.id]);

    const lastWatered = new Map();

    this._historyEvents.forEach(event => {
      if (event.type !== ZONE_EVENT_TYPE) return;
      if (!WATERING_COMPLETE_SUBTYPES.has(event.subType)) return;
      if (!event.summary || !event.eventDate) return;

      // Find which zone this event belongs to by checking if the summary starts
      // with a known zone name. Zone names are checked longest-first.
      const summaryLower = event.summary.toLowerCase();
      let matchedZoneId = null;
      for (const [name, zoneId] of zoneIdByName) {
        if (summaryLower.startsWith(name)) {
          matchedZoneId = zoneId;
          break;
        }
      }
      if (!matchedZoneId) return;

      const eventTimeMs = Number(event.eventDate);
      const existing = lastWatered.get(matchedZoneId);
      if (!existing || eventTimeMs > existing.timestamp) {
        lastWatered.set(matchedZoneId, {
          timestamp: eventTimeMs,
          duration: parseDurationFromSummary(event.summary)
        });
      }
    });

    return lastWatered;
  }

  /**
   * Start or stop a zone via the Rachio API.
   *
   * Starting sends PUT /public/zone/start with a fixed run duration.
   * Stopping sends PUT /public/device/stop_water (stops all zones on the device;
   * only one zone can run at a time so this effectively stops the running zone).
   *
   * The clicked button is disabled while the request is in flight to prevent
   * double-taps. On success, _loadData() is called to refresh the card state.
   * On failure, the button is re-enabled and the error is logged to the console.
   *
   * @param {string} zoneId   - Rachio zone ID to start (ignored when stopping)
   * @param {string} deviceId - Rachio device ID (used for stop_water endpoint)
   * @param {boolean} isRunning - True if the zone is currently running (stop); false to start
   */
  async _toggleZone(zoneId, deviceId, isRunning) {
    // Disable the button immediately to prevent double-taps while the request is in flight.
    const btn = this._content.querySelector(`.zone-toggle-btn[data-zone-id="${zoneId}"]`);
    if (btn) btn.disabled = true;

    try {
      if (isRunning) {
        await rachioPut(this._config.api_key, '/public/device/stop_water', { id: deviceId });
      } else {
        await rachioPut(this._config.api_key, '/public/zone/start', {
          id: zoneId,
          duration: this._config.default_run_minutes * 60
        });
      }
    } catch (err) {
      console.error('Rachio Card: Zone toggle failed:', err);
      // Re-enable the button so the user can retry.
      if (btn) btn.disabled = false;
      return;
    }

    // The Rachio controller takes a few seconds to start the zone before the
    // current_schedule endpoint reflects the running state. Wait before refreshing.
    setTimeout(() => this._loadData(), 10000);
  }

  /**
   * Build HTML for the Schedules section.
   * Combines fixed (scheduleRules) and flex (flexScheduleRules) into one list.
   * Shows schedule name, type badge (Fixed/Smart), and total duration.
   *
   * @param {object} device - Rachio device object
   * @returns {string} HTML string
   */
  _renderSchedulesSection(device, lastWateredByZoneId) {
    // Merge fixed and flex schedules into one list with a type tag
    const fixedSchedules = (device.scheduleRules || []).map(s => ({ ...s, _type: 'FIXED' }));
    const flexSchedules = (device.flexScheduleRules || []).map(s => ({ ...s, _type: 'FLEX' }));

    const allSchedules = [...fixedSchedules, ...flexSchedules].filter(schedule => {
      return this._config.show_disabled_schedules || schedule.enabled !== false;
    });

    let html = '<div class="section-header">Schedules</div>';

    if (allSchedules.length === 0) {
      return html + '<div class="no-data">No schedules configured.</div>';
    }

    allSchedules.forEach(schedule => {
      const isDisabled = schedule.enabled === false;
      const isFlex = schedule._type === 'FLEX';
      const typeLabel = isFlex ? 'Smart' : 'Fixed';
      const typeBadgeClass = isFlex ? 'badge-flex' : 'badge-fixed';

      // totalDuration is in seconds for fixed schedules
      const duration = schedule.totalDuration
        ? formatDuration(schedule.totalDuration)
        : null;

      // Derive last actual run time from the most recent zone-complete event
      // across all zones belonging to this schedule. Rachio's startDate is the
      // original creation anchor and does not update when runs are delayed
      // (e.g. rain hold), so using zone history avoids drift.
      const scheduleZones = schedule.zones || [];
      let scheduleLastRunMs = null;
      for (const zoneEntry of scheduleZones) {
        const zoneId = zoneEntry.zoneId || zoneEntry.id;
        if (!zoneId) continue;
        const record = lastWateredByZoneId.get(zoneId);
        if (record && record.timestamp) {
          if (!scheduleLastRunMs || record.timestamp > scheduleLastRunMs) {
            scheduleLastRunMs = record.timestamp;
          }
        }
      }

      const nextRunMs = computeNextRunDate(schedule, scheduleLastRunMs);
      const nextRunLabel = nextRunMs ? `Next Scheduled Run: ${formatShortDate(nextRunMs)}` : null;

      const metaParts = [duration, nextRunLabel].filter(Boolean);

      html += `
        <div class="schedule-row">
          <div class="schedule-left">
            <span class="schedule-name${isDisabled ? ' disabled' : ''}">
              ${escapeHtml(schedule.name || 'Schedule')}
            </span>
            ${metaParts.length > 0
              ? `<span class="schedule-meta">${escapeHtml(metaParts.join(' - '))}</span>`
              : ''}
          </div>
          <div class="schedule-right">
            <span class="${typeBadgeClass}">${escapeHtml(typeLabel)}</span>
          </div>
        </div>
      `;
    });

    return html;
  }

  /**
   * Build HTML for the History section.
   * Shows ZONE_COMPLETED and ZONE_STOPPED events sorted newest first,
   * capped at MAX_HISTORY_EVENTS entries.
   *
   * Zone names are resolved from zoneNameById since some events may not
   * include a zoneName field.
   *
   * @param {Map<string, string>} zoneNameById - Map of zoneId -> zone name
   * @returns {string} HTML string
   */
  _renderHistorySection(zoneNameById) {
    const wateringEvents = this._historyEvents
      .filter(event =>
        event.topic === WATERING_TOPIC &&
        WATERING_COMPLETE_SUBTYPES.has(event.subType)
      )
      .sort((a, b) => new Date(b.eventDate) - new Date(a.eventDate))
      .slice(0, MAX_HISTORY_EVENTS);

    const chevron = this._historyExpanded ? '&#9650;' : '&#9660;';
    let html = `
      <div class="section-header section-header-toggle history-toggle">
        <span>History (last ${escapeHtml(this._config.history_days)} days)</span>
        <span class="toggle-chevron">${chevron}</span>
      </div>
    `;

    if (!this._historyExpanded) return html;

    if (wateringEvents.length === 0) {
      return html + '<div class="no-data">No watering events in this period.</div>';
    }

    wateringEvents.forEach(event => {
      // Use the API-provided summary string as the primary display text.
      // It is already human-readable (e.g., "Front Yard watered for 10 minutes").
      const summary = event.summary || 'Watering event';
      const eventTimeMs = event.eventDate ? Number(event.eventDate) : null;

      html += `
        <div class="history-row">
          <div class="history-left">
            <span class="history-zone-name">${escapeHtml(summary)}</span>
            <span class="history-meta">${escapeHtml(formatDateTime(eventTimeMs, !this._config.use_24h))}</span>
          </div>
        </div>
      `;
    });

    return html;
  }

  // ---------------------------------------------------------------------------
  // HA Lovelace interface
  // ---------------------------------------------------------------------------

  /**
   * Estimate card height in grid rows.
   * HA uses this for initial layout sizing.
   */
  getCardSize() {
    const zoneCount = this._deviceData ? (this._deviceData.zones || []).length : 0;
    // Base size 3 rows + roughly 1 row per 2 zones, capped at 12
    return Math.min(12, 3 + Math.floor(zoneCount / 2));
  }

  /** Grid options for the HA sections (grid) view layout. */
  getGridOptions() {
    return {
      rows: 5,
      columns: 12,
      min_rows: 3,
      min_columns: 6
    };
  }

  /** Return the editor element so HA shows the visual config editor. */
  static getConfigElement() {
    return document.createElement('rachio-card-editor');
  }

  /** Stub config shown when the card is added via the UI picker. */
  static getStubConfig() {
    return {
      api_key: '',
      title: 'Rachio Irrigation'
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

customElements.define('rachio-card', RachioCard);

console.info(
  '%c RACHIO-CARD %c v1.1.2 ',
  'color: black; background: #F2720C; font-weight: 600;',
  'color: black; background: #00a5c9; font-weight: 600;'
);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'rachio-card',
  name: 'Rachio Card',
  description: 'Displays Rachio irrigation zone status, schedules, and watering history',
  preview: true,
  documentationURL: 'https://github.com/sxdjt/ha-rachio-card'
});
