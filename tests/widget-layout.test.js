const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(kind) { this.kind = kind; this.children = []; }
  addStack() { const child = new Element("stack"); this.children.push(child); return child; }
  addText(value) { const child = new Element("text"); child.value = value; child.centerAlignText = () => {}; this.children.push(child); return child; }
  addImage() { const child = new Element("image"); this.children.push(child); return child; }
  addSpacer() {}
  layoutVertically() {}
  centerAlignContent() {}
  setPadding() {}
}
class ListWidget extends Element { constructor() { super("widget"); } }
class Color { constructor(value) { this.value = value; } static black() { return new Color("000000"); } }
class Size { constructor(width, height) { this.width = width; this.height = height; } }

const context = {
  console, ListWidget, Color, Size,
  Font: { semiboldSystemFont: size => size, systemFont: size => size },
  SFSymbol: { named: name => ({ image: name }) },
  URLScheme: { forRunningScript: () => "scriptable:///run/test" },
  config: { widgetFamily: "medium" }
};
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "wetter-widget.js"), "utf8")
  .replace(/runWidget\(\);\s*$/, "") + "\nglobalThis.__layout = { buildWidget };";
vm.runInContext(source, context);

const now = new Date(2026, 0, 15, 10).getTime();
const loc = { latitude: 52.52, longitude: 13.405, name: "Berlin" };
const weather = { at: now, temperature: 7.4, wind: 12, direction: 220, gust: 25,
  humidity: 75, condition: "dry", icon: "partly-cloudy-day", cached: false };
const day = { low: 2, high: 9, icon: "cloudy", condition: "dry", cached: false };
const radar = { frames: [], run: now, cached: false };
const today = { rows: [
  { at: now, temperature: 7, probability: 10, condition: "dry", icon: "cloudy" },
  { at: now + 60 * 60000, temperature: 8, probability: 20, condition: "dry", icon: "cloudy" }
], coversEnd: true, cached: false };
const model = { current: null, label: "Wolkig", periods: [],
  notice: { title: "Heute bleibt es trocken", detail: "Kein Regen oder Schnee erwartet",
    symbol: "sun.max.fill", color: "98989F" } };

for (const family of ["small", "medium", "large"]) {
  context.config.widgetFamily = family;
  const widget = context.__layout.buildWidget(loc, weather, day, day, radar, model, today, now);
  assert.equal(widget.kind, "widget");
  assert.ok(widget.children.length > 0, family + " enthält keine Elemente");
}

console.log("Kleine, mittlere und große Widget-Struktur erfolgreich getestet.");
