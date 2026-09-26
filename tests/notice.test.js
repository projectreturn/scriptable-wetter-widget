const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const sourcePath = path.join(__dirname, "..", "wetter-widget.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/runWidget\(\);\s*$/, "") +
  "\nglobalThis.__weatherTest = { precipitationNotice };";
const context = { console };
vm.createContext(context);
vm.runInContext(source, context);
const { precipitationNotice } = context.__weatherTest;

const MIN = 60000;
const now = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();
const weather = { temperature: 8, humidity: 70, recent: 0, recent10: 0,
  condition: "dry", icon: "cloudy" };

function radar(wetFromMinutes) {
  const frames = [];
  for (let minute = 0; minute <= 120; minute += 5)
    frames.push({ at: now + minute * MIN, value: minute >= wetFromMinutes ? 2 : 0 });
  return frames;
}
function dryDay(extraRows) {
  const rows = [];
  for (let hour = 0; hour <= 23; hour++)
    rows.push({ at: new Date(2026, 0, 15, hour).getTime(), precipitation: 0,
      probability: 0, temperature: 8, condition: "dry", icon: "cloudy" });
  return { rows: rows.concat(extraRows || []).sort((a, b) => a.at - b.at), coversEnd: true };
}

let notice = precipitationNotice(radar(Infinity), weather, now, {}, dryDay());
assert.equal(notice.title, "Heute bleibt es trocken");

notice = precipitationNotice(radar(65), weather, now, {}, dryDay());
assert.equal(notice.title, "Leichter Regen in ca. 60 Min");

notice = precipitationNotice(radar(10), weather, now, {}, dryDay());
assert.equal(notice.title, "Leichter Regen in ca. 5 Min");

const snowAt = now + 3 * 60 * MIN;
notice = precipitationNotice(radar(Infinity), weather, now, {}, dryDay([
  { at: snowAt, precipitation: 1, probability: 80, temperature: -1,
    condition: "snow", icon: "snow" }
]));
assert.equal(notice.title, "Schneefall ab ca. 13:00");

notice = precipitationNotice(radar(Infinity), weather, now,
  { now: { from: now - MIN, until: now + MIN } }, dryDay());
assert.equal(notice.title, "Amtliche Glättewarnung aktiv");

notice = precipitationNotice(radar(Infinity), weather, now,
  { soon: { from: now + 5 * 60 * MIN } }, dryDay());
assert.equal(notice.title, "Glättewarnung ab ca. 15:00");

const freezingRainAt = now + 4 * 60 * MIN;
notice = precipitationNotice(radar(Infinity), weather, now, {}, dryDay([
  { at: freezingRainAt, precipitation: 0.7, probability: 70, temperature: -2,
    condition: "rain", icon: "rain" }
]));
assert.equal(notice.title, "Glatteis möglich ab ca. 14:00");

console.log("7 Wetterszenarien erfolgreich getestet.");
