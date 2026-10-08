# Changelog

Companion program versions (`VERSION` in `dashboard/server.py`) and mod revisions (`revision` in
`mod/tf3_dashboard_export/mod.json`). Earlier versions: see the [Releases](https://github.com/M1r077/tf3-dashboard/releases) page.

## Companion 0.4.2 — mod revision 8 (unchanged)

### New

- **What to do now** (Operations, first card): one prioritised to-do list (urgent / important / suggestion) built
  from the game alerts, the supply chain alerts, the fleet state, the fleet renewal and the town demand, e.g. "Line X:
  120/yr produced but not picked up, add vehicles", "11 vehicles below 30 % condition", "Renew 10 × A with B",
  "Town X needs food: gets 15 of 200/yr, nearest producer Y (4 km)". Clicking an item opens the right tab.
- **Fleet renewal** (Vehicles tab): vehicles grouped by model when the model is withdrawn, worn out, or a clearly
  better model of the same kind is on sale (newer, at least 25 % faster or bigger / more powerful for locomotives,
  same cargo for trucks): suggested model, gains, cost for the whole group, lines concerned, buttons to show the
  vehicles and the model in the catalogue. Uses the vehicle catalogue (mod revision 8+).
- **Unmet town demand** (Towns tab): cargo a town needs (the town window's figures) and gets less than half of, with
  the nearest industry producing it and its distance.

## Companion 0.4.1 — mod revision 8 (unchanged)

### Interface

- The header is one compact strip (about 52 px instead of up to a third of the screen): brand, key figures (date,
  vehicles, load factor, condition, alerts, transported, balance) as icon + value, game speed and calendar
  controls, status. Labels and details of each figure are in its tooltip; large numbers are abbreviated
  ("25,8 mi $"), the full value is in the tooltip.
- The alert figure is highlighted when there are alerts and opens the alert list.
- Tabs never wrap ("Stations & depots" stays on one line) and scroll sideways on narrow screens.
- The time range is a compact drop-down, shown only on the tabs that have time charts.
- Narrow screens (< 1000 px): the figures get a row of their own instead of being squeezed out.
- Operations tab reorganised: alerts first (next to the fleet chart), idle and stuck vehicles in one "attention"
  card, the cards of a row share its height, alert rows keep their text width (age and buttons stacked on the
  right), the per-carrier table fits.
- Empty tables and detail panels show a centred message with an icon and what to do ("No line yet — create a line
  in the game…", "Nothing matches the filters"), instead of a small "no data" row.
- Tables always use the full card width (a card with a set height made its table shrink to the content).
- Scrollbars are thin and dark; the resize handles of "Arrange panels" no longer stick out of the cards (they made
  both scrollbars appear).

## Companion 0.4.0 — mod revision 8

The Supply chains and Catalogue tabs need mod revision 8+. With an older mod everything else works and those tabs
say the mod must be updated; an older companion ignores the new data of the mod.

### New

- **Supply chains** tab: lines linked by the industries and warehouses their stops serve.
  - Cargo legs per line (source › sink, per year, switch off the ones a line does not really carry), stops with what
    they load and unload, load factor per cargo.
  - Whether each line picks up what its sources produce ("moved X of Y/yr", short of vehicles / covered).
  - Industries and warehouses of the chain: % of capacity, the input that limits them, received / produced per year.
  - Build a chain (add a line, add connected lines), save it (`db/chains.json`, per game), "All lines" view.
  - Chain alerts in the Alerts list, the header count and the map: bottleneck, too many vehicles, industry problem,
    missing input.
- **Catalogue** tab: every vehicle that can be bought (mods included) by year of availability, with speed, capacity,
  power, price, withdrawal year and how many are in the fleet; new this year / next years / withdrawn soon.
  A "New vehicle available" alert for the models of the current game year.
- **Windows notifications** (Settings): new serious alerts, or warnings too, as native Windows notifications while the
  dashboard page is open (also in the background); new vehicles are announced at any level. Clicking a notification
  opens the matching tab.
- **Brazilian Portuguese** (pt-BR) translation of the dashboard and of the mod settings and description.

### Mod

- Revision 8 (schema 6): cargo stations export the industries and warehouses in their catchment; line stops export the
  station they use. Writes `catalogue.lua` (vehicle catalogue) once per session and when the game language changes,
  collected a little per frame.

### Database

- New columns `station.catchment`, `line_stop.station_entity` and table `vehicle_model`, added automatically by the
  collector to an existing database.

## Companion 0.3.0 — mod revision 7 (by the author)

- **Camera views** (Map tab): save the game camera under a name and recall it with one click or Shift+1..9
  (`db/camera_views.json` per savegame); the current camera is drawn on the map as a view cone and the saved view it
  matches is highlighted.
- Dashboard dialogs replace the browser's prompt / confirm.
- Mod revision 7 (schema 5): every fast snapshot carries the game camera; `set_camera` command; live.lua is written
  even when the slow cycle fails.
