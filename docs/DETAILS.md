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
   - **Map geography** (mod rev 11 / companion 0.5.0): the mod writes `tf3dash_geo.lua` once after the first slow
     cycle, then again only when the number of `BASE_EDGE` entities changed (checked once a minute, one call). Content:
     `bounds` (`api.engine.terrain.getBoundingBox()`), `tiles` + `water_level` (`TERRAIN` component of the world),
     `water` = the contours of every `WATER_MESH` entity (`riverSystem.getWaterMeshEntities` over the whole tile
     range), simplified with Douglas-Peucker at 6 m and flattened to `[x, y, x, y, ...]`, and `edges` = every street
     and track edge as `[x0, y0, x1, y1, kind]` (`BASE_EDGE.position0/1`; kind bit 0 = track, bit 1 = bridge, bit 2 =
     tunnel). Collected one water mesh / 40 edges per step under the slow budget (2 ms per frame, 50 ms while the
     player is on the dashboard), so the first collection takes a second or two of frames and never stalls; the game
     log line `geo written: N edges, M water contours (a -> b vertices) ...` gives the cost. The collector re-reads
     the file on mtime change into the `geo` table (one JSON row per game); `/api/geo?have=<seq>&game=<id>` answers
     `unchanged` unless a new file arrived. The map tab draws water (fill, even-odd) and the network (streets thin,
     tracks lighter, bridges lighter still, tunnels dashed) once per view into an offscreen canvas and blits it on every
     refresh; "Recentre" fits the real terrain bounds instead of the cloud of points. Lines are still drawn stop to stop.
     Two findings from build 40420: `getEntitiesWithComponent(BASE_EDGE)` fails ("Cannot loop over this component
     type"), so the edges come from `streetSystem.getNode2SegmentMap()` (every segment from both its nodes, deduped,
     7 ms for 4 800 edges); and the sea and lakes are NOT water meshes (those exist only for rivers, one per tile), so
     a 256x256 grid of `terrain.isOnWater` (run-length encoded per row) plus a 64x64 grid of `getHeightAt` give the
     land/water picture and a soft relief, the way the in-game minimap mods do it. Measured on an 11 km map with 4 813
     edges: 472 steps, 2.8 s of collection spread over frames, 28 ms to write, 205 KB file, ~140 KB JSON row.
     The collector hashes the content: the mod rewrites the file on every load, the row (and the browser cache) only
     change when the geography did. Shore refinement: the cells whose 4-neighbourhood mixes land and water are
     resampled 4x4 (`shore = [[col, row, mask16], ...]`, 1 389 cells = 22 000 extra `isOnWater` calls on the test map,
     under a second of frames); the terrain bitmap is built at that sub-cell resolution (1024x1024) and the water-mesh
     contours are no longer drawn over it (tile seams). Heights every 2 cells (128x128); the light looks use a height
     ramp (green - ochre - grey - snow above 90 % of the map's range), the dark ones a snow cap only.
   - **Map style** (gear next to the layer checkboxes, `tf3.map` in localStorage): look (dark / night / atlas /
     paper), relief, network and line strength; `?mapstyle=<look>` forces a look (screenshots). The map view (zoom /
     pan) is remembered per savegame (`tf3.mapview.<key>`) and never refitted under the player's hands; Recentre
     forgets it.
   - **Views attached to a vehicle** (mod rev 11): saving a view while the camera follows a vehicle offers to attach
     it; the view stores `follow` (entity) + `follow_name`; recalling it sends `follow_view {entity, dist, angle,
     pitch}` - the mod calls `followEntity` and re-applies the framing for ~12 frames while the follow camera
     settles. Such a view is active while that vehicle is followed; the single-view travellings are disabled for it
     (its position moves), the chain uses its saved position.
   - **Line routes** (mod rev 11 / companion 0.5.0): where a line really runs. Two sources, merged leg by leg (a leg =
     the way to stop N): (a) *real* - the mod reads each vehicle's `MOVE_PATH.path.edges` (records `{edgeId, dir}`;
     `edgeId.entity` is the BASE_EDGE segment exported in the geography) in the slow vehicles section, keeps per (line,
     leg) the longest sequence seen (a vehicle that just departed holds the whole leg), replaces it when the last edge
     differs (rerouted), and writes `tf3dash_line_paths.lua` only when something changed (2-3 ms, a few KB); the
     collector stores it in `line_path`; (b) *predicted* - the server (`predicted_routes`) runs a shortest path on the
     geography for the legs no vehicle has driven yet: Dijkstra over the street edges for bus / truck / tram lines, over
     the track edges for trains (`line.transport_modes`: 7-8 train, 10/12 ship, 9/11/13 air), A* over the water cells
     of the land/water grid for ships (no corner cutting through land, a small penalty along the shore), straight for
     aircraft; 35 lines / 89 legs in 145 ms, cached until the geography or the stops change. `/api/line_paths` returns
     per line the legs as edge ids or points, predicted ones flagged; the map draws real legs solid and predicted ones
     dashed, chaining the geo segments (each oriented to continue from the previous end). About 20 % of a real leg's
     edge ids are not BASE_EDGE segments (tracks inside stations, depots, construction lanes): the chain skips them
     (gaps under 150 m are bridged), which is good enough on the map. The line tour sends this polyline (thinned to
     60 m) with the stops marked (`args.stops`, 0-based) so the camera follows the rails; the mod adds a high
     waypoint every 2 x alt on long legs.
   - **Travelling** (mod rev 10): the dashboard sends `camera_path {points, duration, loop, ease}` once; the mod
     keeps the path and, on every `guiUpdate` (= every rendered frame), interpolates and calls
     `setCameraData`: Catmull-Rom through the ground points and the distance (the camera bends through a view instead
     of cornering), shortest-way heading, linear pitch, smoothstep per leg. Cost: one Vec5f per frame. It stops by
     itself at the end (or loops), on `camera_stop`, on `set_camera` / a new path, when a follow camera is active,
     or when the camera is no longer where the mod left it (the player grabbed it). `snapshot.camera.path
     {playing, progress, loop, n}` is exported while it plays; the panel shows a progress bar and the map draws the
     path (dashed when idle, solid while playing). An older mod answers "unknown command": the panel says revision
     10 is needed. Three ways to make a path, all in the dashboard except the last:
     - *Around one view* (camera button on a view's row, or pick a view and press Play): the view is the subject,
       the points are generated around it — orbit (full turn), dolly (far -> view, or away), flyover (high and
       far, levelling out), sweep (back and forth +-45 degrees), spiral (turn while coming closer). Direction,
       amplitude (x0.5/1/2), duration (10/20/40/90 s), loop.
     - *Chain all views*: the saved views in order, the duration spread over the legs.
     - *Line tour* (button on a line's sheet, `camera_tour {line, route, closed, alt, speed, loop}`): the dashboard
       sends the stops of the line; **the mod reads the positions of the line's vehicles at that moment**, inserts
       them along the route, merges points closer than alt/2, puts an approach and an exit point around every point
       of interest (heading swinging -30 -> +30 degrees across it, so the camera pans over the subject) and a high
       waypoint in the middle of long empty stretches, then plays it as a normal path. Altitude = 15 % of the span
       of the line, 250-900 m, x amplitude; stops at 0.7x, vehicles at 0.45x, stretches at 1.5x; constant ground
       speed = alt/8 per second (the duration preference can only speed it up). It is a snapshot: a vehicle that
       moves on during the flight is not followed - a live-tracking version was tried and dropped because vehicle
       positions only change on simulation ticks and the picture jerked.
     Preferences live per browser in `localStorage tf3.travel`.
   - **Music** (companion, not the game: there is no "play this file" API): audio files dropped in `<companion>/music/`
     (mp3, ogg, m4a, wav, flac; `GET /api/music`, served under `/music/<name>`, never part of the release zip) play
     in the browser with every travelling. "Any" (default) picks a random track, or one track, or none; fade in 2 s,
     fade out over the last 3 s of the travelling unless "Let it finish" is on; a manual stop fades over 1 s; a
     track already playing is kept when another travelling starts (its end is pushed back, never cut); "Stop the
     music" appears while a track lingers. Browsers only allow audio to start inside a click, so `play()` is called
     synchronously before any fetch (the track list is prefetched), else the panel reports "music blocked".
     The game's own soundtrack is offered too (group "Game soundtrack"): `base/content/music.zip` of the install found
     by `extract_icons.find_game()` holds 24 OGG tracks; they are listed as `game:<entry>` and read out of the zip on
     request (one `zipfile.read` per play, nothing extracted or copied). "Any" prefers the player's own files and falls
     back to the game's when `music/` is empty.
   - **Travellings panel** (own card beside the views, `#travellings`): a travelling is a *recipe*, not a baked path:
     `{kind: view|chain|line, view?, line?, move, dir, amp, dur, loop, music, vol, tail}`, rebuilt from the current
     state when played (today's vehicles on the line, a view that follows its vehicle at its position now). The panel
     holds one **draft** (set by the view row's travelling button, the line sheet's button or "Chain all views"; its
     settings are the browser preferences `tf3.travel`) and the **saved list** (`db/travellings.json`, per savegame
     key, max 20, `GET/POST /api/travellings` with the same actions as the views: add / update / rename / delete /
     move). The gear on a saved travelling edits it in place (every click is a `update`), "Play" rebuilds and plays
     it; a subject that no longer exists reports "no longer exists". The map's dotted eye-track preview follows the
     draft when it is a movement around a view.
     `camera_cutscene {file}` is an experiment around `api.gui.mission.playCutscene` (free 6-DOF keyframe files of
     the Advanced Camera Tool); not exposed in the UI until tested in a free game.
   - **Finance journal** (mod 13 / companion 0.6.0, `tf3dash_journal.lua`): the Finances tab shows the game's own
     accounting table, not a reconstruction. Principle: **the past does not need to be measured while playing, it is
     in the savegame**. The engine keeps the complete journal (every booking since the start of the game) and the
     Finances window is a view on it: `api.engine.util.finance.computeFinanceTable(player, ChartConfig)` returns a
     `FinanceData` {`transport` by carrier and journal key, `investment`, `other`, `loan`, `interest`, `loanBorrowing`,
     `loanRepayment`, `total`, `balance`, `header`} with one value per column. The mod exports two tables:
     - *window*: `ChartConfig.new()` untouched (interval 1 461 000 ms = 1 game year + 1 s, count 20) = **exactly the
       columns the game shows** (4 to 20 depending on the age of the game). Verified against the window line by line
       (e.g. "9/87 - 11/87", Rail: -35 579 614 / -7 126 204 / -1 486 321 / -3 612 352 / 110 315 776, total 3 119 332,
       bank 1 180 624 245, all matching the displayed `$-35,6 M` ... `$1,18 B`).
     - *history*: interval = 1 game year (1 460 000 ms), count = years since the start + 2 = every column since the
       start of the game. On a 70-year game: 43 columns from `1920` to `9/89 - 7/90`.
     What the probes taught (10 Oct 2026, all logged with *Debug log* on): `interval` and `count` only **bound the
     span**, the engine picks the columns itself - fine towards today (half-months, months, quarters), coarser further
     back (years, then 4-year blocks), the last column reaching into the future (the period has just begun). Asking for
     one column per month since 1920 is not possible (`interval = 1 month, count = 510` gave 2-month columns at the end
     and weeks in between). So the dashboard never computes a column's bounds from an index: it parses the engine's
     header (`"1920"`, `"1943 - 1946"`, `"9/87 - 11/87"`, `"4/88"`, `"1/3/90 - 16/3/90"`; two-digit years take the
     century of the game year written with the file, `server._journal_bounds`).
     Keys: the enums `JournalEntry.Type / Maintenance / Construction` are integers behind userdata without names
     (`pairs` gives nothing, `tostring` an address); `FinanceData:unfoldKey(k)` returns the three as a 1-based table.
     The mod exports them as `"type/maintenance/construction"` and the dashboard names them (`JOURNAL_LINES` in
     `app.js`), with the mapping established on the game's own figures:
     | key | line of the Finances window | key | line |
     |---|---|---|---|
     | `4/0/6` | Running costs vehicles | `5/2/6` | Income |
     | `4/3/6` | Maintenance vehicles | `7/2/6` | Other (one-off, carrier 3) |
     | `4/1/0` | Upkeep roads (carrier 0) | inv `3/2/6` | Buy vehicles |
     | `4/1/1` | Upkeep tracks (carrier 1) | inv `2/2/0` / `2/2/1` | Construction roads / tracks |
     | `4/1/6` | Upkeep buildings | inv `2/2/6` / `2/2/7` | Construction buildings / other (sales included, sign mixed) |
     | `4/1/7` | Upkeep warehouses (carrier 3) | `total` | the window's "Income" summary line (= net result) |
     Carriers: 0 road, 1 rail, 2 tram, 3 other, 4 air, 5 water (`api.type.enum.Carrier` order). The labels in
     `i18n.js` are the game's own strings (`base/strings/<lang>/LC_MESSAGES/base.mo`: "Running Costs Vehicles",
     "Maintenance Vehicles", "Upkeep Tracks", "Loan Transactions", "Bank Account"...), so the dashboard says what the
     game says in every language.
     Cost: both tables computed natively, **2-12 ms together on a 70-year game**, file 70-80 KB written in 8-9 ms,
     once per game month (the month index of `game_time_ms` changed) or when the game clock went backwards (savegame
     reloaded). The collector (`ingest_journal`) replaces the two views in `finance_journal` / `finance_journal_col`
     on every new file (33 ms for 15 000 rows); nothing is ever purged - a whole game is a few thousand rows.
     `/api/journal?view=window|history` returns `{cols: [{col, label, start, end}], lines: {"transport/1/5/2/6": [...],
     "investment/3/2/6": [...], "total": [...], "balance": [...], ...}}` (start / end in game months since year 0).
     The tab: the table with the game's grouping (carriers unfold on click, investments, the Summary block: Income =
     `total`, Loan transactions = borrowing + repayment + interest, Bank account, Debt), toggle "As in the game" /
     "Whole game"; below, Bank account and Result per period as curves over the whole game on a game-time axis (one
     point per engine column, placed at the start of its period, labelled with the engine's header). Money is printed
     the way the game does (`$-35,6 M`, `$1,18 B`). Not available with a mod older than 13 (the panel stays empty).
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
