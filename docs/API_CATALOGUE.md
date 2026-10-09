# Catalogue: what the dashboard can do with Transport Fever 3

Single reference of everything the TF3 Lua API allows from a *game script* running on the GUI thread
(`guiUpdate`), as used by the `tf3_dashboard_export` mod. Sources: the game's `api/tealdef/api/*.d.tl` and the
interface scripts in `base/content/gui.zip` / `game_mechanics.zip` (game version installed on 2026-10-06).
Every entry carries a **status**:

| Status | Meaning |
|---|---|
| **DONE** | already exposed by the mod (read) or already a `cmd.lua` command + dashboard button |
| **EASY** | doable with a simple command, no risk of breaking the save |
| **MEDIUM** | doable, but needs a read-modify-write of a whole structure or a validation only the game can do |
| **RISKY** | technically possible but irreversible / destructive / real money; must sit behind a confirmation |
| **NO** | out of reach from a script (or of no interest for the dashboard) |

Naming convention of `cmd.lua` commands: `{ id = <n>, cmd = "<name>", args = { ... } }`, answer in
`live.lua` -> `cmd_ack = { id, cmd, ok, error, real_time }`.

---

## 1. General mechanics

### 1.1 Three distinct channels

| Channel | API | Thread | Effect |
|---|---|---|---|
| **Simulation command** | `api.cmd.sendCommand(api.cmd.makeXxxCmd(...), callback)` | GUI -> engine | modifies the game (saved). The callback receives `(cmd, success)`; the mod's ack waits for it. |
| **React event** | `api.gui.fireReactEvent(name, param)` | GUI | acts on the game's interface (open a window, select). No return value, no error if the name is wrong. |
| **Camera / direct GUI** | `api.gui.camera.*`, `api.gui.closeAllWindows()`, `api.gui.byId.*` | GUI | immediate, nothing in the save. |

### 1.2 Structural limits

- A game script **cannot** draw inside the game window (no custom UI from a game script in TF3; the UI is internal
  React/Teal). Everything is displayed in the dashboard.
- Every write goes through **a whole command**: there is no "change a single field of a stop". For a line, read
  `LINE`, modify the table, send everything back (`makeLineUpdateCmd`).
- Commands are validated by the engine: a line whose stop is no longer reachable is accepted, but the vehicles go
  to "no path". The "route possible" validation **only exists inside the game**.
- The file channel (`cmd.lua` re-read 4x/s) implies ~250 ms latency and **one command at a time** (the server
  refuses while a `cmd.lua` is pending).
- Money: buying/selling/replacing is real and immediate, with no "undo".

---

## 2. Reading (already exported or available)

### 2.1 Already in `live.lua` (DONE)

