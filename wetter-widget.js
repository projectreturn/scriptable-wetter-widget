// RegenWidget 3.0 — mittleres, schwarzes Scriptable-Widget.
// Daten: DWD-RV, Stationsmessungen und amtliche Gebietswarnungen via Bright Sky.
// Niederschlagsart und lokales Glätterisiko sind Näherungen; im Widget werden
// bewusst keine Datenanbieter eingeblendet.
// Einmal in Scriptable starten und Standort erlauben. Komplett ersetzen.
const SETTINGS = {
  apiBase: "https://api.brightsky.dev",
  minutes: [5, 10, 15, 30],
  rainThreshold: 2, // 0,02 mm/5 Minuten; darunter "trocken"
  radarMaxAge: 20, // Minuten seit DWD-Modelllauf, nicht seit Download
  weatherMaxAge: 90,
  forecastMaxAge: 360,
  alertsMaxAge: 30,
};
const MIN = 60000;
const COLORS = { text: "F5F5F7", muted: "98989F", dry: "98989F",
  wet: "5EB4FF", snow: "FFFFFF", warning: "FFAD45", unknown: "98989F" };

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readCache(name) {
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.documentsDirectory(), "wetter-v2-" + name + ".json");
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (_) { return null; }
}
function saveCache(name, value) {
  try {
    const fm = FileManager.local();
    fm.writeString(fm.joinPath(fm.documentsDirectory(), "wetter-v2-" + name + ".json"),
      JSON.stringify(value));
  } catch (_) {}
}
function distance(a, b) {
  if (!a || !b) return Infinity;
  const rad = Math.PI / 180;
  const x = Math.sin((a.latitude - b.latitude) * rad / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) *
    Math.sin((a.longitude - b.longitude) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, x)));
}
function coordinates(loc) {
  return loc.latitude.toFixed(3) + ", " + loc.longitude.toFixed(3);
}
async function locate() {
  const saved = readCache("location");
  let loc;
  try {
    Location.setAccuracyToHundredMeters();
    const current = await Location.current();
    loc = { latitude: current.latitude, longitude: current.longitude, at: Date.now() };
  } catch (_) {
    if (!saved || Date.now() - saved.at > 60 * MIN)
      throw new Error("Standort fehlt. Script in Scriptable öffnen und Standort erlauben.");
    return Object.assign({}, saved, { cached: true });
  }
  if (saved && saved.name && distance(loc, saved) < 500) loc.name = saved.name;
  if (!loc.name) {
    try {
      const places = await Location.reverseGeocode(loc.latitude, loc.longitude, "de");
      const place = places[0] || {};
      loc.name = place.locality || place.subLocality || place.administrativeArea;
    } catch (_) {}
  }
  saveCache("location", loc);
  return loc;
}
async function fetchJSON(path, loc, query, maxAge) {
  const key = path;
  const saved = readCache(key);
  try {
    const req = new Request(SETTINGS.apiBase + "/" + path +
      "?lat=" + encodeURIComponent(loc.latitude) + "&lon=" + encodeURIComponent(loc.longitude) + query);
    req.headers = { "Accept-Encoding": "gzip", "User-Agent": "Scriptable-RegenWidget/3.1" };
    req.timeoutInterval = 12;
    const json = await req.loadJSON();
    if (req.response && req.response.statusCode >= 400) throw new Error("HTTP");
    if ((path === "radar" && !Array.isArray(json.radar)) ||
        (path === "current_weather" && !json.weather) ||
        (path === "weather" && !Array.isArray(json.weather)) ||
        (path === "alerts" && !Array.isArray(json.alerts))) throw new Error("Antwort fehlt");
    saveCache(key, { loc: loc, at: Date.now(), json: json });
    return { json: json, cached: false };
  } catch (_) {
    if (saved && Date.now() - saved.at < maxAge * MIN && distance(loc, saved.loc) < 500)
      return { json: saved.json, cached: true };
    return { json: null, cached: false };
  }
}
function weatherData(payload, now) {
  const w = payload.json && payload.json.weather;
  if (!w) return null;
  const at = Date.parse(w.timestamp);
  if (!Number.isFinite(at) || now - at > SETTINGS.weatherMaxAge * MIN || at > now + 5 * MIN) return null;
  const fallback = w.fallback_source_ids || {};
  const stationId = fallback.temperature != null ? fallback.temperature : w.source_id;
  const source = (payload.json.sources || []).find(s => String(s.id) === String(stationId)) ||
    (payload.json.sources || []).find(s => String(s.id) === String(w.source_id)) || null;
  return { at: at, temperature: number(w.temperature), humidity: number(w.relative_humidity),
    wind: number(w.wind_speed_10), direction: number(w.wind_direction_10), gust: number(w.wind_gust_speed_10),
    recent: number(w.precipitation_60), icon: w.icon, condition: w.condition,
    station: source && source.station_name || null,
    stationDistance: source && number(source.distance),
    cached: payload.cached };
}
function dayData(payload, now, daysAhead) {
  const raw = payload.json && payload.json.weather || [];
  const target = new Date(now);
  target.setDate(target.getDate() + daysAhead);
  const rows = raw.filter(function (row) {
    const d = new Date(row.timestamp);
    return Number.isFinite(d.getTime()) && d.getFullYear() === target.getFullYear() &&
      d.getMonth() === target.getMonth() && d.getDate() === target.getDate();
  });
  if (!rows.length) return null;
  const temperatures = rows.map(r => number(r.temperature)).filter(v => v != null);
  const noon = new Date(target); noon.setHours(13, 0, 0, 0);
  const representative = rows.reduce((best, row) =>
    Math.abs(Date.parse(row.timestamp) - noon.getTime()) < Math.abs(Date.parse(best.timestamp) - noon.getTime())
      ? row : best, rows[0]);
  return { low: temperatures.length ? Math.min(...temperatures) : null,
    high: temperatures.length ? Math.max(...temperatures) : null,
    icon: representative.icon, condition: representative.condition, cached: payload.cached };
}
function tomorrowData(payload, now) { return dayData(payload, now, 1); }
function alertData(payload, now) {
  const json = payload.json || {};
  const pattern = /gl[aä]tte|glatteis|vereisung|überfrier/i;
  const warnings = (json.alerts || []).filter(function (a) {
    const words = [a.event, a.event_de, a.headline, a.headline_de].filter(Boolean).join(" ");
    const state = String(a.alert_msg_type || a.msg_type || a.msgType || a.alert_status || a.status || "");
    const from = Date.parse(a.alert_onset || a.onset || a.alert_effective || a.effective || a.alert_sent || a.sent || "");
    const until = Date.parse(a.alert_expires || a.expires || a.ends || "");
    return pattern.test(words) && !/cancel|expire|test/i.test(state) &&
      (!Number.isFinite(from) || from <= now + 30 * MIN) && (!Number.isFinite(until) || until > now);
  }).map(function (a) {
    return { title: a.headline_de || a.headline || a.event_de || a.event || "Amtliche Glättewarnung",
      from: Date.parse(a.alert_onset || a.onset || a.alert_effective || a.effective || ""),
      until: Date.parse(a.alert_expires || a.expires || a.ends || ""),
      description: a.description_de || a.description || "", instruction: a.instruction_de || a.instruction || "" };
  });
  return { warnings: warnings, area: json.location && (json.location.name_short || json.location.name) || null,
    available: !!payload.json, cached: payload.cached };
}
function radarData(payload, now) {
  const raw = payload.json && payload.json.radar;
  if (!raw) return { frames: [], run: null, cached: payload.cached };
  const frames = raw.map(function (f) {
    const match = String(f.source || "").match(/::(\d{4}-\d{2}-\d{2}T.*)$/);
    const grid = f.precipitation_5;
    const v = number(grid && grid[0] && grid[0][0]);
    return { at: Date.parse(f.timestamp), run: match ? Date.parse(match[1]) : NaN,
      value: v != null && v >= 0 ? v : null };
  }).filter(f => Number.isFinite(f.at)).sort((a, b) => a.at - b.at);
  // Each forecast frame carries the measurement/model-run timestamp.
  const valid = frames.filter(f => Number.isFinite(f.run) &&
    now - f.run <= SETTINGS.radarMaxAge * MIN && f.run <= now + 5 * MIN);
  return { frames: valid, run: valid.length ? Math.max(...valid.map(f => f.run)) : null,
    cached: payload.cached };
}
function frameAt(frames, at) {
  // Choose the 5-minute accumulation window containing this time.
  return frames.find(f => f.at >= at && f.at - at < 5 * MIN) || null;
}
function wet(f) { return !!f && f.value != null && f.value >= SETTINGS.rainThreshold; }
function strength(f) {
  if (!f || f.value == null) return "keine Daten";
  const rate = f.value * 0.12;
  return !wet(f) ? "" : rate < 2.5 ? "leicht" : rate < 10 ? "mäßig" : "stark";
}
function type(f, w) {
  if (!f || f.value == null) return { name: "Unbekannt", symbol: "questionmark", color: COLORS.unknown };
  if (!wet(f)) return { name: "Trocken", symbol: "minus", color: COLORS.dry };
  // No vertical temperature profile is available; the phase remains an estimate.
  const t = w && w.temperature;
  if (!w || t == null) return { name: "Niederschl.", symbol: "cloud.drizzle.fill", color: COLORS.wet };
  if ((w.condition === "snow" || w.icon === "snow") && t <= 3 || t <= 0)
    return { name: "Schnee", symbol: "snowflake", color: COLORS.snow };
  if (w.condition === "sleet" || w.icon === "sleet" || t <= 2)
    return { name: "Regen/Schnee", symbol: "cloud.sleet.fill", color: COLORS.snow };
  return { name: "Regen", symbol: "cloud.rain.fill", color: COLORS.wet };
}
function iceRisk(w, moisture) {
  // Heuristic only: no street-surface temperature or road sensor.
  if (!w || w.temperature == null) return false;
  return w.temperature <= 3 && (moisture || w.recent > 0.1 ||
    (w.temperature <= 0 && w.humidity != null && w.humidity >= 90));
}
function clock(at) {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function windLabel(w, compact) {
  if (!w || w.wind == null) return compact ? "—" : "Wind —";
  if (w.wind < 1) return compact ? "still" : "Windstill";
  const compass = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  const d = number(w.direction);
  const from = d != null && d >= 0 && d <= 360
    ? " aus " + compass[Math.round(d / 45) % 8] : "";
  const speed = Math.round(w.wind) + " km/h" +
    (w.gust >= 40 ? " · Böen " + Math.round(w.gust) : "");
  return compact ? (from ? from.trim() + " · " : "") + speed : "Wind" + from + " · " + speed;
}
function currentLabel(w, current) {
  if (wet(current)) return type(current, w).name + " · " + strength(current);
  if (!w) return current && current.value != null ? "Jetzt trocken" : "Wetterdaten fehlen";
  // A dry radar pixel does not imply sunshine.
  return weatherLabel(w.icon, w.condition, true);
}
function weatherLabel(icon, condition, station) {
  const labels = { "clear-day": "Sonnig", "clear-night": "Klar", "partly-cloudy-day": "Wolkig",
    "partly-cloudy-night": "Wolkig", cloudy: "Bedeckt", fog: "Nebel", wind: "Windig",
    thunderstorm: "Gewitter", rain: "Regen", sleet: "Regen/Schnee", snow: "Schnee", hail: "Hagel" };
  const label = labels[icon] || (condition === "dry" ? "Trocken" : "Wetter unklar");
  return station && /^(Regen|Regen\/Schnee|Schnee)$/.test(label) ? label + " (Station)" : label;
}
function eventText(frames, w, now) {
  const current = frameAt(frames, now);
  const timeline = [];
  for (let n = 0; n <= 120; n += 5) {
    const f = frameAt(frames, now + n * MIN);
    if (!f || f.value == null) break;
    timeline.push(f);
  }
  if (!timeline.length) return "Niederschlagsprognose fehlt";
  const start = timeline.findIndex(wet);
  if (start < 0) return timeline[timeline.length - 1].at >= now + 30 * MIN
    ? "Nächste 30 Min voraussichtlich trocken"
    : "Prognose nur bis " + clock(timeline[timeline.length - 1].at);
  const first = timeline[start];
  const name = type(first, w).name;
  let end = null;
  // Require two dry frames to avoid declaring the end during a tiny gap.
  for (let i = start + 1; i + 1 < timeline.length; i++) {
    if (!wet(timeline[i]) && !wet(timeline[i + 1])) {
      end = timeline[i].at - 5 * MIN;
      break;
    }
  }
  const last = timeline[timeline.length - 1].at;
  let sentence;
  if (wet(current)) {
    sentence = name + (end ? " bis ca. " + clock(end) : " mindestens bis " + clock(last));
    const stronger = timeline.find(f => f.at <= now + 30 * MIN && wet(f) &&
      strength(f) !== strength(current) && f.value > current.value);
    if (stronger) sentence += " · zunehmend";
  } else {
    sentence = name + " ab ca. " + clock(first.at - 5 * MIN) +
      (end ? " bis " + clock(end) : " · Ende offen");
  }
  return sentence;
}
function durationLine(summary) {
  let match = summary.match(/mindestens bis (\d{2}:\d{2})/);
  if (match) return "Mind. bis " + match[1];
  match = summary.match(/bis(?: ca\.)? (\d{2}:\d{2})(?:$|\s)/);
  if (match) return "Bis ca. " + match[1];
  return /Ende offen/.test(summary) ? "Ende noch offen" : "";
}
function changeText(frames, w, now, officialIce) {
  if (officialIce === true || officialIce && officialIce.now)
    return { text: "Amtliche Glättewarnung aktiv", color: COLORS.warning, important: true };
  if (officialIce && officialIce.soon)
    return { text: "Glättewarnung ab " + clock(officialIce.soon.from), color: COLORS.warning, important: true };
  const current = frameAt(frames, now);
  const timeline = [];
  for (let n = 0; n <= 120; n += 5) {
    const f = frameAt(frames, now + n * MIN);
    if (!f || f.value == null) break;
    timeline.push(f);
  }
  if (!timeline.length) return { text: "Prognose derzeit nicht verfügbar", color: COLORS.muted, important: false };
  const firstWet = timeline.findIndex(wet);
  if (!wet(current)) {
    if (firstWet >= 0 && timeline[firstWet].at <= now + 35 * MIN) {
      const mins = Math.max(0, Math.round((timeline[firstWet].at - 5 * MIN - now) / MIN / 5) * 5);
      return { text: type(timeline[firstWet], w).name + " beginnt in ca. " + mins + " Min",
        color: type(timeline[firstWet], w).color, important: true };
    }
    return { text: "Bleibt voraussichtlich\ntrocken", color: COLORS.muted, important: false };
  }
  const stronger = timeline.find(f => f.at <= now + 30 * MIN && wet(f) && f.value > current.value * 1.8 &&
    strength(f) !== strength(current));
  if (stronger) return { text: "Wird in ca. " + Math.max(5,
    Math.round((stronger.at - now) / MIN / 5) * 5) + " Min stärker", color: type(stronger, w).color, important: true };
  for (let i = 1; i + 1 < timeline.length; i++) {
    if (!wet(timeline[i]) && !wet(timeline[i + 1])) {
      const end = timeline[i].at - 5 * MIN;
      if (end <= now + 30 * MIN)
        return { text: "Lässt gegen " + clock(end) + " nach", color: type(current, w).color, important: true };
      break;
    }
  }
  return { text: eventText(frames, w, now), color: COLORS.muted, important: false };
}
function model(radar, w, alerts, now) {
  // Backwards-compatible call form used by older copies of the local tests.
  if (typeof alerts === "number") { now = alerts; alerts = null; }
  const warnings = alerts && alerts.warnings || [];
  const activeAt = function (warning, at) {
    return (!Number.isFinite(warning.from) || warning.from <= at) &&
      (!Number.isFinite(warning.until) || warning.until > at);
  };
  const warningNow = warnings.find(a => activeAt(a, now)) || null;
  const warningSoon = warnings.find(a => Number.isFinite(a.from) && a.from > now && a.from <= now + 30 * MIN) || null;
  const current = frameAt(radar.frames, now);
  const checks = SETTINGS.minutes.map(minutes => {
    const at = now + minutes * MIN;
    const f = frameAt(radar.frames, at);
    const moisture = radar.frames.some(p => p.at >= now - 5 * MIN && p.at <= at && wet(p));
    const officialIce = warnings.some(a => activeAt(a, at));
    return { minutes: minutes, at: at, type: type(f, w), strength: strength(f),
      ice: officialIce || iceRisk(w, moisture), officialIce: officialIce, frame: f };
  });
  const summary = eventText(radar.frames, w, now);
  return { current: current, checks: checks, label: currentLabel(w, current),
    summary: summary, duration: durationLine(summary),
    change: changeText(radar.frames, w, now, { now: warningNow, soon: warningSoon }),
    officialIce: !!(warningNow || warningSoon), ice: checks.some(c => c.ice) || iceRisk(w, wet(current)) };
}

function text(parent, value, size, color, bold, lines) {
  const t = parent.addText(value);
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = new Color(color || COLORS.text);
  t.lineLimit = lines || 1;
  t.minimumScaleFactor = 0.8;
  return t;
}
function centered(parent, value, size, color, bold) {
  const row = parent.addStack();
  row.addSpacer();
  const label = text(row, value, size, color, bold);
  label.minimumScaleFactor = 0.65;
  row.addSpacer();
}
function centeredIcon(parent, name, color) {
  const row = parent.addStack();
  row.addSpacer();
  const sf = SFSymbol.named(name) || SFSymbol.named("questionmark");
  const im = row.addImage(sf.image);
  im.imageSize = new Size(19, 19);
  im.tintColor = new Color(color);
  row.addSpacer();
}
function currentSymbol(w, current) {
  if (wet(current)) return type(current, w).symbol;
  return weatherSymbol(w && w.icon);
}
function weatherSymbol(icon) {
  const symbols = {
    "clear-day": "sun.max.fill", "clear-night": "moon.stars.fill",
    "partly-cloudy-day": "cloud.sun.fill", "partly-cloudy-night": "cloud.moon.fill",
    cloudy: "cloud.fill", fog: "cloud.fog.fill", wind: "wind",
    thunderstorm: "cloud.bolt.rain.fill", rain: "cloud.rain.fill",
    sleet: "cloud.sleet.fill", snow: "snowflake"
  };
  return symbols[icon] || "questionmark.circle";
}
function detailsURL() {
  const base = URLScheme.forRunningScript();
  return base + (base.includes("?") ? "&" : "?") + "details=1";
}
function dailyBlock(parent, title, forecast) {
  const block = parent.addStack();
  block.layoutVertically();
  block.size = new Size(82, 0);
  text(block, title, 10, COLORS.muted, true);
  block.addSpacer(2);
  const values = block.addStack();
  values.centerAlignContent();
  const sf = SFSymbol.named(weatherSymbol(forecast && forecast.icon)) || SFSymbol.named("questionmark.circle");
  const image = values.addImage(sf.image);
  image.imageSize = new Size(20, 20);
  image.tintColor = new Color(COLORS.text);
  values.addSpacer(5);
  const temperatures = forecast && forecast.low != null && forecast.high != null
    ? Math.round(forecast.low) + "–" + Math.round(forecast.high) + "°" : "—°";
  text(values, temperatures, 13, COLORS.text, true);
  block.addSpacer(2);
  const label = text(block, forecast ? weatherLabel(forecast.icon, forecast.condition, false) : "Keine Daten",
    10, COLORS.muted, false);
  label.minimumScaleFactor = 0.65;
}
function buildWidget(loc, w, tomorrow, dayAfter, radar, m, now) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.black();
  // Optische Zentrierung: Die große linke Aktuell-Spalte wirkt schwerer.
  widget.setPadding(20, 16, 16, 16);
  widget.url = detailsURL();
  widget.refreshAfterDate = new Date(now + 5 * MIN);
  const outer = widget.addStack();
  outer.addSpacer();
  const body = outer.addStack();
  outer.addSpacer();
  const left = body.addStack();
  left.layoutVertically();
  left.size = new Size(101, 0);
  text(left, loc.cached ? "LETZTER ORT" : "JETZT", 10, COLORS.muted, true);
  left.addSpacer(2);
  text(left, loc.name || coordinates(loc), 14, null, true);
  left.addSpacer(3);
  const conditions = left.addStack();
  conditions.centerAlignContent();
  const currentSF = SFSymbol.named(currentSymbol(w, m.current)) || SFSymbol.named("questionmark.circle");
  const currentImage = conditions.addImage(currentSF.image);
  currentImage.imageSize = new Size(28, 28);
  currentImage.tintColor = new Color(COLORS.text);
  conditions.addSpacer(6);
  text(conditions, w && w.temperature != null ? w.temperature.toFixed(1).replace(".", ",") + "°" : "—°",
    28, null, true);
  text(left, m.label, 12, COLORS.text, false, 1);
  left.addSpacer(3);
  const wind = left.addStack();
  wind.centerAlignContent();
  const windSF = SFSymbol.named("wind") || SFSymbol.named("arrow.right");
  const windImage = wind.addImage(windSF.image);
  windImage.imageSize = new Size(12, 12);
  windImage.tintColor = new Color(COLORS.muted);
  wind.addSpacer(4);
  text(wind, windLabel(w, true), 10, COLORS.muted, false, 1);
  body.addSpacer(8);
  const middle = body.addStack();
  middle.layoutVertically();
  middle.size = new Size(82, 0);
  dailyBlock(middle, "MORGEN", tomorrow);
  middle.addSpacer(8);
  dailyBlock(middle, "ÜBERMORGEN", dayAfter);
  body.addSpacer(8);
  const right = body.addStack();
  right.layoutVertically();
  right.size = new Size(105, 0);
  m.checks.forEach((c, i) => {
    const row = right.addStack();
    row.centerAlignContent();
    const time = row.addStack();
    time.size = new Size(26, 0);
    text(time, "+" + c.minutes, 11, COLORS.muted, true);
    const shown = c.ice
      ? { name: "Glätte", symbol: "exclamationmark.triangle.fill", color: COLORS.warning }
      : c.type;
    if (shown.name === "Trocken") {
      row.addSpacer(12);
    } else {
      const sf = SFSymbol.named(shown.symbol) || SFSymbol.named("questionmark");
      const icon = row.addImage(sf.image);
      icon.imageSize = new Size(12, 12);
      icon.tintColor = new Color(shown.color);
    }
    row.addSpacer(3);
    const extra = shown.name === "Regen/Schnee" || c.ice ? "" : c.strength;
    const label = text(row, shown.name + (extra && extra !== "keine Daten" ? " · " + extra : ""),
      10, shown.color, true);
    label.minimumScaleFactor = 0.65;
    if (i < 3) right.addSpacer(4);
  });
  right.addSpacer(7);
  const changeLines = m.change.text.split("\n");
  if (changeLines.length === 2) {
    text(right, changeLines[0], 10, m.change.color, m.change.important, 1);
    text(right, changeLines[1], 10, m.change.color, m.change.important, 1);
  } else {
    text(right, m.change.text, 11, m.change.color, m.change.important, 2);
  }
  if (m.change.important && m.duration && !m.change.text.startsWith("Lässt")) {
    right.addSpacer(1);
    text(right, m.duration, 10, COLORS.muted, false, 1);
  }
  widget.addSpacer();
  const bottom = widget.addStack();
  bottom.size = new Size(0, 12);
  bottom.centerAlignContent();
  bottom.addSpacer();
  const dataAt = radar.run != null ? radar.run : w && w.at;
  const status = dataAt == null ? "Stand unbekannt" : "Stand " + clock(dataAt);
  const statusText = text(bottom, status + (radar.cached || w && w.cached || tomorrow && tomorrow.cached || dayAfter && dayAfter.cached
    ? " · gespeichert" : ""), 9, COLORS.muted);
  statusText.centerAlignText();
  bottom.addSpacer();
  return widget;
}
function tableRow(table, title, subtitle, height, header) {
  const row = new UITableRow();
  row.height = height || (subtitle ? 58 : 44);
  row.isHeader = !!header;
  row.addText(title, subtitle || "");
  table.addRow(row);
  return row;
}
async function showDetails(loc, w, radar, alerts, m, now) {
  const table = new UITable();
  table.showSeparators = true;
  tableRow(table, loc.name || coordinates(loc), "Wetterdetails · Stand " + clock(now), 52, true);
  const temp = w && w.temperature != null ? w.temperature.toFixed(1).replace(".", ",") + " °C" : "nicht verfügbar";
  const station = w && w.station ? w.station + (w.stationDistance != null
    ? " · ca. " + Math.round(w.stationDistance / 1000) + " km entfernt" : "") : "Station nicht angegeben";
  tableRow(table, "Aktuell: " + temp, "Messzeit " + (w ? clock(w.at) : "—") + " · " + station, 62);
  tableRow(table, m.label, windLabel(w), 58);
  tableRow(table, "Niederschlagsverlauf", m.summary, 58, true);
  radar.frames.filter(f => f.at >= now && f.at <= now + 120 * MIN && f.value != null).forEach(function (f) {
    const phase = type(f, w);
    const amount = wet(f) ? strength(f) + " · " + (f.value / 100).toFixed(2).replace(".", ",") + " mm/5 Min" : "trocken";
    tableRow(table, clock(f.at - 5 * MIN) + "–" + clock(f.at), phase.name + (phase.name === "Regen/Schnee" ? "" : " · " + amount), 48);
  });
  tableRow(table, "Glätterisiko", "Orange bedeutet: amtliche Gebietswarnung oder lokale Schätzung aus Temperatur und Nässe.", 68, true);
  if (alerts.warnings.length) {
    alerts.warnings.forEach(function (a) {
      const times = (Number.isFinite(a.from) ? "ab " + clock(a.from) : "aktiv") +
        (Number.isFinite(a.until) ? " bis " + clock(a.until) : "");
      tableRow(table, a.title, times + " · Gilt für " + (alerts.area || "das Warngebiet") +
        ", nicht als Bestätigung für eine konkrete Straße.", 82);
    });
  } else if (alerts.available) {
    tableRow(table, "Keine aktive amtliche Glättewarnung", "Die eigene Schätzung kann trotzdem orange erscheinen. Sie kennt keine Straßenoberflächentemperatur.", 76);
  } else {
    tableRow(table, "Amtliche Warnungen nicht verfügbar", "Es wird nur die lokale Glätteschätzung angezeigt. Bitte später erneut versuchen.", 68);
  }
  tableRow(table, "So wird die lokale Schätzung gebildet",
    "Lufttemperatur bis 3 °C zusammen mit Niederschlag oder kürzlicher Nässe; bei Frost zusätzlich hohe Luftfeuchte. Kein orangefarbener Hinweis bedeutet nicht sicher eisfrei.", 94);
  await table.present(false);
}
function errorWidget(error) {
  const w = new ListWidget();
  w.backgroundColor = Color.black();
  w.setPadding(15, 15, 15, 15);
  text(w, "Wetter", 18, null, true);
  w.addSpacer(8);
  text(w, String(error.message || error), 12, COLORS.warning, false, 4);
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + 5 * MIN);
  return w;
}
async function runWidget() {
  let widget;
  try {
    const loc = await locate();
    const now = Date.now();
    // Explicit window: past hour for wetness, full next two hours for end.
    const range = "&distance=0&format=plain&date=" + encodeURIComponent(new Date(now - 60 * MIN).toISOString()) +
      "&last_date=" + encodeURIComponent(new Date(now + 120 * MIN).toISOString());
    const tomorrowStart = new Date(now);
    tomorrowStart.setHours(0, 0, 0, 0);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setMinutes(tomorrowEnd.getMinutes() - 1);
    const tomorrowRange = "&date=" + encodeURIComponent(tomorrowStart.toISOString()) +
      "&last_date=" + encodeURIComponent(tomorrowEnd.toISOString());
    const values = await Promise.all([fetchJSON("radar", loc, range, 20),
      fetchJSON("current_weather", loc, "", 30),
      fetchJSON("alerts", loc, "", SETTINGS.alertsMaxAge),
      fetchJSON("weather", loc, tomorrowRange, SETTINGS.forecastMaxAge)]);
    const at = Date.now();
    const radar = radarData(values[0], at);
    const weather = weatherData(values[1], at);
    const alerts = alertData(values[2], at);
    const tomorrow = tomorrowData(values[3], at);
    const dayAfter = dayData(values[3], at, 2);
    const data = model(radar, weather, alerts, at);
    const view = typeof args !== "undefined" && args.queryParameters && args.queryParameters.details;
    if (!config.runsInWidget && view === "1") {
      await showDetails(loc, weather, radar, alerts, data, at);
      Script.complete();
      return;
    }
    widget = buildWidget(loc, weather, tomorrow, dayAfter, radar, data, at);
  } catch (error) { widget = errorWidget(error); }
  Script.setWidget(widget);
  if (!config.runsInWidget) await widget.presentMedium();
  Script.complete();
}
runWidget();
