// WetterWidget 4.0 — mittleres, schwarzes Scriptable-Widget.
// Daten: DWD-RV, Stationsmessungen und amtliche Gebietswarnungen via Bright Sky.
// Niederschlagsart und lokales Glätterisiko sind Näherungen; im Widget werden
// bewusst keine Datenanbieter eingeblendet.
// Einmal in Scriptable starten und Standort erlauben. Komplett ersetzen.
const SETTINGS = {
  apiBase: "https://api.brightsky.dev",
  rainThreshold: 1, // 0,01 mm/5 Minuten: auch sehr leichter Regen zählt
  radarMaxAge: 20, // Minuten seit DWD-Modelllauf, nicht seit Download
  weatherMaxAge: 40,
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
    recent10: number(w.precipitation_10), recent: number(w.precipitation_60),
    icon: w.icon, condition: w.condition,
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
function stationWet(w) {
  return !!w && (/^(rain|sleet|snow|hail|thunderstorm)$/.test(String(w.condition || "")) ||
    !w.condition && w.recent10 != null && w.recent10 > 0);
}
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
  // An explicit DWD precipitation report takes priority over a generic cloud icon.
  return weatherLabel(w.icon, w.condition, true);
}
function weatherLabel(icon, condition) {
  const labels = { "clear-day": "Sonnig", "clear-night": "Klar", "partly-cloudy-day": "Wolkig",
    "partly-cloudy-night": "Wolkig", cloudy: "Bedeckt", fog: "Nebel", wind: "Windig",
    thunderstorm: "Gewitter", rain: "Regen", sleet: "Regen/Schnee", snow: "Schnee", hail: "Hagel" };
  const precipitation = /^(rain|sleet|snow|hail|thunderstorm)$/;
  const key = precipitation.test(String(condition || "")) ? condition : icon;
  return labels[key] || (condition === "dry" ? "Trocken" : "Wetter unklar");
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
function precipitationPhrase(frame, w) {
  const phase = type(frame, w).name;
  const level = strength(frame);
  const adjective = level === "stark" ? "Starker" : level === "mäßig" ? "Mäßiger" : "Leichter";
  if (phase === "Schnee") return adjective + " Schneefall";
  if (phase === "Regen/Schnee") return adjective + " Schneeregen";
  if (phase === "Niederschl.") return adjective + " Niederschlag";
  return adjective + " Regen";
}
function precipitationNotice(frames, w, now, officialIce) {
  if (officialIce && officialIce.now)
    return { title: "Amtliche Glättewarnung aktiv", detail: "Bitte mit glatten Wegen rechnen",
      symbol: "exclamationmark.triangle.fill", color: COLORS.warning };
  if (officialIce && officialIce.soon) {
    const mins = Math.max(5, Math.ceil((officialIce.soon.from - now) / (5 * MIN)) * 5);
    return { title: "Glättewarnung in ca. " + mins + " Min", detail: "Amtliche Gebietswarnung",
      symbol: "exclamationmark.triangle.fill", color: COLORS.warning };
  }
  const current = frameAt(frames, now);
  const timeline = [];
  for (let n = 0; n <= 120; n += 5) {
    const f = frameAt(frames, now + n * MIN);
    if (!f || f.value == null) break;
    timeline.push(f);
  }
  if (!timeline.length)
    return { title: "Niederschlagsprognose fehlt", detail: "Später erneut versuchen",
      symbol: "questionmark.circle", color: COLORS.muted };
  const firstWet = timeline.findIndex(f => wet(f) && f.at - 5 * MIN <= now + 30 * MIN);
  if (firstWet < 0 && stationWet(w)) {
    const phase = type({ value: SETTINGS.rainThreshold }, w);
    return { title: weatherLabel(w.icon, w.condition) + " jetzt",
      detail: "Ende derzeit nicht sicher bestimmbar", symbol: phase.symbol, color: phase.color };
  }
  if (firstWet < 0 && iceRisk(w, false))
    return { title: "Örtliches Glätterisiko", detail: "Frost und Feuchtigkeit möglich",
      symbol: "snowflake", color: COLORS.warning };
  if (firstWet < 0)
    return { title: "Nächste 30 Min trocken", detail: "Kein Regen oder Schnee erwartet",
      symbol: "cloud.fill", color: COLORS.muted };
  const first = timeline[firstWet];
  let end = null;
  for (let i = firstWet + 1; i + 1 < timeline.length; i++) {
    if (!wet(timeline[i]) && !wet(timeline[i + 1])) {
      end = timeline[i].at - 5 * MIN;
      break;
    }
  }
  const last = timeline[timeline.length - 1].at;
  const phase = type(first, w);
  const isCurrent = wet(current) || stationWet(w);
  const start = first.at - 5 * MIN;
  const delay = Math.max(5, Math.ceil(Math.max(0, start - now) / (5 * MIN)) * 5);
  const title = precipitationPhrase(first, w) + (isCurrent ? " jetzt" : " in ca. " + delay + " Min");
  let detail = end ? "Voraussichtlich bis " + clock(end) : "Mindestens bis " + clock(last);
  let color = phase.color;
  if (iceRisk(w, true) && phase.name === "Regen") {
    detail = "Glätterisiko · " + detail.toLowerCase();
    color = COLORS.warning;
  }
  return { title: title, detail: detail, symbol: phase.symbol, color: color };
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
  const summary = eventText(radar.frames, w, now);
  return { current: current, label: currentLabel(w, current), summary: summary,
    notice: precipitationNotice(radar.frames, w, now, { now: warningNow, soon: warningSoon }),
    officialIce: !!(warningNow || warningSoon), ice: iceRisk(w, wet(current)) };
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
  if (w && /^(rain|sleet|snow|hail|thunderstorm)$/.test(String(w.condition || "")))
    return weatherSymbol(w.condition);
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
  block.size = new Size(84, 0);
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
  const label = text(block, forecast ? weatherLabel(forecast.icon, forecast.condition) : "Keine Daten",
    10, COLORS.muted, false);
  label.minimumScaleFactor = 0.65;
}
function buildWidget(loc, w, tomorrow, dayAfter, radar, m, now) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.black();
  widget.setPadding(14, 16, 7, 16);
  widget.url = detailsURL();
  widget.refreshAfterDate = new Date(now + 5 * MIN);
  const top = widget.addStack();
  top.addSpacer();
  const left = top.addStack();
  left.layoutVertically();
  left.size = new Size(105, 0);
  const currentTitle = text(left, "AKTUELL · " + (loc.name || coordinates(loc)), 10, COLORS.muted, true);
  currentTitle.minimumScaleFactor = 0.6;
  left.addSpacer(2);
  const conditions = left.addStack();
  conditions.centerAlignContent();
  const currentSF = SFSymbol.named(currentSymbol(w, m.current)) || SFSymbol.named("questionmark.circle");
  const currentImage = conditions.addImage(currentSF.image);
  currentImage.imageSize = new Size(27, 27);
  currentImage.tintColor = new Color(COLORS.text);
  conditions.addSpacer(6);
  text(conditions, w && w.temperature != null ? w.temperature.toFixed(1).replace(".", ",") + "°" : "—°",
    27, null, true);
  text(left, m.label, 11, COLORS.text, false, 1);
  left.addSpacer(2);
  const wind = left.addStack();
  wind.centerAlignContent();
  const windSF = SFSymbol.named("wind") || SFSymbol.named("arrow.right");
  const windImage = wind.addImage(windSF.image);
  windImage.imageSize = new Size(12, 12);
  windImage.tintColor = new Color(COLORS.muted);
  wind.addSpacer(4);
  text(wind, windLabel(w, true), 9, COLORS.muted, false, 1);
  top.addSpacer(9);
  dailyBlock(top, "MORGEN", tomorrow);
  top.addSpacer(9);
  dailyBlock(top, "ÜBERMORGEN", dayAfter);
  top.addSpacer();

  widget.addSpacer(5);
  const notice = widget.addStack();
  notice.backgroundColor = new Color("161618");
  notice.cornerRadius = 10;
  notice.setPadding(5, 10, 5, 10);
  notice.centerAlignContent();
  const noticeSF = SFSymbol.named(m.notice.symbol) || SFSymbol.named("questionmark.circle");
  const noticeIcon = notice.addImage(noticeSF.image);
  noticeIcon.imageSize = new Size(17, 17);
  noticeIcon.tintColor = new Color(m.notice.color);
  notice.addSpacer(8);
  const noticeText = notice.addStack();
  noticeText.layoutVertically();
  text(noticeText, m.notice.title, 12, m.notice.color, true, 1);
  noticeText.addSpacer(1);
  text(noticeText, m.notice.detail, 9, COLORS.muted, false, 1);
  notice.addSpacer();

  widget.addSpacer(2);
  const bottom = widget.addStack();
  bottom.size = new Size(0, 9);
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
