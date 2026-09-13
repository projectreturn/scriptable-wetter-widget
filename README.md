# Scriptable Wetter Widget

Ein kompaktes, mittleres iOS-Widget für [Scriptable](https://scriptable.app/).
Es zeigt das aktuelle Wetter, die Aussichten für morgen und übermorgen sowie
eine klare Regen-, Schnee- oder Glätteinformation für die nächsten 30 Minuten.

## Screenshot

Echte Scriptable-Vorschau mit dem Beispielstandort Berlin:

<img src="screenshots/widget-berlin-v2.jpg" alt="Scriptable Wetter Widget für Berlin" width="320">

Radaransicht nach dem Antippen des Widgets:

<img src="screenshots/radar-berlin.jpg" alt="Radaransicht für Berlin mit Zeitleiste" width="360">

## Anzeige

- **Links über die gesamte Höhe:** aktueller Ort, Wetterzustand, Temperatur und Windrichtung.
- **Rechts oben:** Wetter und Tiefst-/Höchsttemperatur für morgen und übermorgen.
- **Nur rechts darunter:** ein Klartext-Hinweis, ob und in wie vielen Minuten Regen oder
  Schnee beginnt und bis wann er voraussichtlich anhält. Der Beginn wird im
  5-Minuten-Raster angegeben.
- **Ganz unten:** Stand der verwendeten Wetterdaten.

## Installation

1. Installiere **Scriptable** auf dem iPhone.
2. Erstelle in Scriptable ein neues Script.
3. Kopiere den Inhalt von [`wetter-widget.js`](wetter-widget.js) hinein und speichere das Script.
4. Starte es einmal direkt in Scriptable und erlaube den Standortzugriff.
5. Füge ein mittleres Scriptable-Widget zum Home-Bildschirm hinzu und wähle das gespeicherte Script aus.

Beim Antippen öffnet sich eine eigene Radaransicht mit Standortkarte,
10-km-Radarbereich, Zeitschieber und Animation im 5-Minuten-Takt.
iOS bestimmt den tatsächlichen Aktualisierungszeitpunkt des Widgets.

## Daten und Datenschutz

Das Script verwendet DWD-Wetter-, Radar- und Warninformationen über
[Bright Sky](https://brightsky.dev/). Für den Ortsnamen wird die
Standortauflösung von iOS genutzt. Es sind kein API-Schlüssel und kein eigener
Server erforderlich.

Die Grundkarte der Radaransicht stammt von [OpenStreetMap](https://www.openstreetmap.org/)
und wird mit [Leaflet](https://leafletjs.com/) dargestellt.

Die Koordinaten werden für die Wetterabfragen an Bright Sky übermittelt. Die
angezeigte Niederschlagsart und das örtliche Glätterisiko sind Näherungen und
keine Garantie für den Zustand einer bestimmten Straße.

Bereits die kleinste vom Radar gemeldete Niederschlagsmenge von 0,01 mm je
5 Minuten wird als leichter Regen erkannt. Eine ausdrückliche aktuelle
DWD-Stationsmeldung wie „Regen“ hat Vorrang vor einem allgemeinen Wolkensymbol.
