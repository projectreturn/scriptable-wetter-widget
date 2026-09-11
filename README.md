# Scriptable Wetter Widget

Ein kompaktes, mittleres iOS-Widget für [Scriptable](https://scriptable.app/).
Es zeigt das aktuelle Wetter, die Aussichten für morgen und übermorgen sowie
Regen, Schnee oder Glätterisiko in den nächsten 5, 10, 15 und 30 Minuten.

## Screenshot

Echte Scriptable-Vorschau mit dem Beispielstandort Berlin:

<img src="screenshots/widget-berlin.jpg" alt="Scriptable Wetter Widget für Berlin" width="320">

## Anzeige

- **Links:** Ort, aktueller Wetterzustand, Temperatur und Windrichtung.
- **Mitte:** Wetter und Tiefst-/Höchsttemperatur für morgen und übermorgen.
- **Rechts:** kurzfristige Entwicklung in 5-Minuten-Schritten sowie Beginn,
  Stärke und voraussichtliches Ende von Niederschlag.
- **Unten:** Zeitpunkt der letzten Berechnung.

## Installation

1. Installiere **Scriptable** auf dem iPhone.
2. Erstelle in Scriptable ein neues Script.
3. Kopiere den Inhalt von [`wetter-widget.js`](wetter-widget.js) hinein und speichere das Script.
4. Starte es einmal direkt in Scriptable und erlaube den Standortzugriff.
5. Füge ein mittleres Scriptable-Widget zum Home-Bildschirm hinzu und wähle das gespeicherte Script aus.

Beim Antippen öffnet sich eine Detailansicht mit zusätzlichen Wetterangaben.
iOS bestimmt den tatsächlichen Aktualisierungszeitpunkt des Widgets.

## Daten und Datenschutz

Das Script verwendet DWD-Wetter-, Radar- und Warninformationen über
[Bright Sky](https://brightsky.dev/). Für den Ortsnamen wird die
Standortauflösung von iOS genutzt. Es sind kein API-Schlüssel und kein eigener
Server erforderlich.

Die Koordinaten werden für die Wetterabfragen an Bright Sky übermittelt. Die
angezeigte Niederschlagsart und das örtliche Glätterisiko sind Näherungen und
keine Garantie für den Zustand einer bestimmten Straße.
