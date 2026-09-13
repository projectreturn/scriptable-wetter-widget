// WetterWidget 4.1 TEST — mit antippbarer Radar-Zeitleiste.
// Daten: DWD-RV, Stationsmessungen und amtliche Gebietswarnungen via Bright Sky.
// Niederschlagsart und lokales Glätterisiko sind Näherungen; im Widget werden
// bewusst keine Datenanbieter eingeblendet.
// Einmal in Scriptable starten und Standort erlauben. Komplett ersetzen.
const SETTINGS = {
  apiBase: "https://api.brightsky.dev",
  rainThreshold: 1, // 0,01 mm/5 Minuten: auch sehr leichter Regen zählt
  radarMapDistance: 10000, // Meter je Richtung werden für die Karte geladen
  radarMapZoom: 12, // Startansicht; höher bedeutet näher herangezoomt
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
async function fetchJSON(path, loc, query, maxAge, cacheName) {
  const key = cacheName || path;
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
function radarMapData(payload, now) {
  const json = payload.json || {};
  const raw = Array.isArray(json.radar) ? json.radar : [];
  const frames = raw.map(function (f) {
    const match = String(f.source || "").match(/::(\d{4}-\d{2}-\d{2}T.*)$/);
    const run = match ? Date.parse(match[1]) : NaN;
    return { at: Date.parse(f.timestamp), run: run,
      forecast: Number.isFinite(run) && run < Date.parse(f.timestamp), grid: f.precipitation_5 };
  }).filter(function (f) {
    return Number.isFinite(f.at) && Array.isArray(f.grid) &&
      f.at >= now - 65 * MIN && f.at <= now + 125 * MIN;
  });
  let points = json.geometry && json.geometry.coordinates || [];
  if (points.length && Array.isArray(points[0]) && Array.isArray(points[0][0])) points = points[0];
  points = points.filter(p => Array.isArray(p) && number(p[0]) != null && number(p[1]) != null);
  return { frames: frames, points: points, position: json.latlon_position || null,
    cached: payload.cached, now: now };
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
  return base + (base.includes("?") ? "&" : "?") + "radar=1";
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
  const body = widget.addStack();
  body.addSpacer();
  const left = body.addStack();
  left.layoutVertically();
  left.size = new Size(105, 0);
  text(left, "AKTUELL", 10, COLORS.muted, true);
  left.addSpacer(2);
  const place = text(left, loc.name || coordinates(loc), 14, COLORS.text, true);
  place.minimumScaleFactor = 0.65;
  left.addSpacer(3);
  const conditions = left.addStack();
  conditions.centerAlignContent();
  const currentSF = SFSymbol.named(currentSymbol(w, m.current)) || SFSymbol.named("questionmark.circle");
  const currentImage = conditions.addImage(currentSF.image);
  currentImage.imageSize = new Size(27, 27);
  currentImage.tintColor = new Color(COLORS.text);
  conditions.addSpacer(6);
  text(conditions, w && w.temperature != null ? w.temperature.toFixed(1).replace(".", ",") + "°" : "—°",
    27, null, true);
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

  body.addSpacer(10);
  const right = body.addStack();
  right.layoutVertically();
  const forecast = right.addStack();
  dailyBlock(forecast, "MORGEN", tomorrow);
  forecast.addSpacer(9);
  dailyBlock(forecast, "ÜBERMORGEN", dayAfter);
  right.addSpacer(6);
  const notice = right.addStack();
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
  body.addSpacer();

  widget.addSpacer(3);
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
async function showRadarMap(loc, w, radar, alerts) {
  if (!radar.frames.length || radar.points.length < 4)
    throw new Error("Radarkarte ist derzeit nicht verfügbar.");
  const warning = alerts.warnings[0] || null;
  const payload = JSON.stringify({ lat: loc.latitude, lon: loc.longitude,
    place: loc.name || coordinates(loc), temperature: w && w.temperature,
    weather: w ? currentLabel(w, null) : "Wetterdaten fehlen",
    warning: warning && warning.title || "", cached: radar.cached,
    zoom: SETTINGS.radarMapZoom, now: radar.now, points: radar.points,
    frames: radar.frames }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html,body{height:100%;margin:0;background:#101114;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}.page{height:100%;box-sizing:border-box;padding:8px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px}
.top{position:relative;z-index:2;padding:10px 12px;border-radius:13px;background:#1a1a1e;color:#f5f5f7;box-shadow:0 3px 18px #0006}
.place{font-size:17px;font-weight:700}.now{float:right;color:#b8b8bf;font-size:13px;margin-top:3px}.weather{font-size:12px;color:#b8b8bf;margin-top:2px}.warning{margin-top:7px;color:#ffad45;font-size:12px;font-weight:650}
.mapcard{position:relative;z-index:1;flex:1;min-height:0;overflow:hidden;border-radius:16px;border:1px solid #303036;box-shadow:0 4px 20px #0008}#map{height:100%;width:100%;background:#25262a}
.panel{position:relative;z-index:2;background:#1a1a1e;color:#f5f5f7;border-radius:15px;padding:11px 13px 10px;box-shadow:0 3px 18px #0008}
.line{display:flex;align-items:center;gap:10px}.play{border:0;border-radius:50%;width:38px;height:38px;background:#5eb4ff;color:#07131d;font-size:17px;font-weight:800}.time{font-size:16px;font-weight:700}.kind{font-size:11px;color:#a8a8af;margin-top:1px}.range{width:100%;accent-color:#5eb4ff;margin:9px 0 4px}.scale{display:flex;justify-content:space-between;color:#929299;font-size:10px}.legend{display:flex;gap:10px;margin-top:8px;color:#aaaab1;font-size:10px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px}.leaflet-control-attribution{font-size:8px!important}
.load{position:absolute;z-index:1000;inset:0;display:grid;place-items:center;background:#25262a;color:#ddd;font-size:15px}
</style></head><body><div class="page">
<div class="top"><span class="place" id="place"></span><span class="now" id="temp"></span><div class="weather" id="weather"></div><div class="warning" id="warning"></div></div>
<div class="mapcard"><div id="map"></div><div class="load" id="load">Radarkarte wird geladen …</div></div>
<div class="panel"><div class="line"><button class="play" id="play">▶</button><div><div class="time" id="time"></div><div class="kind" id="kind"></div></div></div><input class="range" id="range" type="range" min="0" step="1"><div class="scale"><span>−60 Min</span><span>Jetzt</span><span>+60</span><span>+120 Min</span></div><div class="legend"><span><i class="dot" style="background:#50c8ff"></i>leicht</span><span><i class="dot" style="background:#267eff"></i>mäßig</span><span><i class="dot" style="background:#bb35ef"></i>stark</span><span><i class="dot" style="background:#f13e45"></i>sehr stark</span></div></div></div>
<script id="data" type="application/json">${payload}</script><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const d=JSON.parse(document.getElementById('data').textContent),frames=d.frames;
document.getElementById('place').textContent=d.place;document.getElementById('temp').textContent=d.temperature==null?'':String(d.temperature).replace('.',',')+' °C';document.getElementById('weather').textContent=d.weather+(d.cached?' · gespeicherte Radardaten':'');
const warn=document.getElementById('warning');warn.textContent=d.warning?'⚠ '+d.warning:'';warn.style.display=d.warning?'block':'none';
const pts=d.points,lats=pts.map(p=>p[1]),lons=pts.map(p=>p[0]),bounds=[[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]];
const map=L.map('map',{zoomControl:false,attributionControl:true});L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(map);map.fitBounds(bounds,{padding:[20,20]});map.setView([d.lat,d.lon],d.zoom);L.control.zoom({position:'topright'}).addTo(map);
L.circleMarker([d.lat,d.lon],{radius:7,color:'#fff',weight:2,fillColor:'#147cff',fillOpacity:1}).addTo(map).bindTooltip('Aktueller Standort');
let overlay=null,index=Math.max(0,frames.findIndex(f=>f.at>=d.now)),timer=null;const range=document.getElementById('range');range.max=frames.length-1;range.value=index;
function rgba(v){if(v<=0)return[0,0,0,0];if(v<=2)return[80,200,255,145];if(v<=10)return[38,126,255,175];if(v<=35)return[102,61,235,190];if(v<=70)return[187,53,239,205];return[241,62,69,220]}
function imageFor(grid){const h=grid.length,w=grid[0].length,c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d'),im=x.createImageData(w,h);for(let y=0;y<h;y++)for(let z=0;z<w;z++){const a=rgba(grid[y][z]),i=(y*w+z)*4;im.data[i]=a[0];im.data[i+1]=a[1];im.data[i+2]=a[2];im.data[i+3]=a[3]}x.putImageData(im,0,0);return c.toDataURL('image/png')}
function clock(ms){return new Date(ms).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}
function show(i){index=Number(i);range.value=index;const f=frames[index];if(overlay)map.removeLayer(overlay);overlay=L.imageOverlay(imageFor(f.grid),bounds,{opacity:.82,interactive:false,className:'radar'}).addTo(map);const delta=Math.round((f.at-d.now)/300000)*5;document.getElementById('time').textContent=clock(f.at)+(Math.abs(delta)<5?' · jetzt':delta>0?' · +'+delta+' Min':' · '+Math.abs(delta)+' Min zurück');document.getElementById('kind').textContent=f.forecast?'Radarvorhersage im 5-Minuten-Takt':'Radarmessung';}
range.oninput=e=>{stop();show(e.target.value)};function stop(){if(timer){clearInterval(timer);timer=null}document.getElementById('play').textContent='▶'}document.getElementById('play').onclick=()=>{if(timer){stop();return}document.getElementById('play').textContent='Ⅱ';timer=setInterval(()=>{show(index>=frames.length-1?0:index+1)},650)};
show(index);document.getElementById('load').style.display='none';
</script></body></html>`;
  const web = new WebView();
  await web.loadHTML(html);
  await web.present(false);
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
    const radarView = !config.runsInWidget && typeof args !== "undefined" &&
      args.queryParameters && args.queryParameters.radar === "1";
    if (radarView) {
      const mapRange = "&distance=" + SETTINGS.radarMapDistance + "&format=plain&date=" +
        encodeURIComponent(new Date(now - 60 * MIN).toISOString()) + "&last_date=" +
        encodeURIComponent(new Date(now + 120 * MIN).toISOString());
      const mapValues = await Promise.all([fetchJSON("radar", loc, mapRange, 20, "radar-map"),
        fetchJSON("current_weather", loc, "", 30),
        fetchJSON("alerts", loc, "", SETTINGS.alertsMaxAge)]);
      const mapAt = Date.now();
      await showRadarMap(loc, weatherData(mapValues[1], mapAt),
        radarMapData(mapValues[0], mapAt), alertData(mapValues[2], mapAt));
      Script.complete();
      return;
    }
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
    widget = buildWidget(loc, weather, tomorrow, dayAfter, radar, data, at);
  } catch (error) { widget = errorWidget(error); }
  Script.setWidget(widget);
  if (!config.runsInWidget) await widget.presentMedium();
  Script.complete();
}
runWidget();
