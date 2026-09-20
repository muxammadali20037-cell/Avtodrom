/* Small, dependency-free helpers shared by the real customer and staff panels. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const settingValue = value => value != null && typeof value === 'object' && 'value' in value ? value.value : value;
  function csvCell(value) {
    let text = String(value ?? '');
    // Spreadsheet formulas must never execute when an operator opens an export.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function csvText(rows) {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    return '\ufeff' + [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => csvCell(row[key])).join(','))].join('\r\n');
  }
  function slotState({ start, end, busy = [], now = Date.now(), closed = false, loading = false, error = false }) {
    if (loading || error) return 'unavailable';
    start = Number(start); end = Number(end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || closed || start < now) return 'gone';
    if (!Array.isArray(busy) || busy.some(row => !Number.isFinite(Date.parse(row.start_at)) || !Number.isFinite(Date.parse(row.end_at)) || Date.parse(row.end_at) <= Date.parse(row.start_at))) return 'unavailable';
    return busy.some(row => new Date(row.start_at).getTime() < end && new Date(row.end_at).getTime() > start) ? 'busy' : 'free';
  }
  function latestOnly() {
    let sequence = 0;
    return () => { const own = ++sequence; return () => sequence === own; };
  }
  root.AvtodromCore = Object.freeze({ escape, settingValue, csvCell, csvText, slotState, latestOnly });
})(globalThis);
