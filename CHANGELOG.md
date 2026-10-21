## 1.1.0

- Flame graph for PHP and Node profiles (click a bar to zoom in). / Flammendiagramm für PHP- und Node-Profile (Klick auf einen Balken vergrößert ihn).
- Compare two measurements (before/after): the last 10 per project, app or request are kept. / Zwei Messungen vergleichen (vorher/nachher): die letzten 10 je Projekt, App oder Anfrage bleiben erhalten.
- Measure any request – also POST with a body; the API tester can send its requests here (`ctx.profiler.runRequest`). / Beliebige Anfragen messen – auch POST mit Inhalt; der API-Tester kann seine Anfragen hierher schicken (`ctx.profiler.runRequest`).
- Small load test with median, 95 %, slowest call and calls per second – only against the own computer or network. / Kleiner Lasttest mit Median, 95 %, langsamstem Aufruf und Aufrufen pro Sekunde – nur gegen den eigenen Rechner oder das eigene Netz.
- Tests for switching Xdebug on and back off (also on errors), for requests, the load test and the app copy under the inspector. / Tests für Xdebug ein/aus (auch bei Fehlern), Anfragen, Lasttest und die App-Kopie unter dem Inspektor.
- Error states with “Try again”; the page sits under “Develop” after the projects; a shortcut to assign; other extensions may add tabs. The release packs everything except the repository tooling. / Fehlerzustände mit „Erneut versuchen“; die Seite steht unter „Entwickeln“ hinter den Projekten; ein Tastenkürzel zum Belegen; andere Erweiterungen dürfen Reiter ergänzen. Das Release packt alles außer dem Repo-Werkzeug.

## 1.0.0

- First release as its own extension (before: built into Hostwerk). Data stays where it was. / Erste Fassung als eigene Erweiterung (vorher fest in Hostwerk). Daten bleiben, wo sie waren.
