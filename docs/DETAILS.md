# TF3 Dashboard — technical details

Short version: [../README.md](../README.md). Repository: https://github.com/M1r077/tf3-dashboard

Quick start (game running, mod "Second Screen Dashboard" enabled in the savegame): `run_dashboard.cmd`
-> opens a Windows Terminal window (2 panes: collector | server; the "TF3 Dashboard" profile is used if it exists,
otherwise the default profile) then http://127.0.0.1:8765/. On a second monitor: browser full screen (F11). Closing the
window stops everything. Without Windows Terminal: two classic console windows.
Python: `python_embedded\python.exe` from the release zip if present, otherwise `py -3` / `python` (3.10+, stdlib only;
see `_python.cmd`). Nothing to install.
Developer demo without the game (repository only, not in the release zip): `run_dashboard_demo.cmd` regenerates `test\fake.db` with simulated data and serves it on port 8766 with commands disabled.
Pane helpers: `_collector.cmd`, `_server.cmd [--port N] [--db PATH]` (stay open on error, any key = retry;
`_server.cmd` refuses to start if the port is already taken, so an old instance never keeps serving stale code).

Three independent parts:

1. **Mod `tf3_dashboard_export`** (`mod/tf3_dashboard_export`, published on mod.io as *Second Screen Dashboard*): a game
   script that writes `<Steam>\userdata\<id>\3493540\local\dashboard_export\live.lua` via `app.saveUserdata` (folder
   auto-detected by `collector\tf3paths.py`: Steam registry, or `config.json`).
   - fast sections (default 2 s): `time`, `finance`, `alerts`, `vehicles`
   - slow sections (default 30 s): `company`, `lines`, `stations`, `towns`, `industries`, `depots`, `cargo_types`
   - the slow cycle is **time-sliced** (rev 5): it is a job that collects one entity (line, station, town...) per step
     and `guiUpdate` only runs steps for `SLOW_BUDGET` (3 ms) per frame, then resumes on the next frame. A cycle
     therefore spreads over a few dozen frames instead of stalling one frame for several hundred ms. The result replaces
     the previous slow data atomically when the job is complete (`slow_seq` semantics unchanged); only the very first
     cycle after loading runs unthrottled so that the first snapshot is complete. Shared lookups (`getTpNetData`,
     `getTown2BuildingMap`, station/town maps) are fetched once per cycle instead of once per entity. A town is split
     further into one step per API call, and `getCargoSupplyAndLimit` (~55 ms per town, it walks every building) is
     called for `SUPPLY_TOWNS_PER_CYCLE` (2) towns per cycle in rotation, the others keep their last figures. With
     *Debug log* on, the game console prints the duration of each cycle and its slowest steps (measured on a 10-town
     map: 0.7 s per cycle, worst step 40 ms for the longest line).
   - every section runs inside a `pcall`; a failing section shows up in `errors` without blocking the rest (in the
     time-sliced sections a failing entity is reported individually and the others are still exported)
   - mod parameters (Mods menu of the savegame): fast / slow export, vehicles on/off,
     **Permit game control** on/off (off by default), debug log. Names are kept short on purpose: the game's settings
     panel puts the widget to the right of the name on a fixed width, long names push the buttons out of view.
   - **publishing / updating on mod.io** (author only): edit `mod/tf3_dashboard_export` in this repo (bump
     `revision` in `mod.json`, update `_metadata/description.html` and the gallery images `1.png`, `2.png`...), then
     mirror it to the game's staging area: `robocopy mod\tf3_dashboard_export "<Steam>\userdata\<id>\3493540\local\staging_area\tf3_dashboard_export" /MIR`.
     `_metadata\mod.io_fileid.txt` (git-ignored, written by the Mod Hub at the first upload) must be present in the
     staging copy so the Mod Hub offers *Update* instead of creating a new entry. Mod Hub -> My Mods -> Update, with a
     changelog. Title and description on mod.io are overwritten by `modinfo.json` / `description.html` at every update.
     After an update the Mod Hub silently unsubscribes the author (the mod.io copy disappears from
     `C:\Users\Public\mod.io\<game>\mods\<id>`): subscribe again, then in the savegame enable the mod.io entry and disable
     the staging one.
   - **testing a new revision in game before publishing**: the staging copy is itself loadable. In the savegame's mod
     manager two "Second Screen Dashboard" entries appear: disable the mod.io one, enable the staging one, reload.
     Settings are kept (same modId). Never copy the mod into `local\mods\` as well: three entries with the same modId
     are indistinguishable in the list.
   - must be enabled in the savegame (Mods menu), like any script mod
   - also exports the game language (`time.lang`), the icon type of each vehicle (icon_type: Bus, Truck,
     TrainSteam/Electric/Diesel, Tram, Aircraft, Helicopter, Ship), the localized model name (`model`), the neutral model
     key (`model_key`, e.g. `train/re_44i`) and the full consist (`parts`, e.g. `train/re_44i,waggon/ew_ii,-waggon/ew_ii`;
     `-` = reversed element) so the dashboard can show the real icons
   - cargo types are exported with their localized name AND a neutral key (`key`, name of the `.cargo` file); language
     and cargo names are re-read every slow cycle, so **changing the game language is picked up without restart** (the
     dashboard follows the game language while the selector is on "auto")
   - **return channel (dashboard -> game)**: the mod reads `dashboard_export\cmd.lua` 4x/s (`app.loadUserdata`),
     executes the command if it is in the whitelist, deletes the file and reports `cmd_ack` in the next snapshot.
     Commands: set_speed (0 = pause, 1, 2, 4), pause, toggle_pause, focus_entity, focus_position, follow_entity,
     select_entity (opens the entity window in the game, like a click), open_line_manager (line/vehicle manager on a
     line), close_windows, vehicle_stop, vehicle_start, vehicle_reverse, vehicle_depart, vehicle_to_depot, ping.
     Nothing irreversible (no buying, selling, demolishing).
     **Line management**: line_set_stop (load mode, min/max stop time, extra wait, cargos not loaded, forced unload
     at a stop; the mod copies the Line component, changes the given fields and sends makeLineUpdateCmd, exactly like
     the game's filter window; the route is never touched), line_set_all_stops, line_stop_all / line_start_all /
     line_all_to_depot (one command per vehicle), rename_entity, line_set_terminals (preferred + alternative terminals
     of a stop; the station does not change, the game recomputes the path and may refuse if there is none, as in its
     own window).
     The mod exports the configuration of every stop (stop_list: load_mode, min_wait, max_wait, max_add_wait,
     waypoints, force_unload, no_load, max_load, terminals = the station's terminals with type / class / length /
     speed_mod / compatible / overlength, alternatives = alternative terminals) + custom_filters / reservation_priority.
     Full catalogue of what the API allows (done / doable / risky / impossible): docs/API_CATALOGUE.md.

2. **Collector `collector\collector.py`** (Python, stdlib only): watches `live.lua`, parses it (`luatable.py`, own Lua
   table parser) and fills `db\tf3_dashboard.db` (SQLite, schema `collector\schema.sql`).
   - `run_collector.cmd`: starts watching (Ctrl+C to stop)
   - `python collector.py --once`: import the current file once
   - `python collector.py --status`: database summary
   - `python collector.py --list-games` / `--forget-game <id>`: a "game" = one player entity; the dashboard only shows
     the most recently seen game. `--forget-game` deletes everything recorded for another savegame.
   - a snapshot that crashes the import is logged to `db\collector_errors.log` (full traceback) and skipped; the
     collector keeps running.
   - slow sections are only stored when they were re-collected (`slow_seq` changed)
   - retention: per-snapshot detail (vehicles, alerts, finance) is kept for 2 h, then rolled up per minute; slow history
     (lines, towns, stations, industries) is purged after 14 days (`--detail-hours`, `--slow-days`)

3. **Dashboard `dashboard\server.py`** (stdlib, read-only on the database): JSON API (`/api/overview`, `finance`,
   `alerts`, `lines`, `line_history?id=`, `vehicles`, `fleet`, `vehicle_history?id=`, `towns`, `town_history?id=`,
   `industries`, `stations`, `depots`, `map`) + `POST /api/cmd` (`{cmd, args}` -> writes `cmd.lua` for the mod; local
   only; `--no-cmd` to disable, `--cmd-dir` to change the folder) and the page `static\index.html` (3 s refresh,
   `?tab=lines` to open a tab, `?lang=de` to force a language).
   - **Multilingual**: `static\i18n.js` (en / fr / de). Language = `?lang=` > selector choice (localStorage) > game
     language (exported by the mod) > browser. To add a language: copy the `en` block and translate.
   - **Game icons**: `dashboard\extract_icons.py` extracts the TGA files from `base\content\gui.zip`,
     `game_mechanics.zip` and `cargos\*.zip` as white-on-alpha PNG (recolored in CSS via mask) into `static\icons\`
     (+ `icons\cargo\` in color, named by neutral key `grain.png`...). Also extracts the **icons of every vehicle** (colored
     side view, base game + DLCs: buses, trucks, trams, locomotives, wagons, planes, helicopters, zeppelins, ships) into
     `icons\vehicles\<cat>\<model>.png` + `_manifest.json`; the dashboard shows the real model in the tables and the
     **whole consist** in the vehicle sheet (unknown model, e.g. from a mod -> generic pictogram). Stdlib only (own TGA
     decoder + PNG writer, no Pillow); run automatically by `_server.cmd` at first start when
     `static\icons\_manifest.json` is missing; the game is found through the Steam libraries (`libraryfolders.vdf`) or
     `game_dir` in `config.json`. The icons are not redistributed. Re-run after a game update (delete `static\icons`).
   - **Game control**: pause / x1 / x2 / x4 bar in the header (shortcuts Space, 1, 2, 3), camera buttons on
     vehicles / lines / towns / industries / stations / depots / alerts, vehicle sheet: follow, stop / start, reverse,
     depart, send to depot; click on the map = camera on the object (Shift+click on a vehicle = follow). Greyed out when
     the mod parameter "accept commands" is off.
   - **Stops & departures** (line detail): one row per stop with departure mode, min / max stop time, extra wait,
     allowed cargos, terminals; pencil = edit a stop (mode list, seconds fields, cargo chips, "force unload"), "Apply"
     only sends the changed fields, "Apply to all stops" copies mode + waits to the whole line. Line buttons: stop /
     start all vehicles, all to depot (confirmation). Cargo: the chips show the cargos the vehicles can load at the
     stop; click -> window with all cargo types (passengers first), select then OK / Esc / click outside = immediate
     line_set_stop no_load (Cancel = nothing). Terminals (in the editor): one row per terminal of the station with its
     type (passengers / all cargo / specialised class), the loading bonus or malus for the line's cargo (+100 % / -75 %),
     the length, a "too short" warning, the mention "incompatible (slow)" for terminals of another transport mode;
     checkbox = vehicles may stop there, star = preferred terminal (at least one terminal must stay checked).
     Lines and Vehicles tabs: vehicle type icon in front of the name and a filter bar by type (several types can be
     combined, cross to clear).
     Deep links: `?tab=lines&line=<id>`; `?tab=vehicles&veh=<id>`.
   - **Settings** (gear top right, stored in the browser): language, icon size (S/M/L/XL), text size, table density,
     refresh interval, chart history length, hide Finances, keyboard shortcuts on/off, start tab.
   - **Charts** (uPlot): drag = zoom, double-click = reset, click on the legend = hide a series, cursor synchronised
     between the charts of one tab. Time range (15 min ... 7 d, all) right of the tabs; the older part (per-minute
     averages, see retention) is hatched and marked "1 min average" in the tooltip.
   - **Panel layout** (pencil top right, or Settings > Panels): in each tab, drag a panel by its handle to reorder,
     pull the right edge (width, in 12ths of the grid) or the bottom edge (fixed height: charts and lists fill the card),
     -/+ buttons and auto height, hide a panel (it comes back through the "Hidden panels" bar). Esc or Done to leave.
     Stored per tab in the browser (localStorage `tf3.layout`); "Reset this tab" / "all tabs".
   - **Operations** (home page): vital header (date/speed, vehicles by state, overall load, average condition, alerts,
     transported, balance de-emphasised), fleet in service over time (stacked en route / terminal / depot), per-carrier
     table (load, condition, average speed, idle), alerts with age, load & average speed over time, idle / no-line
     vehicles, wear (service first), vehicles stuck en route (zero speed over several samples), most unhappy / busiest
     lines
   - **Lines**: sortable/filterable table (stops, vehicles, headway, load, on board, % unhappy pax, % late cargo,
     cargos); click -> route, capacities per cargo, history (vehicles/on board, quality)
   - **Vehicles**: text/carrier/state/wear/problem filter; line, state (no path, stopped), speed, load, condition, idle
     days, cost/year, value, nearest town; click -> sheet + speed/load/condition history
   - **Towns**: res/com/ind capacities (used/total), unhappy, public transport share, traffic, noise, pollution,
     growth; click -> happiness per mode, reachability, cargo needs, most used lines, history.
     Cargo needs show the same "supplied / needed" figures as the game's town window (mod rev 4+,
     `townBuildingSystem.getCargoSupplyAndLimit`), with the warehouse stock/capacity (`getTownStockCargo`) as a
     secondary figure; with an older mod only the warehouse stock is available, which is not what the game shows.
   - **Industries**: level, status (producing, closing, boost, manual, discarding), production rating, inputs/outputs
     per year with max and shipped/delivered; filter "unserved / closing"
   - **Stations & depots**: waiting, occupancy, overflow, lines; parked vehicles, approaching, maintenance pool
   - **Map**: towns (size), stations (pax/cargo), industries, line routes, live vehicles (line color, red outline =
     stopped en route), geolocated alerts; filter by line, vehicle names, zoom, pan, hover, recenter
   - **Finances** (last tab): balance/debt, year result, cumulated transport, company sheet, running costs per carrier

## Schema (summary)

- `game`: one row per savegame (key = player entity)
- `snapshot`: one row per export (seq, real time, game date, speed, error count); every fact table points to it
- facts per snapshot: `finance`, `company`, `alert`, `vehicle_state`, `line_state`, `line_capacity`, `station_state`,
  `town_state`, `town_cargo`, `town_supply` (supplied / needed; land_use 0 = whole town, 1 = commercial, 2 = industrial), `town_top_line`,
  `industry_state`, `industry_cargo`, `depot_state`
- dimensions (current attributes, upsert): `vehicle`, `line`, `line_stop`, `station`, `town`, `industry`, `depot`, `cargo_type`
- views: `v_latest_snapshot`, `v_finance_series`, `v_line_latest`, `v_vehicle_latest`, `v_alert_latest`
- versions: `snapshot.schema` on the mod side (1 = initial; 2 = cargo ids of line capacities fixed);
  `PRAGMA user_version` on the database side (1 = fix applied to already stored `line_capacity`). The collector fixes
  on the fly the exports of a mod still on schema 1 (+1 offset: a bus "carried vehicles").

## SQL examples

```sql
-- balance curve
SELECT real_time, year, month, balance, loan FROM v_finance_series ORDER BY snapshot_id;

-- most unhappy lines (latest slow snapshot)
SELECT name, vehicles, pax_bad, pax_total, ROUND(100.0*pax_bad/NULLIF(pax_total,0),1) AS pct_bad
FROM v_line_latest ORDER BY pct_bad DESC;

-- current alerts
SELECT kind, entity_id, type_code, amount FROM v_alert_latest;

-- vehicles idle for a long time
SELECT name, carrier, state, days_in_depot, days_at_terminal FROM v_vehicle_latest
WHERE state IN ('IN_DEPOT','AT_TERMINAL') ORDER BY days_in_depot + days_at_terminal DESC;
```

## Alert codes (type_code)

- `line_problem`: ZERO_OR_ONE_STATION / DOUBLE_STATIONS / INCOMPATIBLE_STATIONS / NO_PATH / BAD_ALTERNATIVE_TERMINAL (game enum, type.d.tl ~L2140)
- `vehicle_problem`: NoPathElectric / NoPathShip / NoPathAircraft / NoPathGeneric / Blocked (~L2158)
- `line_issue`: NowhereToLoad / NowhereToUnload / NoVehicleToLoadCargo / VehicleUseless / LineCargoConfig (~L5716)
- `town_problem`: Disconnected / Overlength