| Domain | Functions used |
|---|---|
| World | `GAME_TIME`, `GAME_SPEED`, `getYear`, `getPlayer`, lang |
| Vehicles | `vehicle.getVehicles/getSpeed/getPosition/getVehicleType/getVehicleCapacities/getVehicleMaintenanceState/getRunningCost/getDepreciatedValue/getVehicleProblems`, `cargo.getNumCargoPerTypeInVehicle`, component `TRANSPORT_VEHICLE` (state, line, stop, user_stopped, model), `transportVehicleSystem.getDepotVehicles/getGoingToDepotVehicles/getNoPathVehicles`, `landVehicleMoveSystem.getBlockedTrains` |
| Lines | component `LINE` (stops, station groups), `COLOR`, `line.getLineCapacityUsages/getMaxFrequency/calcLineStationThroughput/getLineProblems/getLinesIssues/getLineTransportModesUnion`, `cargo.getSummarizedCargoQualityDataForLine` |
| Towns | `TOWN`, `town.getTownCapacityUsage/getTownHappinessStats/getTownLineUsage/getTownReachability/getTownEmissionDB/getTownStockCargo/getTownProblems/computeTownsTrafficSpeedMap/getTownDistrictCenter`, `townBuildingSystem.getCargoSupplyAndLimit` (= the town window's supplied / needed; `getTownStockCargo` is the warehouse stock, a different figure) |
| Industries | `INDUSTRY`, `STOCK_LIST`, `stock.getProductionRating/getCargoProducedPerYear/.../getStockListsWithThrownAwayCargo/getInputsOutputsFromRules`, `industry.getIndustryProductivityInfo/getClosingIndustries` |
| Stations / depots | `station.calculateStationUsage/isStationOfType`, `VEHICLE_DEPOT`, `CONSTRUCTION` |
| Finances | `ACCOUNT`, `finance.getPlayersBalance/calculateEarnings`, `headquarters.getTransportedData/getCompaniesValue` |
| Repositories | `api.res.cargoTypeRep`, `api.res.modelRep` |

### 2.2 Available, not exported yet

| Data | Function | Dashboard interest | Status |
|---|---|---|---|
| Detailed problems per stop of a line | `line.getDetailedLineProblems(line)` -> `{{StopState}}` | diagnose "no path" between two specific stops | EASY |
| Line <-> station problems | `line.getLineStationProblems()` | unserved station / incompatible terminal | EASY |
| Reason of a vehicle's failed path | `line.getFailedPathReason(vehicle, line)` | explicit text in the vehicle sheet | EASY |
| Roads without connection | `line.getNoRoadConnectionProblems()` | | EASY |
| Cargo quality per stop / station / terminal | `cargo.getCargoQualityDataAtStop/AtStation/AtTerminal` | where passengers wait too long | EASY |
| Terminal occupancy | `station.calculateStationTerminalUsage(station, idx)` | saturated platform | EASY |
| Cargo of a station group | `station.calculateStationGroupCargo` | | EASY |
| Overlapping catchment areas | `station.findStationGroupWithOverlappingCatchmentOfDifferentCarriers()` | | EASY |
| Best depot for a line | `vehicle.findBestDepotForLine(carrier, modes, line)` | prerequisite for buying from the dashboard | EASY |
| Best line/depot for a vehicle | `vehicle.findBestLineAndDepotForVehicle` | | EASY |
| Length / price of a consist | `vehicle.getLength`, `vehicle.getPartPrice` | | EASY |
| Maintenance penalties | `vehicle.getMaintenance*Penalty` | | EASY |
| Deliveries per town / line | `town.getTownDeliveriesStats(town, interval, perLine, ...)` | which line feeds which town | EASY |
| Origin -> destination flows | `town.getSourceToDestinationCount` | simplified OD matrix | MEDIUM (CPU cost) |
| Noise per district | `town.getTownNoisePerDistrict` | | EASY |
| Pollution / noise emitters | `emission.getPollutionEmittersInSettlementArea`, `getNoiseEmittersNearSettlementLandUses` | | EASY |
| Logbooks (native time series) | `logbook.getLogValuePerYear/MostRecent`, `getChartDiff` | the same curves as the game's statistics, per entity | MEDIUM |
| Full finance table | `finance.computeFinanceTable(player, config)`, `getAccountChart` | Finances tab identical to the game | MEDIUM |
| Entities within a radius | `octree.findEntitiesInCircle(center, r, componentType)` | "what happens around this point" | EASY |
| Closest town to a position | `town.getClosestTown(pos)` | | DONE (approximated) |
| Theoretical path | `pathfinding.findPathNodeToNode` | check whether two stations are connected | MEDIUM |
| Current camera | `api.gui.camera.getCameraData()`, `getFollowEntity()` | `snapshot.camera {x, y, dist, angle, pitch, follow}`; drawn on the Map tab | DONE (rev 7) |
| Estimated max speed | `api.gui.game.getEstimatedMaximumGameSpeed()` | grey out the x4 button when the machine cannot keep up | EASY |
| Performance | `api.gui.benchmark.get*Times()` | mini FPS/sim monitor | EASY |
| Visibility | `api.gui.byEntity.isVehicleVisible(e)` | know whether the vehicle is on screen | EASY |
| Mouse terrain position | `api.gui.mouse.getTerrainPosition()` | | EASY |
| Mission / campaign | `api.gui.mission.getMission()` | | NO (no campaign here) |

---

## 3. Camera and game windows (`api.gui`)

| Action | Call | Dashboard command | Status |
|---|---|---|---|
| Center on an entity | `camera.focusEntity(e)` | `focus_entity {entity}` | DONE |
| Center on a position | `camera.focusPosition(Vec3f, distance)` | `focus_position {x,y,z,distance}` | DONE |
| Follow a vehicle | `camera.followEntity(e, jump)` | `follow_entity {entity, jump}` | DONE |
| Cockpit view | `camera.enterFollowCameraCockpit(e)` / `leaveFollowCameraCockpit()` | `cockpit {entity}` / `cockpit_leave` | EASY |
| Free camera | `camera.toggleFreeCamera()` | | EASY |
| Place the camera precisely | `camera.setCameraData(Vec5f{x, y, dist, angle, pitch})` (`setManualCamera(center, dist)` exists too, less complete) | `set_camera {x, y, dist, angle, pitch}` | DONE (rev 7) — "Camera views" panel on the Map tab: named views saved in `db/camera_views.json` per savegame, recalled by click or Shift+1..9. A running follow camera is detached first (`focusPosition`), otherwise it pulls the view back to the vehicle. |
| Read the camera | `camera.getCameraData()` | `snapshot.camera`, every fast snapshot | DONE (rev 7) — the Vec5f fields are `x, y, z, w, q` = center.x, center.y, distance, angle, pitch (radians) |
| Camera travelling (smooth path) | `setCameraData` called **every frame** from `guiUpdate` with an interpolated Vec5f: no rate limit, `guiUpdate` runs per rendered frame | `camera_path {points=[{x,y,dist,angle,pitch,duration?}], duration, loop, ease}`, `camera_stop` | DONE (rev 10) — the mod interpolates (Catmull-Rom on x/y/dist, shortest-way heading, smoothstep per leg) and reports `camera.path {progress}`; stops when the player grabs the camera, a follow camera takes over, or a new path/set_camera arrives. Dashboard: "Play the views" in the Camera views panel, path drawn on the map. Orbit model only: no roll, no FOV. |
| Cinematic camera (free 6-DOF, roll, FOV, attached to a vehicle, fades) | `api.gui.mission.playCutscene(filePath, resolveLanguage, entityMap)`, `isCutscenePlaying()`, `getCutsceneElapsedTime()` — plays a keyframe file in the Advanced Camera Tool format (`camera = {{angle, pitch, roll, fovY, position={x,y,z}, time, attachment={entity}}}`, see the campaign's `mission/keyframes/`). | `camera_cutscene {file}` (experiment) | RISKY / UNTESTED — unknown whether it works outside a mission and whether a userdata path is accepted (`saveUserdata` can only write `towns_industries`); the native Advanced Camera Tool window (`cameraManagerWindow`) is C++ only, no API to feed it keyframes. |
| Screenshot | `camera.takeScreenshot(scale)` -> userdata folder | `screenshot {scale}` | EASY (the file lands on the game side, not served by the dashboard) |
| Horn | `api.gui.sound.letVehicleHorn(e)` | `horn {entity}` | EASY (gadget) |
| Open an entity window (line, vehicle, station, town, industry, depot...) | `fireReactEvent("selectEntity", {entity=e, stack=bool})` | `select_entity {entity, focus, stack}` | DONE |
| Close all windows | `api.gui.closeAllWindows()` | `close_windows` | DONE |
| Line/vehicle manager on a line | `fireReactEvent("openVehicleManager", {openWithLineEntity=e})` | `open_line_manager {line}` | DONE |
| Manager on a depot | `... {openWithDepotEntity=e}` | `open_depot_manager {depot}` | EASY |
| Manager on vehicles | `... {openWithVehicleEntities={...}}` | `open_vehicle_manager {vehicles}` | EASY |
| "Send to line" mode | `... {openWithVehicleEntities={...}, sendToLineMode=true}` | | EASY |
| Close the manager | `fireReactEvent("closeVehicleManager", {})` | | EASY |
| Finance window | `fireReactEvent("openFinanceWindow")` / `"closeFinanceWindow"` | `open_finance` | EASY |
| Statistics window on a tab | `fireReactEvent("openStatisticsWindow", "Line")` — keys: `Line, Vehicle, Station, Town, Industry, Warehouse, Depot` | `open_statistics {tab}` | EASY |
| Company window | `fireReactEvent("openCompanyWindow", {initialTabKey="Company"})` | | EASY |
| Notification log | `fireReactEvent("openNotificationLog")` | | EASY |
| Layers | `fireReactEvent("openLayerRidge", {layer="menu.layers.<id>", stack=true})` — ids: `terrainButton, townsButton, speedButton, trafficButton, cargoButton, cargoFlowButton, mobilityButton, noiseButton, pollutionButton, publicTransportButton, hudFilters`; `"closeLayerRidge"` | `open_layer {layer}` | EASY |
| Layer configuration (e.g. filtered cargo) | `fireReactEvent("preferredLayerConfig", {config=LayerConfig})` | | MEDIUM (LayerConfig structure to reverse-engineer per layer) |
| Construction menu on a tab | `fireReactEvent("constructionMenuSetTab", {tabIndex=n, sublistId=...})`, `"constructionMenuQuit"` | | EASY but of little use without a mouse in the game |
| Pause menu | `fireReactEvent("openPauseMenu")` | | EASY |
| Deselect | `fireReactEvent("selectNothing", {stack=true})` | | EASY |
| World marker (like missions) | `api.gui.mission.setMarkerAtEntity(key, e, type, scale)` / `setMarkerAtPosition` / `removeMarker(key)` | `mark {entity}` | EASY — **very useful**: arrow on a stuck vehicle, a stop, an industry |
| Colored ground zone | `api.gui.mission.setZoneCircle(key, center, radius, draw, color, prohibitBuilding)` / `setZone(polygon)` / `removeZone` | `zone {...}` | EASY — catchment radius, noise zone |
| Ephemeral HUD icon | `api.gui.spawnEphemeralHudImage(icon, entity, color, pos, duration)` | | EASY (visual feedback of a command) |
| Visualise a ship's path | `api.gui.mission.setMovePathVisualizationAtEntity` | | EASY (ships only) |
| Show/hide a UI element | `api.gui.byId.setVisible(id, bool)`, `setEnabled` | | NO (internal ids, fragile) |
| Music | `api.gui.musicPlayer.*` | | NO (unrelated) |

---

## 4. Simulation: commands (`api.cmd`)

### 4.1 Game

| Action | Command | Dashboard | Status |
|---|---|---|---|
| Speed 0/1/2/4 | `makeGameSetSpeedCmd(n)` | `set_speed`, `pause`, `toggle_pause` | DONE |
| Calendar speed 0.25x..4x | `makeGameSetCalendarSpeedCmd(ms)` (1x = 4000 ms/day) | `set_calendar_speed` | DONE (rev 6) |
| Change the date | `makeGameSetDateCmd(Date)` | | RISKY (vehicle availability) |
| Time of day | `makeGameSetTimeOfDayCmd(sec)` | `set_time_of_day` | EASY (cosmetic: day/night) |
| Cloud coverage | `makeGameSetCloudCoverageCmd(0..1)` | | EASY (cosmetic) |
| Wind | `makeWorldChangeWindCmd(grid, Vec2f)` | | EASY (cosmetic) |
| Advance N sim steps | `makeGamePerformSimulationStepsCmd(n)` (debug) | | NO |

### 4.2 Vehicles

| Action | Command | Dashboard | Status |
|---|---|---|---|
| Stop / start | `makeVehicleSetStoppedByUserCmd(v, bool)` | `vehicle_stop/start` | DONE |
| Reverse | `makeVehicleReverseCmd(v)` | `vehicle_reverse` | DONE |
| Force departure | `makeVehicleTryToDepartCmd(v)` | `vehicle_depart` | DONE |
| Send to depot | `makeVehicleSendToDepotCmd(v, sellOnArrival=false)` | `vehicle_to_depot` | DONE |
| Send to depot **and sell** | `... sellOnArrival=true` | `vehicle_to_depot {sell=true}` | RISKY (confirmation) |
| Teleport to depot | `... jumpToDepoEntity=depot` | | RISKY |
| Manual departure on/off (never leaves on its own) | `makeVehicleSetManualDepartureCmd(v, bool)` | `vehicle_manual_departure` | EASY |
| Change line (and go to stop n) | `makeVehicleSetLineCmd(v, line, stopIndex)` | `vehicle_set_line {vehicle, line, stop}` | EASY — check carrier compatibility with `line.isLineCompatibleWithCarrier` first |
| Remove from line | `makeVehicleSetLineCmd(v, -1, 0)` (to verify in game) | | MEDIUM |
| Sell (in depot) | `makeVehicleSellCmd({v,...})` | `vehicle_sell` | RISKY |
| Buy | `makeVehicleBuyCmd(player, depot, TransportVehicleConfig)` | `vehicle_buy {depot, model(s)}` | MEDIUM/RISKY — a `TransportVehicleConfig` must be composed (parts, groups, muFileNames); cloning the config of an existing vehicle is the simple and safe case ("+1 identical on this line") |
| Replace (new model) | `makeVehicleReplaceCmd(v, tvc)` | `vehicle_replace` | MEDIUM/RISKY |
| Modifiers (max speed x, noise x, pollution x, comfort x) | `makeVehicleSetModifiersCmd(v, Modifiers)` | | NO (cheat) |
| Rename | `makeEntitySetNameCmd(v, name)` | `rename_entity {entity, name}` | DONE (mod command; no button yet) |
| Color (livery) | `makeEntitySetColorCmd(e, Vec3f)` | `set_color {entity, r,g,b}` | EASY (works at least for lines; vehicles to test) |

### 4.3 Lines

The `Engine.Component.Line` component contains: `stops : {Stop}` (stationGroup, station, terminal,
alternativeTerminals, loadMode, minWaitingTime, maxWaitingTime, maxAdditionalWaitingTime, waypoints,
stopConfig{load{bool}, maxLoad{0..1}, forceUnload, destroyForConfigChange, destroyForRefresh}),
`vehicleInfo.transportModes`, `customFilters`, `reservationPriority`. Any modification =
`makeLineUpdateCmd(line, lineCopy)`.

| Action | Implementation | Dashboard | Status |
|---|---|---|---|
| Rename | `makeEntitySetNameCmd(line, name)` | `rename_entity` | DONE (mod command; no button yet) |
| Color | `makeEntitySetColorCmd(line, rgb)` | `set_color` | EASY |
| Load mode of a stop (`LOAD_IF_AVAILABLE`, `FULL_LOAD_ANY`, `FULL_LOAD_ALL`; `LEGACY_UNLOAD_ONLY` not offered by the game) | copy LINE (`api.type.Line.new(comp)`), `stops[i].loadMode = ...`, update — same code as `cargofilter_window.tl` | `line_set_stop {line, stop, load_mode}` | **DONE** (line detail -> Stops & departures -> pencil) |
| Min / max / additional waiting time | same, `minWaitingTime` etc. (0..600 s, max = -1 unlimited) | `line_set_stop {..., min_wait, max_wait, max_add_wait}`; `line_set_all_stops` for the whole line | **DONE** |
| Cargo filters per stop (load / do not load) | same, `stopConfig.load[k]` (dense, index = id+1), `customFilters=true` | `line_set_stop {..., no_load=[ids]}` | **DONE** (clickable cargo chips); max share (`maxLoad`): read-only for now |
| Force unload / destroy for reconfig | `stopConfig.forceUnload`, `destroyForConfigChange`, `destroyForRefresh` | `line_set_stop {..., force_unload, destroy_for_config_change, destroy_for_refresh}` | **DONE** ("force unload" checkbox; both "destroy": command only) |
| Remove a stop | remove `stops[i]` then update | `line_stop_remove` | MEDIUM/RISKY (may cut the path) |
| Reorder stops | swap inside `stops` | `line_stops_reorder` | MEDIUM/RISKY (same) |
| Change terminal / alternative terminals | `stops[i].station/terminal` (preferred) + `alternativeTerminals`; terminals listed via `STATION_GROUP.stations[] -> STATION.terminals[]` (type, cargo class, length, modes via `TpNetData`, `checkLineStopForVehicleOverlength`) | `line_set_terminals {line, stop, main={station,terminal}, alternatives=[...]}` | **DONE** ("Terminals" block of the stop editor: checkbox = usable, star = preferred; incompatible terminals shown but marked "slow") |
| Add a stop | build a `Stop` (valid stationGroup + station + terminal) | `line_stop_add` | RISKY — no route preview; **only** on already known stations, and the game may answer "no path" |
| Waypoints | `stops[i].waypoints` (edge/node ids) | | NO from the dashboard (requires clicking in the world) |
| Reservation priority | `reservationPriority` | shown in the line detail | read DONE; write EASY |
| Create a line | `makeLineCreateCmd(name, color, player, Line)` | | RISKY — same limits as adding a stop |
| Delete a line | `makeLineDestroyCmd(line)` | `line_delete` | RISKY (orphan vehicles) |
| Send every vehicle of a line to the depot | loop `makeVehicleSendToDepotCmd` | `line_all_to_depot` | **DONE** (button with confirmation) |
| Stop / restart the whole line | loop `SetStoppedByUser` | `line_stop_all / line_start_all` | **DONE** |
| "+1 identical vehicle" | clone the `TransportVehicleConfig` of a vehicle of the line, `findBestDepotForLine`, `makeVehicleBuyCmd`, then `makeVehicleSetLineCmd` | `line_add_vehicle {line, like=vehicle}` | MEDIUM/RISKY (money) — the most useful "management" action |

### 4.4 Stations, depots, constructions

| Action | Command | Status |
|---|---|---|
| Rename station / depot | `makeEntitySetNameCmd(e, name, forceSameEntity)` | EASY |
| Discard the waiting cargo of a stock | `makeStockListDiscardCargoCmd` | RISKY |
| Force the cargo type of a stock | `makeStockListSetStocksCargoTypeCmd` | NO |
| Build / modify / demolish (stations, tracks, roads, modules) | `makeWorldBuildProposalCmd(proposal, ...)` + `util.proposal.*` | NO from the dashboard: needs a full geometric `Proposal`; that is the game's construction tool |
| Mark as bulldozable / historic | `makeWorldSetBulldozableCmd`, `makeTownBuildingSetBlockedDevelopmentCmd` | NO |

### 4.5 Industries and towns

| Action | Command | Status |
|---|---|---|
| Industry: manual mode (no closing, no auto level) | `makeIndustrySetManualDevelopmentCmd(i, bool)` | EASY but it is cheating -> "sandbox" option in Settings |
| Industry: productivity x | `makeStockListSetModifiersCmd(i, {productivity=n})` | NO (cheat) |
| Industry: cancel closing | `makeIndustrySetDespawnTimeCmd(i, ts)` | NO (cheat) |
| Industry: extend | `makeCreateIndustryExtendProposalCmd` | NO |
| Town: growth on/off | `makeTownSetDevelopmentActiveCmd(town, bool)` | EASY (the game exposes it in the town window -> legitimate) |
| Town: cargo needs, size, capacities, distribution weights | `makeTownUpdateCargoNeedsCmd`, `makeTownUpdateSizeCmd`, `makeTownSetInitialLandUseCapacitiesCmd`, `makeTownCustomDistributionWeightsCmd` | NO (map editor) |
| Town: develop at a point, connect to industries, create/destroy | `makeTownDevelopAtCmd`, `makeTownConnectWithIndustriesCmd`, `makeTownCreateCmd`, `makeTownDestroyCmd` | NO |
| Terrain, players, animals, custom entities, journal, account | `makeWorldReplaceTerrainCmd`, `makeGameAddPlayerCmd`, `makeAnimal*`, `makeCustomEntity*`, `makeJournal*`, `makeMaintenanceCostUpdateCmd`, `makeEntitySetEmissionsCmd`, `makeEntitySetPlayerCmd` | NO |
| Debug (`makeSimPersonSetStateCmd`, `makeStockSetCargoAmountCmd`, `makeComponentExchangeCmd`, `makeClearLogbooksCmd`) | | NO |

### 4.6 Scripting

| Action | Command | Status |
|---|---|---|
| Broadcast an event to all game scripts | `makeScriptingSendEventCmd(src, id, name, param)` | EASY — would let the dashboard talk to other mods (e.g. trigger an action of a third-party mod) |
| Internal GUI script event (`fireGuiScriptEvent`): `management.line/delete`, `vehicleStore/mission.buyVehicle`, `mainView/select`, `entityWindow/locate`, `calendar/onManualTimeChanged` | | NO (unstable internal API; prefer the equivalent `api.cmd`) |

---

## 5. Proposed roadmap (by value / risk)

1. **No risk, big win** — open entity window (`select_entity`), line manager, world marker (`mark`), zone (`zone`),
   "no path" reason and per-stop problems in the line/vehicle sheet, manual departure, rename line/vehicle/station,
   line color, game statistics/finances on the wanted tab, layers (noise, cargo...). *(Done: select_entity, line
   manager, rename, stored camera views `set_camera` (rev 7).)*
2. **Line management without touching the route** — load mode, waiting times, cargo filters per stop, stop/start the
   whole line, send everything to the depot, move a vehicle to another line. *(Done except moving a vehicle.)*
3. **Money (with confirmation + price shown)** — "+1 identical vehicle", sell, replace with the same model new.
4. **Route** — remove/reorder a stop (with a safeguard: refuse if `getDetailedLineProblems` reports a gap afterwards
   -> re-update of the old line = automatic rollback), add a stop on a known station.
5. **Never** — construction, terrain, industry/town cheats, modifiers.

---

## 6. Known pitfalls (verified)

- `getLineCapacityUsages` actually returns a **dense 1-based array** despite the `{CargoTypeId : ...}` declaration:
  cargo id = key - 1 (fixed, `SCHEMA = 2`). Assume the same pitfall for `stopConfig.load/maxLoad`.
- `fireReactEvent` returns nothing: the ack `ok=true` means "sent", not "window opened".
- `app.loadUserdata` logs a warning when the file is missing -> always list with `app.getAllUserdata` first.
- `Engine.Entity` ids are reused: check `api.engine.entityExists(e)` before any command (the mod does).
- Simulation commands from `guiUpdate`: OK; however `api.gui.*` is **unavailable** from the engine-side `update()`.
- `makeVehicleSetLineCmd` with `stopIndex` out of bounds: undocumented behaviour -> clamp on the mod side.
- React events with a wrong name fail **silently**.
- `Industry.upgradeProgress` is always 0 in TF3 (TF2 leftover, not used by the game's own GUI): show level/max instead.
