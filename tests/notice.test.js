const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const sourcePath = path.join(__dirname, "..", "wetter-widget.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/runWidget\(\);\s*$/, "") +
  "\nglobalThis.__weatherTest = { precipitationNotice, precipitationPeriods, alertData," +
  " warningKind, dataStatus, todayPrecipitationData, iceRiskAt };";
const context = { console };
vm.createContext(context);
vm.runInContext(source, context);
const api = context.__weatherTest;

const MIN = 60000;
const now = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();
const weather = { temperature: 8, humidity: 70, dewPoint: 3, recent: 0, recent10: 0,
  condition: "dry", icon: "cloudy" };

function radarRanges(ranges, until = 120) {
  const frames = [];
  for (let minute = 0; minute <= until; minute += 5) {
    const active = ranges.some(range => minute >= range[0] && minute <= range[1]);
    frames.push({ at: now + minute * MIN, value: active ? 2 : 0 });
  }
  return frames;
}
function dryDay(extraRows, probability = 0) {
  const extras = extraRows || [];
  const replaced = new Set(extras.map(row => row.at));
  const rows = [];
  for (let hour = 0; hour <= 23; hour++)
    if (!replaced.has(new Date(2026, 0, 15, hour).getTime()))
      rows.push({ at: new Date(2026, 0, 15, hour).getTime(), precipitation: 0,
        probability, temperature: 8, humidity: 70, dewPoint: 3,
        condition: "dry", icon: "cloudy" });
  return { rows: rows.concat(extras).sort((a, b) => a.at - b.at), coversEnd: true };
}

let notice = api.precipitationNotice(radarRanges([]), weather, now, {}, dryDay());
assert.equal(notice.title, "Heute bleibt es trocken");

notice = api.precipitationNotice(radarRanges([[65, 120]]), weather, now, {}, dryDay());
assert.equal(notice.title, "Leichter Regen in ca. 60 Min");

notice = api.precipitationNotice(radarRanges([[10, 25]]), weather, now, {}, dryDay());
assert.equal(notice.title, "Leichter Regen in ca. 5 Min");
assert.match(notice.detail, /Kurzer Schauer/);
assert.match(notice.detail, /ca\. 0,1 mm/);

const timedSnow = dryDay([{ at: now + 60 * MIN, precipitation: 0, probability: 0,
  temperature: -1, humidity: 90, dewPoint: -2, condition: "snow", icon: "snow" }]);
notice = api.precipitationNotice(radarRanges([[65, 80]]), weather, now, {}, timedSnow);
assert.equal(notice.title, "Leichter Schneefall in ca. 60 Min");

const snowAt = now + 3 * 60 * MIN;
notice = api.precipitationNotice(radarRanges([]), weather, now, {}, dryDay([
  { at: snowAt, precipitation: 1, probability: 80, temperature: -1,
    humidity: 90, dewPoint: -2, condition: "snow", icon: "snow" }
]));
assert.equal(notice.title, "Schneefall wahrscheinlich ab ca. 13:00");

notice = api.precipitationNotice(radarRanges([]), weather, now,
  { now: { kind: "storm", from: now - MIN, until: now + MIN } }, dryDay());
assert.equal(notice.title, "Amtliche Sturmwarnung aktiv");

notice = api.precipitationNotice(radarRanges([]), weather, now,
  { soon: { kind: "thunderstorm", from: now + 5 * 60 * MIN } }, dryDay());
assert.equal(notice.title, "Gewitterwarnung ab ca. 15:00");

const freezingRainAt = now + 4 * 60 * MIN;
notice = api.precipitationNotice(radarRanges([]), weather, now, {}, dryDay([
  { at: freezingRainAt, precipitation: 0.7, probability: 70, temperature: -2,
    humidity: 95, dewPoint: -2.5, condition: "rain", icon: "rain" }
]));
assert.equal(notice.title, "Glatteis möglich ab ca. 14:00");
assert.match(notice.detail, /70 % Niederschlagswahrscheinlichkeit/);

const periods = api.precipitationPeriods(radarRanges([[10, 25], [60, 75]]), weather, dryDay(), now).periods;
assert.equal(periods.length, 2);
notice = api.precipitationNotice(radarRanges([[10, 25], [60, 75]]), weather, now, {}, dryDay());
assert.match(notice.detail, /erneut 10:55/);

notice = api.precipitationNotice(radarRanges([]), weather, now, {}, dryDay([], 45));
assert.equal(notice.title, "Regen später möglich");
assert.match(notice.detail, /45 %/);

notice = api.precipitationNotice(radarRanges([], 30), weather, now, {}, { rows: [], coversEnd: false });
assert.equal(notice.title, "Bis 10:30 trocken");
assert.match(notice.detail, /Prognose unsicher/);

assert.equal(api.warningKind("Amtliche Warnung vor schweren Gewittern"), "thunderstorm");
assert.equal(api.warningKind("Warnung vor Orkanböen"), "storm");
assert.equal(api.warningKind("Warnung vor starkem Schneefall"), "snow");

const alert = api.alertData({ json: { alerts: [{ event_de: "Starkes Gewitter",
  onset: new Date(now - MIN).toISOString(), expires: new Date(now + 60 * MIN).toISOString(),
  severity: "severe" }] }, cached: false }, now);
assert.equal(alert.warnings[0].kind, "thunderstorm");
assert.equal(alert.warnings[0].severity, "severe");

assert.equal(api.iceRiskAt({ temperature: -1, humidity: 92, dewPoint: -1.5, condition: "rain" }, true), true);
assert.equal(api.iceRiskAt({ temperature: 5, humidity: 95, dewPoint: 4.5, condition: "rain" }, true), false);

const status = api.dataStatus({ cached: true, cachedAt: now - 3 * 60 * MIN }, null, null, null, null, now);
assert.match(status.text, /Offline/);
assert.match(status.text, /3 Std\. alt/);

const dstNow = new Date(2026, 2, 29, 12).getTime();
const dstRows = [];
for (let hour = 0; hour <= 23; hour++) dstRows.push({
  timestamp: new Date(2026, 2, 29, hour).toISOString(), temperature: 8,
  precipitation: 0, precipitation_probability: 0, condition: "dry", icon: "cloudy"
});
dstRows.push({ timestamp: new Date(2026, 2, 30, 0).toISOString(), temperature: 7,
  precipitation: 0, condition: "dry", icon: "cloudy" });
const dstDay = api.todayPrecipitationData({ json: { weather: dstRows }, cached: false }, dstNow);
assert.equal(dstDay.coversEnd, true);
assert.equal(dstDay.rows.every(row => new Date(row.at).getDate() === 29), true);

console.log("20 Logik- und Wetterszenarien erfolgreich getestet.");
