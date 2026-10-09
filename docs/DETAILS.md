# TF3 Dashboard — technical details

Short version: [../README.md](../README.md). Repository: https://github.com/M1r077/tf3-dashboard
Other mods (what we may read, what needs permission): [INTEGRATIONS.md](INTEGRATIONS.md).

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
   script that writes `<Steam>\userdata\<id>\3493540\local\towns_industries\tf3dash_live.lua` and
`tf3dash_slow_<section>.lua` via
   `app.saveUserdata` (folder auto-detected by `collector\tf3paths.py`: Steam registry, or `config.json`).
   - **why `towns_industries` and a `tf3dash_` prefix (rev 9)**: game build 40420 (stability update, 8 Oct 2026)
  restricted `app.saveUserdata` to three userdata folders: `heightmaps`, `mod_presets`, `towns_industries` (any
  other: `The directory you trying to access is not available or invalid`; the list sits next to that message in
  `TransportFever3.exe`). Up to rev 8 the export had its own `dashboard_export` folder, which stopped working that
  day for everybody. `towns_industries` is the least visible of the three (only the map editor lists it, and the
  prefix keeps our files apart from the player's town/industry exports). The companion reads both layouts
  (`tf3paths.prefix_for`): the folder whose live file is the most recent wins, and the collector follows a move
  while it runs (old mod still writing to `dashboard_export`, then the player updates to rev 9).
- fast sections (default 2 s, `tf3dash_live.lua`): `time`, `finance`, `alerts`, `vehicles` (moving fields only: state,
     line, stop, position, speed, load, maintenance)
   - slow sections (default 30 s, one file each: `slow_company.lua`, `slow_cargo_types.lua`, `slow_lines.lua`,
     `slow_stations.lua`, `slow_towns.lua`, `slow_industries.lua`, `slow_depots.lua`, `slow_vehicles.lua` = static
     vehicle fields: name, consist, model, capacity, icon, costs)
   - **why separate files (rev 6, schema 4)**: `app.saveUserdata` serialises and writes the whole table in the calling
     frame. Up to rev 5 everything went into `live.lua`: ~300 KB rewritten every 1-2 s on a 35-line map, of which 90 %
     only changes every slow cycle. Measured 4-5 ms build + 15-19 ms write per snapshot on a fast PC, which we did not
     feel; on a slower PC (disk, antivirus rescanning the file) it was a stutter every second. The author's machine
     hid the problem, a tester's machine showed it. Now `live.lua` is ~30 KB, and after a slow cycle completes its
     files are written **one per frame** (largest: `slow_lines.lua`, ~130-180 KB, once per cycle), then `live.lua`
     starts referring to the new `slow_seq`. The collector waits until every `slow_*.lua` carries the `slow_seq`
     announced by `live.lua` before ingesting (it keeps the two latest cycles per file), then merges everything back
     into one snapshot so the database layer did not change. Mod rev 6 needs companion >= 0.2.0; an older companion
     would see snapshots without lines/towns and log "waiting for the mod's slow_*.lua files".
   - the slow cycle is **time-sliced** (rev 5): it is a job that collects one entity (line, station, town...) per step
     and `guiUpdate` only runs steps for `SLOW_BUDGET` (2 ms) per frame, then resumes on the next frame. A cycle
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
     `C:\Users\Public\mod.io\<game>\mods\<id>`): subscribe again.
     **Do not trust `stdout.txt` to tell whether the upload worked**: a successful update (rev 6) still logged
     `Uploading mod file .../.cooked_pc/` followed by `[Error][Http] Non 200-204 response received: {"error":{"code":500,...}}`,
     several `Mod with ID: <id> changed status: unknown error` and `Staging Mod ... has modified files`; the same
     `unknown error` lines appear on a plain re-subscribe. The 500 comes from a later request of the sequence, after
     the files were stored. Check on the website instead: mod page -> Admin -> Files, every update adds a pair of files
     (Win/Mac/Linux + XSX/PS5), the live pair has its *Publish* button greyed out. The site shows "Version 1.0" for every
     file (the game does not send the revision); the only reliable revision number is `revision` in the `mod.json` inside
     the zip, or in the local copy after subscribing again (`C:\Users\Public\mod.io\<game>\mods\<id>\mod.json`, which
     keeps the old revision until then). Platforms belong to the file, not to the mod, and are fixed at upload: the
     XSX/PS5 file of each pair is useless (consoles do not load userdata mods). The previous pair can be deleted once
     the new one is live, but **the live file of a platform cannot be deleted**: as long as the only console file is
     the live one for XSX/PS5, it stays (rev 9: `8298711`). Untick Xbox/PS5 in the upload form of the next revision so
     no new console file is created; the old one remains until mod.io allows removing the platform from the mod.
     Deleting a file is done on the website, mod page -> Admin -> Files; the file ids are listed by
     `GET https://g-10640.modapi.io/v1/games/10640/mods/<id>/files?api_key=...` (`api.mod.io` is deprecated, only the
     per-game `modapi.io` host answers, and Cloudflare rejects the default `Python-urllib` User-Agent with error 1010:
     send a browser-like `User-Agent` header).
   - **staging always wins over mod.io**: when two installed mods share the same `modId`, the game loads only one of
     them, and it is the staging copy (`stdout.txt`: `Multiple (2) mods with same id found tf3_dashboard_export, the
     one from .../staging_area/tf3_dashboard_export/ has been selected`). The two "Second Screen Dashboard" entries
     in the savegame's mod manager are therefore *not* two selectable copies: whichever is ticked, the staging code
     runs. To test what subscribers actually get, move the staging folder out of `staging_area` (e.g. to a parking
     folder next to the repo), restart the game; move it back to continue developing. The savegame is unaffected (one
     modId, settings kept). Never copy the mod into `local\mods\` as well.
   - **testing a new revision in game before publishing**: mirror the repo to the staging copy (robocopy above),
     reload the savegame; the staging code is what runs (see previous point).
   - must be enabled in the savegame (Mods menu), like any script mod
   - also exports the game language (`time.lang`), the icon type of each vehicle (icon_type: Bus, Truck,
     TrainSteam/Electric/Diesel, Tram, Aircraft, Helicopter, Ship), the localized model name (`model`), the neutral model
     key (`model_key`, e.g. `train/re_44i`) and the full consist (`parts`, e.g. `train/re_44i,waggon/ew_ii,-waggon/ew_ii`;
     `-` = reversed element) so the dashboard can show the real icons
   - cargo types are exported with their localized name AND a neutral key (`key`, name of the `.cargo` file); language
     and cargo names are re-read every slow cycle, so **changing the game language is picked up without restart** (the
     dashboard follows the game language while the selector is on "auto")
   - **return channel (dashboard -> game)**: the mod reads `towns_industries\tf3dash_cmd.lua` 4x/s (`app.loadUserdata`),
     executes the command if it is in the whitelist, deletes the file and reports `cmd_ack` in the next snapshot.
     Commands: set_speed (0 = pause, 1, 2, 4), set_calendar_speed (factor 0.25..4 = the game's "Calendar speed"
     slider; the engine stores a day length in ms, 1x = 4000 ms/day, so 0.25x = 16000 and 4x = 1000 — observed in
     the exported `millis_per_day`), pause, toggle_pause, focus_entity, focus_position, follow_entity,
     select_entity (opens the entity window in the game, like a click), open_line_manager (line/vehicle manager on a
     line), close_windows, vehicle_stop, vehicle_start, vehicle_reverse, vehicle_depart, vehicle_to_depot, ping.
     Nothing irreversible (no buying, selling, demolishing).
   - **activity hint (dashboard -> mod, rev 6)**: on every real interaction with the dashboard (click, key, wheel,
     throttled to one per 1.5 s) the server writes `towns_industries\tf3dash_activity.lua` (`POST /api/activity`). The mod
     polls it with the same folder listing as `cmd.lua`, deletes it, and for `ACTIVITY_WINDOW` (2 s) relaxes its
     timing: a slow cycle is started at once if the previous one is older than `ACTIVITY_MIN_AGE` (5 s), slow steps
     run with `ACTIVITY_BUDGET` (50 ms per frame instead of 2 ms) and all `slow_*.lua` files are flushed in the same
     frame. Rationale: the only moments when a hitch in the game is invisible are the moments when the player is
     looking at the second screen — and those are exactly the moments when fresh data is wanted. It is not a
     command: it works whatever *Permit game control* says and never changes the game state, only when the mod works.
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
   - **savegames**: one `game` row per save, key = `player:<entity>` (the game reuses the same player entity at every
     load of that save, so the history continues across sessions; two different saves get two rows and the dashboard
     shows the one with the latest snapshot). `game.label` = first town (alphabetical) + date first seen; `last_game_day`
     = the game date of the last snapshot; when a snapshot arrives with a game date older than that by more than a
     day, the player reloaded an older save: logged in `game.reloads` (JSON, last 20), the history is kept, the date
     tile turns amber for 24 h and the tooltip says "reloaded from … to …". `--list-games`, `--forget-game ID`.
   - **backups** (settings panel, "Savegames & backups"; `POST /api/backup`): `db\backups\tf3-dashboard-<label>-<stamp>.zip`
     = consistent copy of the database (SQLite backup API, taken while the collector writes) + `camera_views.json` +
     `manifest.json`. Restore (`POST /api/restore {file, what}`): `views` merges the camera views at once (only for saves
     that have none); `all` also writes `db\restore_pending.db`, which `tf3paths.apply_pending_restore` swaps in at the
     next start of the collector or the server (whichever first; the previous database is kept as
     `tf3_dashboard.before-restore-<stamp>.db`). While both run, the live file cannot be replaced on Windows: the swap
     waits for a full restart of `run_dashboard.cmd`.

3. **Dashboard `dashboard\server.py`** (stdlib, read-only on the database): JSON API (`/api/overview`, `finance`,
   `alerts`, `lines`, `line_history?id=`, `vehicles`, `fleet`, `vehicle_history?id=`, `towns`, `town_history?id=`,
   `industries`, `stations`, `depots`, `map`) + `POST /api/cmd` (`{cmd, args}` -> writes `cmd.lua` for the mod; local
   only; `--no-cmd` to disable, `--cmd-dir` to change the folder) and the page `static\index.html` (3 s refresh,
   `?tab=lines` to open a tab, `?lang=de` to force a language).
   - **Multilingual**: `static\i18n.js` (en / fr / de / pt-BR). Language = `?lang=` > selector choice (localStorage) > game
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
   - **Camera views** (Map tab panel, mod rev 7 / companion 0.3.0): the mod exports `snapshot.camera`
     (`api.gui.camera.getCameraData()` = {x, y, dist, angle, pitch} + the followed entity) in every fast snapshot;
     the collector stores it as JSON in `snapshot.camera`; the server returns it in `/api/overview` and the map draws
     it (dashed square). "Save the current view" stores those five numbers under a name in `db\camera_views.json`,
     keyed by the collector's game key (`player:<entity>`), so each savegame has its own list (9 at most). Recall =
     `set_camera` command (the mod detaches a running follow camera first, else it pulls the view back); also
     Shift+1..9 and a click on the numbered pin on the map. Update / rename / reorder / delete through
     `POST /api/views`. With a rev 6 mod the panel explains that revision 7 is needed.
   - **Travelling** (mod rev 10): "Play the views" sends `camera_path {points, duration, loop, ease}` once (the saved
     views in order); the mod keeps the path and, on every `guiUpdate` (= every rendered frame), interpolates and calls
     `setCameraData`: Catmull-Rom through the ground points and the distance (the camera bends through a view instead
     of cornering), shortest-way heading, linear pitch, smoothstep per leg. Cost: one Vec5f per frame. It stops by
     itself at the end (or loops), on `camera_stop`, on `set_camera` / a new path, when a follow camera is active,
     or when the camera is no longer where the mod left it (the player grabbed it). `snapshot.camera.path
     {playing, progress, loop, n}` is exported while it plays; the panel shows a progress bar and the map draws the
     path (dashed when idle, solid while playing). Seconds per leg (5/10/20/40) and loop are remembered per browser
     (`tf3.travel`). An older mod answers "unknown command": the panel says revision 10 is needed.
     `camera_cutscene {file}` is an experiment around `api.gui.mission.playCutscene` (free 6-DOF keyframe files of
     the Advanced Camera Tool); not exposed in the UI until tested in a free game.
   - **Cargo per vehicle** (mod rev 8 / companion 0.3.1): the fast vehicle record carries `cargo` = {cargo id: count
     on board} (from `getNumCargoPerTypeInVehicle`, the same call that gives the total load) and the slow record
     `capacities` = {cargo id: capacity} (from `getVehicleCapacities`). Both are dense arrays over all cargo types in
     the engine, read 1-based by Lua, handled like `getLineCapacityUsages`. Stored as JSON in `vehicle_state.cargo`
     and `vehicle.capacities` (migration columns, NULL from older mods); `/api/vehicles` and `/api/vehicle_history`
     decode them with the cargo names. The Vehicles table shows "Carries" (chips) and the on-board icons with counts
     after the load bar; the text filter matches cargo names.
   - **Horn** (mod rev 8): `horn` command with `vehicle` or `line` (every vehicle of the line) ->
     `api.gui.sound.letVehicleHorn`, GUI thread, nothing changes in the simulation. H on the Vehicles / Lines tab,
     "Horn" button in the vehicle sheet, "Horn (all vehicles)" in the line sheet.
   - **Headquarters on the map** (mod rev 8, Guilherme Seibert Zulian): the mod looks the player's headquarters up
     once (`forEachConstructionWithMetadata("company", ...)`, the construction whose company metadata has
     `headquarters = true`) and exports `company.headquarterId/X/Y`; stored in `company.hq_id/hq_x/hq_y` (migration
     columns), returned by `/api/map` as `headquarters`, drawn as a gold marker with an "HQ" toggle; click = camera.
   - **Detail cards with history** (companion 0.3.1): Industries (`/api/industry_history`: produced / shipped /
     consumed / delivered per cargo, level and yield) and Stations (`/api/station_history`: waiting, capacity,
     overflow, lines calling there — matched on `station_group`, since the mod exports `line_stop.station` as 0)
     join the Towns, Lines and Vehicles cards. Finance tab: network (track / road km, lines, stations) and company
     value (score, assets, debt) over the selected range from the `company` table.
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
     between the charts of one tab. Time range (5 min ... 1 h, all) right of the tabs; the older part (per-minute
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

## Text encoding (verified with a Chinese savegame, 9 Oct 2026)

Names travel as raw UTF-8 all the way: `app.saveUserdata` writes them unescaped (no `\ddd`), `luatable.py` reads
UTF-8, SQLite stores TEXT, `server.py` answers `charset=utf-8`. A savegame downloaded from a Chinese player (7 towns
丽水, 青田, 大港头..., 212 stations, 207 vehicles like 飞机1 / 直升机1, lines like 大港头-市区 铁路客运, full-width
punctuation （...）) showed in the dashboard with 0 replacement characters and 0 mojibake, while **the game itself did
not render those names** on a French client: `locale.zip` ships the Noto CJK fonts but the game only loads them for a
CJK UI language, so a Western client shows boxes/blanks for Chinese names. Not our bug, but worth knowing when a
player reports "the dashboard shows names the game does not". Mixed-language names (`青田 双跑道机场 Gare`) come
from the game: auto-named stations use the client's language at the time they were built.
Sorting uses the browser's `localeCompare` without a locale argument: for CJK that means code-point order, acceptable.
Known gap: `luatable._unescape` turns `\ddd` escapes into one `chr()` per byte; the game never writes them for names,
and if it ever did, multi-byte characters would come out as Latin-1 mojibake (fix: collect the bytes, decode UTF-8).

## Schema (summary)

- `game`: one row per savegame (key = player entity)
- `snapshot`: one row per export (seq, real time, game date, speed, error count); every fact table points to it
- facts per snapshot: `finance`, `company`, `alert`, `vehicle_state`, `line_state`, `line_capacity`, `station_state`,
  `town_state`, `town_cargo`, `town_supply` (supplied / needed; land_use 0 = whole town, rows 1/2 only from mod rev 4), `town_top_line`,
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
- `town_problem`: Disconnected / Overlength. Stored but **not displayed**: `getTownProblems()` flags towns as
  "Disconnected" without saying from what, the game's own UI has no such message, and on a test map it reported two
  towns that were served normally. Query the `alert` table directly if you want to see it.
- `thrown_away_cargo`: `entity_id` is a *stock list* entity, i.e. an industry (`industry.stock_list`), not a line:
  the industry discards cargo it cannot store. The dashboard shows the industry name and links to the Industries tab.
