const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "wetter-widget.js"), "utf8")
  .replace(/runWidget\(\);\s*$/, "") +
  "\nglobalThis.__weatherLive = { radarData, weatherData, alertData," +
  " todayPrecipitationData, dayData, model };";
const context = { console };
vm.createContext(context);
vm.runInContext(script, context);
const api = context.__weatherLive;

async function json(url) {
  const response = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(response.ok, true, url + " antwortete mit HTTP " + response.status);
  return response.json();
}

async function main() {
  const now = Date.now();
  const latitude = 52.52;
  const longitude = 13.405;
  const base = "https://api.brightsky.dev/";
  const location = "lat=" + latitude + "&lon=" + longitude;
  const radarRange = "&distance=0&format=plain&date=" +
    encodeURIComponent(new Date(now - 60 * 60000).toISOString()) + "&last_date=" +
    encodeURIComponent(new Date(now + 120 * 60000).toISOString());
  const forecastStart = new Date(now);
  forecastStart.setHours(0, 0, 0, 0);
  const forecastEnd = new Date(forecastStart);
  forecastEnd.setDate(forecastEnd.getDate() + 3);
  forecastEnd.setMinutes(forecastEnd.getMinutes() - 1);
  const forecastRange = "&date=" + encodeURIComponent(forecastStart.toISOString()) +
    "&last_date=" + encodeURIComponent(forecastEnd.toISOString());

  const [radarJSON, currentJSON, alertsJSON, forecastJSON] = await Promise.all([
    json(base + "radar?" + location + radarRange),
    json(base + "current_weather?" + location),
    json(base + "alerts?" + location),
    json(base + "weather?" + location + forecastRange)
  ]);
  const payload = value => ({ json: value, cached: false, cachedAt: now });
  const radar = api.radarData(payload(radarJSON), now);
  const weather = api.weatherData(payload(currentJSON), now);
  const alerts = api.alertData(payload(alertsJSON), now);
  const today = api.todayPrecipitationData(payload(forecastJSON), now);
  const tomorrow = api.dayData(payload(forecastJSON), now, 1);
  const data = api.model(radar, weather, alerts, today, now);

  assert.ok(radar.frames.length >= 12, "Zu wenige Radarframes");
  assert.ok(weather && weather.temperature != null, "Aktuelle Temperatur fehlt");
  assert.equal(today.coversEnd, true, "Tagesprognose endet zu früh");
  assert.ok(tomorrow && tomorrow.low != null && tomorrow.high != null, "Morgenprognose fehlt");
  assert.ok(data.notice && data.notice.title, "Hinweistext fehlt");
  console.log("Live-Test erfolgreich:", data.notice.title, "| Radarframes:", radar.frames.length);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
