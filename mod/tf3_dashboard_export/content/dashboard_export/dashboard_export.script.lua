-- Dashboard Export : periodically writes a snapshot of the game state to
--   <userdata>\dashboard_export\live.lua          (fast: time, finance, alerts, moving vehicle data; every 1-10 s)
--   <userdata>\dashboard_export\slow_<section>.lua (lines, stations, towns, industries, depots, static vehicle data,
--                                                   company, cargo types; every 10-120 s, one file per frame)
-- via app.saveUserdata, for an external dashboard / collector (second monitor).
--
-- Why two kinds of files (rev 6): app.saveUserdata serialises and writes the whole table in the calling frame.
-- Up to rev 5 everything went into live.lua, i.e. ~300 KB rewritten every second on a mid-size map, of which 90 %
-- (lines with their terminals, industries, towns...) only changes every slow cycle. That cost 20 ms per second on a
-- fast machine and a visible stutter every second on slower ones. Now live.lua is ~30 KB and the big sections are
-- written only when they were re-collected, spread over several frames.
--
-- Everything runs on the GUI thread (guiUpdate): the GUI state has read access to the whole
-- engine state, "app" is available there, and nothing is stored in the savegame.
-- Every section is wrapped in pcall: a failing section is reported in snapshot.errors and the
-- rest of the snapshot is still written. Read-only: no api.cmd is ever sent.

local MOD_ID = "tf3_dashboard_export"
-- 2: line capacity cargo ids fixed (dense array was read 1-based => off by one); 3: towns.supply;
-- 4: slow sections in separate slow_*.lua files, static vehicle fields moved to slow_vehicles (collector >= 0.2.0)
-- 5: snapshot.camera {x, y, dist, angle, pitch, follow} + set_camera command (rev 7, companion >= 0.3.0 for the views panel)
-- 7: files moved to towns_industries/tf3dash_* (rev 9, game build 40420 whitelist; companion >= 0.3.2 reads both layouts)
-- 6: vehicles[].cargo {cargo id = count on board}, slow vehicles[].capacities {cargo id = capacity}, horn command, company.headquarterId/X/Y (rev 8, companion >= 0.3.1)
local SCHEMA = 7
-- Build 40420 (8 Oct 2026) restricted app.saveUserdata to three userdata folders: heightmaps, mod_presets and
-- towns_industries ("The directory you trying to access is not available or invalid" for any other). Up to rev 8 the
-- export lived in its own dashboard_export folder. towns_industries is the least visible of the three (only the map
-- editor lists it), so the files go there with a tf3dash_ prefix so that they are never mistaken for anything else.
local DIR = "towns_industries"
local PREFIX = "tf3dash_"
local FILE = PREFIX .. "live"
local SLOW_FILE_PREFIX = PREFIX .. "slow_"
-- The slow sections (lines, stations, towns, industries, depots) are collected one item per step, a few steps per
-- frame, so that a slow cycle never stalls the game: this is the CPU budget per guiUpdate call, in seconds.
-- A step is started only while the budget is not exhausted, so a frame costs at most budget + one step.
local SLOW_BUDGET = 0.002

-- ---------------------------------------------------------------- params
local PARAM_VALUES = {
	interval_fast = { 1, 2, 5, 10 },
	interval_slow = { 10, 30, 60, 120 },
	export_vehicles = { true, false },
	accept_commands = { false, true }, -- off by default (rev 2): the player opts in to remote control
	debug_log = { false, true },
}
local PARAM_DEFAULT_INDEX = { interval_fast = 2, interval_slow = 2, export_vehicles = 1, accept_commands = 1, debug_log = 1 }
local CMD_FILE = PREFIX .. "cmd"

-- Settings are the mod parameters chosen when the game was loaded (api.engine.config.getModParams, read-only during
-- the game). The status window shows them, it does not change them.
local cachedOptions
local function options()
	if cachedOptions then return cachedOptions end
	local ok, all = pcall(api.engine.config.getModParams)
	local raw = (ok and all and all[MOD_ID]) or {}
	local o = {}
	for key, values in pairs(PARAM_VALUES) do
		local r = raw[key]
		local v
		-- Every param comes back as a 1-based index into its values, sliders included (seen in stdout.txt at load:
		-- "interval_fast = 1, accept_commands = 2"). Up to rev 8 the code matched the value first, which happened
		-- to work for the first slider position only.
		if type(r) == "number" then v = values[math.floor(r)] end
		if v == nil then v = values[PARAM_DEFAULT_INDEX[key]] end
		o[key] = v
	end
	if ok and all then cachedOptions = o end
	return o
end

-- what the status window shows: "starting" (first slow cycle running), "ok" (files written), "error" (saveUserdata
-- refused: Controlled folder access, antivirus, read-only folder...). The React side is told only when it changes.
local status = { state = "starting", last_ok = nil, last_error = nil, companion_seen = nil, folder = nil }
local STATUS_EVENT = "TF3DashboardStatus"
local STATUS_TICK = 2.0  -- the open status window re-reads on this event ("x s ago", companion seen); a timer on the
local lastStatusTick = -1e9  -- React side cannot read gui script state (build 40420: "API is currently restricted")
local function setStatus(state, err)
	local now = os.time()
	if state == "ok" then status.last_ok = now
	elseif state == "error" then status.last_error = tostring(err) end
	if status.state ~= state then
		status.state = state
		pcall(api.gui.fireReactEvent, STATUS_EVENT, { state = state })
	end
end
local function statusTick(now)
	if now - lastStatusTick < STATUS_TICK then return end
	lastStatusTick = now
	pcall(api.gui.fireReactEvent, STATUS_EVENT, { state = status.state })
end

local function log(...)
	print("[dashboard_export]", ...)
end
local function debug(...)
	if options().debug_log then log(...) end
end

-- ---------------------------------------------------------------- helpers
local function num(x)
	if type(x) == "number" then return x end
	return tonumber(x)
end

local function vec2(v)
	if v == nil then return nil end
	local ok, x, y = pcall(function() return v.x, v.y end)
	if ok and x then return { x = num(x), y = num(y) } end
	ok, x, y = pcall(function() return v[1], v[2] end)
	if ok and x then return { x = num(x), y = num(y) } end
	return nil
end

local function vec3(v)
	if v == nil then return nil end
	local ok, x, y, z = pcall(function() return v.x, v.y, v.z end)
	if ok and x then return { x = num(x), y = num(y), z = num(z) } end
	return nil
end

local function entityName(e)
	local ok, n = pcall(api.engine.util.getEntityName, e)
	if ok and type(n) == "string" then return n end
	return ""
end

local function arr(t)
	-- copy a possibly userdata-backed sequence into a plain array
	local out = {}
	if t == nil then return out end
	local ok = pcall(function()
		for i = 1, #t do out[#out + 1] = t[i] end
	end)
	if not ok or #out == 0 then
		pcall(function()
			for _, v in pairs(t) do out[#out + 1] = v end
		end)
	end
	return out
end

local function count(t)
	local ok, n = pcall(function() return #t end)
	if ok and n then return n end
	n = 0
	pcall(function() for _ in pairs(t) do n = n + 1 end end)
	return n
end

-- enum name lookup built lazily (values are opaque, compare by equality)
local enumCache = {}
local function enumName(enumKey, names, value)
	local map = enumCache[enumKey]
	if not map then
		map = {}
		local e = api.type.enum[enumKey]
		for _, n in ipairs(names) do
			local ok, v = pcall(function() return e[n] end)
			if ok and v ~= nil then map[#map + 1] = { v, n } end
		end
		enumCache[enumKey] = map
	end
	for _, p in ipairs(map) do
		if p[1] == value then return p[2] end
	end
	return tostring(value)
end
local CARRIERS = { "ROAD", "RAIL", "TRAM", "AIR", "WATER", "OTHER" }
local VSTATES = { "IN_DEPOT", "EN_ROUTE", "AT_TERMINAL", "GOING_TO_DEPOT" }
local ICON_TYPES = { "Bus", "Truck", "TrainSteam", "TrainElectric", "TrainDiesel", "Tram", "Aircraft", "Helicopter", "Ship" }

-- vehicle icon type (same classification as the game's HUD: bus/truck/train steam-electric-diesel/tram/plane/heli/ship)
local function vehicleIconType(v)
	local ok, t = pcall(api.engine.util.vehicle.getVehicleType, v)
	if not ok or t == nil then ok, t = pcall(api.engine.util.getVehicleType, v) end
	if ok and t ~= nil then
		local n = enumName("VehicleIconType", ICON_TYPES, t)
		if n and not n:match("^%-?%d") and n ~= "nil" and n ~= "userdata" then return n end
		-- enum may be a plain integer: map by index (0-based in the API order above)
		local i = num(t)
		if i and ICON_TYPES[i + 1] then return ICON_TYPES[i + 1] end
	end
	return nil
end

-- current UI language of the game ("fr", "de", "en", "zh_CN", ...)
-- Re-read on every slow cycle (the player can switch language in the settings without restarting),
-- cached in between because it is called on every fast snapshot.
local langCache
local function gameLanguage(refresh)
	if langCache and not refresh then return langCache end
	local ok, code = pcall(function() return app.getUserProfile():getLanguage().code end)
	if ok and type(code) == "string" and code ~= "" then langCache = code; return code end
	ok, code = pcall(function() local l = api.util.getLanguage(); return l and (l.code or l.lang or l[1]) end)
	if ok and type(code) == "string" and code ~= "" then langCache = code; return code end
	return langCache
end

local function section(snapshot, name, fn)
	local ok, res = pcall(fn)
	if ok then
		snapshot[name] = res
	else
		snapshot.errors[#snapshot.errors + 1] = { section = name, error = tostring(res) }
		debug("section failed:", name, tostring(res))
	end
end

-- ---------------------------------------------------------------- collectors
local function collectTime()
	local world = api.engine.util.getWorld()
	local gt = api.engine.getComponent(world, api.type.ComponentType.GAME_TIME)
	local gs = api.engine.getComponent(world, api.type.ComponentType.GAME_SPEED)
	local t = { game_time_ms = num(gt and gt.gameTime), tick = num(gt and gt.tickCount), update_count = num(gt and gt.updateCount),
		time_of_day_sec = num(gt and gt.timeOfDaySec), speed = num(gs and gs.speedup), millis_per_day = num(gs and gs.millisPerDay) }
	local ok, d = pcall(api.engine.util.getCalendarDate, t.game_time_ms or 0)
	if ok and d then t.year, t.month, t.day = num(d.year), num(d.month), num(d.day) end
	if not t.year then local ok2, y = pcall(api.engine.util.getYear); if ok2 then t.year = num(y) end end
	t.lang = gameLanguage()
	return t
end

local function collectFinance(player)
	local acc = api.engine.getComponent(player, api.type.ComponentType.ACCOUNT)
	local f = { balance = num(acc and acc.balance), loan = num(acc and acc.loan) }
	local ok, v = pcall(api.engine.util.finance.calculateEarnings, player); if ok then f.earnings_year_to_date = num(v) end
	ok, v = pcall(api.engine.util.finance.getPlayersBalance, player); if ok then f.bank_balance = num(v) end
	ok, v = pcall(api.engine.util.headquarters.getTransportedData)
	if ok and v then f.passengers_transported = num(v.passengersTransported); f.cargo_transported = num(v.cargoTransported) end
	return f
end

-- ---------------------------------------------------------------- finance journal (rev 13)
-- The game keeps the complete accounting journal in the save game. Instead of rebuilding the past from live
-- snapshots, the mod asks the engine for the table behind the Finances window
-- (api.engine.util.finance.computeFinanceTable). The engine chooses the columns itself (fine for the recent past,
-- coarser further back, whatever interval/count say: these only bound the span), so two views are exported:
--   "window"  : the game's default ChartConfig = exactly the columns the Finances window shows (4 to 20)
--   "history" : interval = 1 game year, count = years since 1850 -> every column since the start of the game
-- Each column comes with the engine's own header ("9/87 - 11/87", "1988 - 1989", "16/3/90 - 31/3/90") which the
-- dashboard parses for the period bounds. Written to tf3dash_journal.lua once per game month (or after a save game
-- reload); measured cost on a 70-year game: 2-12 ms per table.
local JOURNAL_FILE = PREFIX .. "journal"
local JOURNAL_YEAR_MS = 365 * 4 * 1000  -- the financial year is 365 days of 4 s of simulation, whatever the calendar
local JOURNAL_MONTH_MS = JOURNAL_YEAR_MS / 12
local journalLastPeriod, journalLastGameTime, journalDumped = nil, nil, false

-- The journal enums (JournalEntry.Type/Maintenance/Construction) are integers behind userdata without names; keys
-- are exported as "type/maintenance/construction" numbers (carrier: 0 road, 1 rail, 2 tram, 3 other, 4 air,
-- 5 water) and named on the dashboard side, where the mapping was checked line by line against the Finances window.
local function journalKeyPart(v)
	if v == nil then return "-" end
	local n = tonumber(v) or tonumber(tostring(v))
	return n and tostring(n) or tostring(v)
end

local function journalTable(player, cfg)
	local fd = api.engine.util.finance.computeFinanceTable(player, cfg)
	local out = { periods = {}, transport = {}, other = {}, investment = {} }
	for i, h in ipairs(fd.header or {}) do out.periods[i] = tostring(h) end
	local n = #out.periods
	local function rowOf(v) local r = {}; for i = 1, n do r[i] = num(v[i]) or 0 end; return r end
	local function keyOf(typeKey)
		local okU, u = pcall(fd.unfoldKey, fd, typeKey)
		if okU and u then return journalKeyPart(u[1]) .. "/" .. journalKeyPart(u[2]) .. "/" .. journalKeyPart(u[3]) end
		return tostring(typeKey)
	end
	for _, key in ipairs({ "loan", "interest", "loanBorrowing", "loanRepayment", "total", "balance" }) do
		local v = fd[key]
		if type(v) == "table" or type(v) == "userdata" then out[key] = rowOf(v) end
	end
	fd:foreach_carrier(function(carrier, byType)
		local c = {}
		for typeKey, row in pairs(byType) do c[keyOf(typeKey)] = rowOf(row) end
		out.transport[journalKeyPart(carrier)] = c
	end)
	fd:foreach_other(function(kind, row) out.other[journalKeyPart(kind)] = rowOf(row) end)
	pcall(fd.foreach_investment, fd, function(key, row) out.investment[keyOf(key)] = rowOf(row) end)
	out.count = n
	return out
end

local function collectJournal(player, gameTimeMs)
	local t0 = os.clock()
	local out = { game_time_ms = gameTimeMs }
	local okY, year = pcall(api.engine.util.getYear)
	out.year = okY and num(year) or nil
	-- the game's own columns
	out.window = journalTable(player, api.type.ChartConfig.new())
	-- every column since the start of the game
	local cfg = api.type.ChartConfig.new()
	cfg.interval = JOURNAL_YEAR_MS
	cfg.count = math.max(1, math.floor(gameTimeMs / JOURNAL_YEAR_MS) + 2)
	out.history = journalTable(player, cfg)
	out.duration_ms = (os.clock() - t0) * 1000
	if not journalDumped and options().debug_log then
		journalDumped = true
		log(string.format("journal: window %d cols, history %d cols (%s .. %s), %.0fms, year %s", out.window.count, out.history.count,
			tostring(out.history.periods[1]), tostring(out.history.periods[out.history.count]), out.duration_ms, tostring(out.year)))
	end
	return out
end

local function journalWriteIfDue(player, gameTimeMs)
	if gameTimeMs == nil then return false end
	local period = math.floor(gameTimeMs / JOURNAL_MONTH_MS)
	if journalLastPeriod == period and journalLastGameTime ~= nil and gameTimeMs >= journalLastGameTime then return false end
	local ok, j = pcall(collectJournal, player, gameTimeMs)
	if not ok then log("journal collection failed:", tostring(j)); journalLastPeriod = period; journalLastGameTime = gameTimeMs; return false end
	local t0 = os.clock()
	local okW, err = pcall(app.saveUserdata, DIR, JOURNAL_FILE, { schema = SCHEMA, mod = MOD_ID, real_time = os.time(), journal = j })
	if not okW then log("saveUserdata failed for journal:", tostring(err)); return false end
	journalLastPeriod, journalLastGameTime = period, gameTimeMs
	debug(string.format("journal written: window %d + history %d cols, collected in %.0fms, saved in %.0fms", j.window.count, j.history.count, j.duration_ms, (os.clock() - t0) * 1000))
	return true
end
-- the player's headquarters (construction with company metadata headquarters = true): its position on the map.
-- Looked up once and kept: the headquarters cannot be removed, so the scan only runs again while none was found.
local hqPos
local function collectHeadquarterPos()
	if hqPos and api.engine.entityExists(hqPos.id) then return hqPos end
	local pos
	pcall(function()
		api.engine.system.streetConnectorSystem.forEachConstructionWithMetadata("company", true, false,
			function(entity, con, conId)
				if pos or not con or not con.transf or not conId or conId < 0 then return end
				local desc = api.res.constructionRep.get(conId)
				local meta = desc and desc.metadata and desc.metadata.company
				if meta and meta.headquarters then pos = { id = entity, x = num(con.transf[13]), y = num(con.transf[14]) } end
			end, true)
	end)
	hqPos = pos
	return pos
end

local function collectCompany()
	local cv = api.engine.util.headquarters.getCompaniesValue()
	local keys = { "totalScore", "railVehicles", "trams", "roadVehicles", "aircrafts", "ships", "trackTotalLength", "trackElectricLength",
		"bridgeTotalLength", "tunnelTotalLength", "roadTotalLength", "suppliedTowns", "connectedIndustries", "numberOfLines", "totalStations",
		"railStations", "tramStations", "roadStations", "aircraftStations", "shipStations", "topSpeed", "topLength", "oldestTransportVehicle",
		"balance", "totalAssets", "debt" }
	local out = {}
	for _, k in ipairs(keys) do out[k] = num(cv[k]) end
	local hq = collectHeadquarterPos()
	if hq then out.headquarterId, out.headquarterX, out.headquarterY = hq.id, hq.x, hq.y end
	return out
end

local function collectAlerts(player)
	local a = { line_problems = {}, vehicle_problems = {}, blocked_trains = {}, no_path_vehicles = {}, town_problems = {},
		closing_industries = {}, thrown_away_cargo = {} }
	pcall(function()
		for _, p in ipairs(arr(api.engine.util.line.getLineProblems())) do
			local loc = p[3]
			a.line_problems[#a.line_problems + 1] = { line = p[1], type = num(p[2]), pos = loc and vec3(loc.nodePosition) or nil }
		end
	end)
	pcall(function()
		for _, p in ipairs(arr(api.engine.util.vehicle.getVehicleProblems())) do
			a.vehicle_problems[#a.vehicle_problems + 1] = { vehicles = arr(p[1]), type = num(p[2]) }
		end
	end)
	pcall(function()
		for _, p in ipairs(arr(api.engine.system.landVehicleMoveSystem.getBlockedTrains())) do
			a.blocked_trains[#a.blocked_trains + 1] = { train = p[1], blocked_by = p[2] }
		end
	end)
	pcall(function() a.no_path_vehicles = arr(api.engine.system.transportVehicleSystem.getNoPathVehicles()) end)
	pcall(function()
		for _, p in ipairs(arr(api.engine.util.town.getTownProblems())) do
			a.town_problems[#a.town_problems + 1] = { towns = arr(p[1]), type = num(p[2]) }
		end
	end)
	pcall(function()
		for _, p in ipairs(arr(api.engine.util.industry.getClosingIndustries())) do
			a.closing_industries[#a.closing_industries + 1] = { industry = p[1], name = entityName(p[1]) }
		end
	end)
	pcall(function()
		for e, n in pairs(api.engine.util.stock.getStockListsWithThrownAwayCargo()) do
			a.thrown_away_cargo[#a.thrown_away_cargo + 1] = { stock_list = e, amount = num(n) }
		end
	end)
	pcall(function()
		local issues = api.engine.util.line.getLinesIssues(player, false)
		a.line_issues = {}
		for line, list in pairs(issues) do
			for _, is in ipairs(arr(list)) do
				a.line_issues[#a.line_issues + 1] = { line = line, type = num(is.type), stop = num(is.stopIndex), cargo_type = num(is.cargoType) }
			end
		end
	end)
	return a
end

-- "vehicle/train/alco_hh600.mdl" -> "train/alco_hh600" (matches dashboard/static/icons/vehicles/<key>.png).
-- Resource names are static for the whole session, so the result is cached per model id.
local modelKeyCache = {}
local function modelKey(modelId)
	local id = num(modelId)
	if not id then return nil end
	local k = modelKeyCache[id]
	if k ~= nil then return k or nil end
	local ok, name = pcall(api.res.modelRep.getName, id)
	if ok and type(name) == "string" and name ~= "" then
		-- resource names look like "vehicle/<category>/<folder>/<stem>.mdl" (base game and DLC) ; mods may use
		-- other prefixes but keep the "<category>/<folder>/<stem>.mdl" tail -> export "<category>/<stem>"
		local segs = {}
		for s in name:gsub("%.mdl$", ""):gmatch("[^/]+") do segs[#segs + 1] = s end
		local cat = nil
		for i = 1, #segs - 1 do
			local s = segs[i]
			if s == "bus" or s == "truck" or s == "tram" or s == "train" or s == "waggon" or s == "plane" or s == "helicopter" or s == "zeppelin" or s == "ship" or s == "car" then cat = s end
		end
		k = (cat or (segs[#segs - 1] or "other")) .. "/" .. segs[#segs]
	else
		k = false
	end
	modelKeyCache[id] = k
	return k or nil
end

-- Vehicles are exported in two parts (rev 6). Fast (every snapshot, live.lua): what moves â€” state, line, stop,
-- position, speed, load, maintenance... Slow (slow_vehicles.lua, one item per step like the other slow sections):
-- what the game only changes when the player edits the vehicle â€” name, consist, model, capacity, icon, costs. The
-- collector merges both on vehicle id. Before rev 6 all of it was fetched and written every second.
local function collectVehicles()
	local out = {}
	local sys = api.engine.system
	for _, v in ipairs(arr(api.engine.util.vehicle.getVehicles())) do
		local tv = api.engine.getComponent(v, api.type.ComponentType.TRANSPORT_VEHICLE)
		if tv then
			local rec = { id = v, state = enumName("TransportVehicleState", VSTATES, tv.state), line = num(tv.line), stop_index = num(tv.stopIndex),
				user_stopped = tv.userStopped and true or false, no_path = tv.noPath and true or false, depot = num(tv.depot),
				days_in_depot = num(tv.daysInDepot), days_at_terminal = num(tv.daysAtTerminal), doors_open = tv.doorsOpen and true or false }
			pcall(function() rec.speed = num(api.engine.util.vehicle.getSpeed(v)) end)
			pcall(function() rec.pos = vec3(api.engine.util.vehicle.getPosition(v)) end)
			-- load = items on board; cargo = the same split by cargo type (what the game draws above the wagons),
			-- only the non-zero types: { [cargo id] = count }. Like getLineCapacityUsages, the engine returns a dense
			-- array over all cargo types (Lua 1-based: key k = cargo type k-1) unless a key 0 is present.
			pcall(function()
				local per = api.engine.util.cargo.getNumCargoPerTypeInVehicle(v)
				local total, by, dense = 0, {}, per[0] == nil
				for k, n in pairs(per) do
					local c = num(n) or 0
					if c > 0 then
						total = total + c
						local ct = dense and (num(k) - 1) or num(k)
						if ct then by[tostring(ct)] = c end
					end
				end
				rec.load = total
				if next(by) then rec.cargo = by end
			end)
			if rec.load == nil then
				local okL, loadN = pcall(sys.simEntityAtVehicleSystem.getVehicleSimEntitiesCount, v)
				if okL and num(loadN) then rec.load = num(loadN) end
			end
			pcall(function() rec.maintenance = num(api.engine.util.vehicle.getVehicleMaintenanceState(v)) end)
			pcall(function() rec.closest_town = num(tv.closestTown) end)
			out[#out + 1] = rec
		end
	end
	return out
end

-- ---------------------------------------------------------------- line paths (rev 11)
-- Where a line really runs: the game keeps, for every vehicle, the series of network edges it is following to its
-- next stop (MOVE_PATH.path.edges = {{EdgeId{entity, index}, dir}}). Collected with the slow vehicles section (one
-- vehicle per step, a table of ids, no geometry); the edges' entities are the BASE_EDGE segments exported in the
-- geography, so the dashboard draws the line along them. Per (line, leg = stop the vehicle is heading to) the
-- longest sequence seen is kept (a vehicle just departed holds the whole leg; later it holds the remainder), and a
-- leg is replaced only by a sequence that starts and ends elsewhere (the player rerouted). Legs survive across cycles,
-- so a few minutes of game give the whole line once each leg was driven once; written in slow_line_paths.lua.
local linePaths = {}      -- line id -> { [leg] = { edges = {ids}, n = count, seen = os.time() } }
local linePathsDirty = false
local LINE_PATH_MAX_EDGES = 3000

local linePathProbe = 3  -- debug: describe the first few MOVE_PATH shapes seen (the API docs and the Lua view differ)
-- an edge entry of MovePath.path.edges is {EdgeId, dir}; EdgeId = {entity, index}. Seen through Lua the pair may be
-- an array {id, dir}, a record {edgeId = ..., dir = ...} or the EdgeId itself: try all of them.
local function pathEdgeEntity(e)
	if e == nil then return nil end
	local ok, id = pcall(function()
		local eid = e[1] ~= nil and e[1] or e.edgeId or e
		return num(eid.entity) or num(eid[1])
	end)
	if ok and id and id > 0 then return id end
	return nil
end

local function vehiclePathItem(v, tv)
	local okP, mp = pcall(api.engine.getComponent, v, api.type.ComponentType.MOVE_PATH)
	if not okP or not mp then
		if linePathProbe > 0 then linePathProbe = linePathProbe - 1; debug("line paths: MOVE_PATH of vehicle " .. tostring(v) .. ": " .. (okP and "nil" or tostring(mp))) end
		return
	end
	local line, leg = num(tv.line), num(tv.stopIndex)
	if not line or line <= 0 or leg == nil then return end
	local okE, raw = pcall(function() return arr(mp.path.edges) end)
	if not okE or #raw == 0 then
		if linePathProbe > 0 then linePathProbe = linePathProbe - 1; debug("line paths: vehicle " .. tostring(v) .. " path.edges: " .. (okE and ("empty, path=" .. tostring(mp.path)) or tostring(raw))) end
		return
	end
	local edges = {}
	local last = nil
	for _, e in ipairs(raw) do
		local id = pathEdgeEntity(e)
		if id and id ~= last then edges[#edges + 1] = id; last = id end
		if #edges >= LINE_PATH_MAX_EDGES then break end
	end
	if linePathProbe > 0 then
		linePathProbe = linePathProbe - 1
		local e1 = raw[1]
		local desc = type(e1)
		pcall(function() desc = desc .. " e1[1]=" .. tostring(e1[1]) .. " e1[2]=" .. tostring(e1[2]) .. " .edgeId=" .. tostring(e1.edgeId) .. " .entity=" .. tostring(e1.entity) end)
		pcall(function() if e1[1] ~= nil then desc = desc .. " e1[1].entity=" .. tostring(e1[1].entity) .. " e1[1].index=" .. tostring(e1[1].index) end end)
		debug(string.format("line paths: vehicle %s line %s leg %s: %d raw edges -> %d ids; first entry: %s", tostring(v), tostring(line), tostring(leg), #raw, #edges, desc))
	end
	if #edges < 2 then return end
	local legs = linePaths[line]
	if not legs then legs = {}; linePaths[line] = legs end
	local cur = legs[leg]
	-- keep the longest; a sequence whose last edge differs from the stored one means the leg changed (new route)
	if cur == nil or #edges > cur.n or cur.edges[cur.n] ~= edges[#edges] then
		legs[leg] = { edges = edges, n = #edges, seen = os.time() }
		linePathsDirty = true
	end
end

-- the file: one record per line, legs in stop order, each a flat list of edge entity ids
local function linePathsExport()
	local out = {}
	for line, legs in pairs(linePaths) do
		local rec = { line = line, legs = {} }
		for leg, d in pairs(legs) do rec.legs[#rec.legs + 1] = { stop = leg, edges = d.edges } end
		table.sort(rec.legs, function(a, b) return a.stop < b.stop end)
		out[#out + 1] = rec
	end
	return out
end

local function vehiclesBegin()
	-- forget the legs of lines that no longer exist
	local alive = {}
	for _, l in ipairs(arr(api.engine.system.lineSystem.getLines())) do alive[num(l)] = true end
	for line in pairs(linePaths) do if not alive[line] then linePaths[line] = nil; linePathsDirty = true end end
	return arr(api.engine.util.vehicle.getVehicles()), {}
end

local function vehicleStaticItem(v)
	local tv = api.engine.getComponent(v, api.type.ComponentType.TRANSPORT_VEHICLE)
	if not tv then return nil end
	local rec = { id = v, name = entityName(v), carrier = enumName("Carrier", CARRIERS, tv.carrier) }
	pcall(vehiclePathItem, v, tv)
	pcall(function() rec.icon_type = vehicleIconType(v) end)
	pcall(function()
		-- localized model name of the leading part (e.g. "Mercedes-Benz O303")
		local part = tv.transportVehicleConfig.vehicles[1]
		local model = api.res.modelRep.get(part.part.modelId)
		local d = model and model.metadata and model.metadata.description
		if d and d.name and d.name ~= "" then rec.model = d.name end
	end)
	pcall(function()
		-- language-neutral model keys of every part ("train/alco_hh600", "waggon/bilevel"...) for icons;
		-- parts are in consist order, "-" prefix marks a reversed part
		local parts = {}
		for i, p in ipairs(arr(tv.transportVehicleConfig.vehicles)) do
			local k = modelKey(p.part.modelId)
			if k then parts[#parts + 1] = (p.part.reversed and "-" or "") .. k end
		end
		if #parts > 0 then rec.model_key = parts[1]:gsub("^%-", ""); rec.parts = table.concat(parts, ",") end
	end)
	pcall(function() rec.running_cost = num(api.engine.util.vehicle.getRunningCost(v)) end)
	pcall(function() rec.value = num(api.engine.util.vehicle.getDepreciatedValue(v)) end)
	pcall(function()
		-- capacity = seats/slots in total; capacities = the same per cargo type the vehicle can carry (what the player
		-- bought it for): { ["<cargo id>"] = capacity }. Dense array over all cargo types, Lua 1-based (see collectVehicles).
		local caps = api.engine.util.vehicle.getVehicleCapacities(v)
		local total, by, dense = 0, {}, caps[0] == nil
		for k, c in pairs(caps) do
			local n = num(c) or 0
			if n > 0 then
				total = total + n
				local ct = dense and (num(k) - 1) or num(k)
				if ct then by[tostring(ct)] = n end
			end
		end
		rec.capacity = total
		if next(by) then rec.capacities = by end
	end)
	return rec
end

-- ---------------------------------------------------------------- terminals of a station group
-- Same data the game's "Terminals for Stop N" panel shows (gui/line_vehicle_mgmt/line_manager_panel.tl):
-- every terminal of every station in the group, numbered 1..N continuously, with its type (passengers / cargo /
-- cargo class specialisation), length and transport modes. Per line we add: compatible (the line's transport modes
-- can use the terminal's edge), speed_mod (loading speed factor for the cargo the line carries: >1 specialised,
-- 0.25 specialisations don't match, nil neutral) and overlength (checkLineStopForVehicleOverlength).
local IncompatibilityModifier = 0.25  -- cargo_react_util.tl

local function cargoClassesOf(cargoIds)
	local classes = {}
	for _, id in ipairs(cargoIds) do
		pcall(function()
			local ct = api.res.cargoTypeRep.get(id)
			for _, c in ipairs(arr(ct.cargoClasses)) do classes[tostring(c)] = true end
		end)
	end
	return classes
end

local function terminalsOfGroup(groupEntity, lineModes, lineCargoClasses, tpNet)
	local out = {}
	local sg = api.engine.getComponent(groupEntity, api.type.ComponentType.STATION_GROUP)
	if not sg then return out end
	local n = 0
	for si, stationEntity in ipairs(arr(sg.stations)) do
		local station = api.engine.getComponent(stationEntity, api.type.ComponentType.STATION)
		for ti, term in ipairs(arr(station and station.terminals or {})) do
			n = n + 1
			local rec = { n = n, station = si - 1, terminal = ti - 1 }
			pcall(function()
				rec.pax = (term.passengersLoad or term.passengersUnload) and true or false
				rec.cargo = (term.cargoLoad or term.cargoUnload) and true or false
			end)
			pcall(function()
				-- specialisation: last cargo class included by any transfer-speed section (as the game does), plus the
				-- loading speed factor for the line's cargo classes (max over matching sections)
				local length, spec, best, anySection = 0, nil, nil, false
				for _, ts in ipairs(arr(term.cargoTransferSpeeds)) do
					anySection = true
					if num(ts.length) and num(ts.length) > length then length = num(ts.length) end
					local incl = arr(ts.cargoTypeSet and ts.cargoTypeSet.cargoClassesIncluded or {})
					for _, c in ipairs(incl) do
						spec = tostring(c)
						if lineCargoClasses[spec] or spec == "UNIVERSAL" then
							local m = num(ts.loadSpeedModifier) or 1
							if best == nil or m > best then best = m end
						end
					end
				end
				rec.length = length
				rec.class = spec
				if spec and spec ~= "UNIVERSAL" and spec ~= "PASSENGERS" then
					pcall(function()
						local cid = api.res.cargoClassRep.getCargoClassId(spec)
						if cid and cid ~= -1 then
							local cc = api.res.cargoClassRep.get(cid)
							rec.class_name = cc.name
							rec.class_color = vec3(cc.color)
						end
					end)
				end
				if anySection and rec.cargo and next(lineCargoClasses) then
					if best == nil then rec.speed_mod = IncompatibilityModifier
					elseif math.abs(best - 1) > 0.001 then rec.speed_mod = best end
				end
			end)
			pcall(function()
				-- transport modes usable on the terminal's edge vs the line's modes (line_util.isLineCompatibleWithTransportMode)
				if tpNet == nil then return end
				local nd = tpNet:getNodeData(term.vehicleNodeId)
				local edgeId = nd.ports[1].edgeId
				local tn = api.engine.getComponent(edgeId.entity, api.type.ComponentType.TRANSPORT_NETWORK)
				local edgeModes = tn.edges[edgeId.index + 1].transportModes
				local ok = false
				for m, on in pairs(lineModes) do if on and edgeModes[m] then ok = true end end
				rec.compatible = ok
			end)
			out[#out + 1] = rec
		end
	end
	return out
end

-- Each slow section is split in two: a "begin" that lists the items and fetches the shared maps once, and an
-- "item" function called for one entity at a time by the time-sliced driver (see slowJob below).
local function linesBegin(player, cargoNames)
	local ctx = { names = cargoNames }
	pcall(function() ctx.tpNet = api.engine.system.transportNetworkSystem.getTpNetData() end)
	return arr(api.engine.system.lineSystem.getLinesForPlayer(player)), ctx
end

local function lineItem(l, ctx)
	local sys = api.engine.system
	local cargoNames = ctx.names
	do
		local line = api.engine.getComponent(l, api.type.ComponentType.LINE)
		local rec = { id = l, name = entityName(l), stops = line and count(line.stops) or 0 }
		pcall(function() local c = api.engine.getComponent(l, api.type.ComponentType.COLOR); if c then rec.color = vec3(c.color) end end)
		pcall(function() rec.vehicles = count(sys.transportVehicleSystem.getLineVehicles(l)) end)
		pcall(function() rec.max_frequency = num(api.engine.util.line.getMaxFrequency(l)) end)
		pcall(function() rec.throughput = num(api.engine.util.line.calcLineStationThroughput(l)) end)
		pcall(function()
			local q = api.engine.util.cargo.getSummarizedCargoQualityDataForLine(l)
			rec.quality = { pax_bad = num(q.passengers.countBad), pax_total = num(q.passengers.countTotal), pax_avg = num(q.passengers.averageQuality),
				cargo_bad = num(q.cargo.countBad), cargo_total = num(q.cargo.countTotal), cargo_avg = num(q.cargo.averageQuality) }
		end)
		pcall(function()
			rec.capacity = {}
			-- The engine returns a dense array over all cargo types (one entry per CargoTypeId, 0-based),
			-- which Lua exposes 1-based: key k = cargo type k-1. Only when a key 0 is present is it a real id map.
			local usages = api.engine.util.line.getLineCapacityUsages(l, false)
			local n, dense = 0, usages[0] == nil
			for k in pairs(usages) do n = n + 1; if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then dense = false end end
			dense = dense and n > 0 and usages[n] ~= nil  -- keys are exactly 1..n => array form
			for k, u in pairs(usages) do
				local ct = dense and (num(k) - 1) or num(k)
				local used, cap = num(u.used), num(u.capacity)
				if ct and ((used or 0) > 0 or (cap or 0) > 0) then
					rec.capacity[#rec.capacity + 1] = { cargo_type = ct, cargo = cargoNames[ct], used = used, capacity = cap }
				end
			end
		end)
		pcall(function() rec.persons_on_line = count(sys.simPersonSystem.getSimPersonsForLine(l)) end)
		pcall(function()
			local modes = {}
			for m, on in pairs(api.engine.util.line.getLineTransportModesUnion(l)) do if on then modes[#modes + 1] = num(m) or tostring(m) end end
			rec.transport_modes = modes
		end)
		pcall(function()
			rec.stop_list = {}
			rec.custom_filters = line.customFilters and true or false
			rec.reservation_priority = num(line.reservationPriority)
			local lineModes = {}
			pcall(function() lineModes = api.engine.util.line.getLineTransportModesUnion(l) end)
			local lineCargoIds = {}
			for _, c in ipairs(rec.capacity or {}) do if c.cargo_type then lineCargoIds[#lineCargoIds + 1] = c.cargo_type end end
			local lineClasses = cargoClassesOf(lineCargoIds)
			for i, s in ipairs(arr(line.stops)) do
				local st = { station_group = num(s.stationGroup), station = num(s.station), terminal = num(s.terminal),
					name = entityName(s.stationGroup),
					-- departure configuration (same fields as the game's cargo filter window)
					load_mode = num(s.loadMode),                    -- 0 load if available, 1 full load any, 2 full load all
					min_wait = num(s.minWaitingTime),               -- seconds
					max_wait = num(s.maxWaitingTime),               -- seconds, -1 = unlimited
					max_add_wait = num(s.maxAdditionalWaitingTime), -- seconds
					waypoints = count(s.waypoints) }
				pcall(function()
					local c = s.stopConfig
					st.force_unload = c.forceUnload and true or false
					st.destroy_for_config_change = c.destroyForConfigChange and true or false
					st.destroy_for_refresh = c.destroyForRefresh and true or false
					-- load[] / maxLoad[] are dense arrays over all cargo types (Lua index k = cargo id k-1).
					-- Export only the cargo ids that are NOT loaded (the common case is "everything allowed").
					local blocked = {}
					for k, on in pairs(c.load or {}) do if on == false then blocked[#blocked + 1] = num(k) - 1 end end
					table.sort(blocked)
					st.no_load = blocked
					local limited = {}
					for k, f in pairs(c.maxLoad or {}) do local fr = num(f); if fr and fr < 1 then limited[#limited + 1] = { cargo_type = num(k) - 1, max = fr } end end
					st.max_load = limited
				end)
				pcall(function()
					-- terminals of the station group + which ones this stop may use (main = station/terminal above)
					local alts = {}
					for _, a in ipairs(arr(s.alternativeTerminals)) do alts[#alts + 1] = { station = num(a.station), terminal = num(a.terminal) } end
					st.alternatives = alts
					st.terminals = terminalsOfGroup(s.stationGroup, lineModes, lineClasses, ctx.tpNet)
					local over = {}
					pcall(function()
						for stTerm in pairs(sys.transportVehicleSystem.checkLineStopForVehicleOverlength(l, i - 1)) do
							over[num(stTerm.station) .. ":" .. num(stTerm.terminal)] = true
						end
					end)
					for _, tm in ipairs(st.terminals) do if over[tm.station .. ":" .. tm.terminal] then tm.overlength = true end end
				end)
				rec.stop_list[i] = st
			end
		end)
		return rec
	end
end

local function stationsBegin(player)
	local sys = api.engine.system
	local ctx = { player = player, st2town = {}, st2con = {} }
	pcall(function() ctx.st2town = sys.stationSystem.getStation2TownMap() end)
	pcall(function() ctx.st2con = sys.streetConnectorSystem.getStation2ConstructionMap() end)
	return arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.STATION)), ctx
end

local function stationItem(s, ctx)
	local sys = api.engine.system
	local st2town, st2con, player = ctx.st2town, ctx.st2con, ctx.player
	do
		local owned = api.engine.getComponent(s, api.type.ComponentType.PLAYER_OWNED)
		if owned and owned.player == player then
			local rec = { id = s, name = entityName(s), town = num(st2town[s]) }
			pcall(function() rec.cargo = api.engine.util.station.isStationOfType(s, true) and true or false end)
			pcall(function()
				local u = api.engine.util.station.calculateStationUsage(s)
				rec.used, rec.overflow, rec.pool_capacity, rec.terminal_capacity = num(u.totalUsed), num(u.overflow), num(u.poolCapacity), num(u.terminalCapacity)
			end)
			pcall(function() rec.station_group = num(sys.stationGroupSystem.getStationGroup(s)) end)
			pcall(function() rec.lines = count(sys.lineSystem.getLineStopsForStation(s)) end)
			pcall(function()
				local con = st2con[s]
				if con == nil then con = sys.streetConnectorSystem.getConstructionEntityForStation(s) end
				local c = con and api.engine.getComponent(con, api.type.ComponentType.CONSTRUCTION)
				if c then
					local m = c.transf
					rec.pos = { x = num(m[13]), y = num(m[14]), z = num(m[15]) }
					rec.construction = c.fileName
				end
			end)
			if rec.pos == nil then
				pcall(function()
					local bv = api.engine.getComponent(s, api.type.ComponentType.BOUNDING_VOLUME)
					if bv and bv.bbox then
						local mn, mx = bv.bbox.min, bv.bbox.max
						rec.pos = { x = (num(mn.x) + num(mx.x)) / 2, y = (num(mn.y) + num(mx.y)) / 2, z = num(mn.z) }
					end
				end)
			end
			return rec
		end
	end
	return nil
end

local function townsBegin(cargoNames)
	local sys = api.engine.system
	local ctx = { names = cargoNames, caps = {}, traffic = {}, buildings = {} }
	pcall(function() ctx.caps = sys.townBuildingSystem.getTown2personCapacitiesMap() end)
	pcall(function() ctx.traffic = api.engine.util.town.computeTownsTrafficSpeedMap(1.0) end)
	pcall(function() ctx.buildings = sys.townBuildingSystem.getTown2BuildingMap() end)
	return arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.TOWN)), ctx
end

-- A town is expensive (~250 ms measured in game for the whole record), so it is not one step but one step per
-- API call: the items of the towns section are (town, part) pairs and the record is assembled in ctx.recs.
-- Each TOWN_PARTS entry is one independent query; a failing part only loses its own fields.
local SUPPLY_TOWNS_PER_CYCLE = 2
local supplyCache = {}  -- town -> { rows, at }
local TOWN_PARTS = {
	function(t, rec, ctx)
		local town = api.engine.getComponent(t, api.type.ComponentType.TOWN)
		rec.name = entityName(t)
		rec.development_active = town and town.developmentActive and true or false
		local c = arr(ctx.caps[t]); rec.cap_res, rec.cap_com, rec.cap_ind = num(c[1]), num(c[2]), num(c[3])
		local tr = ctx.traffic[t]
		if tr then rec.traffic_speed = num(tr[1]); rec.congestion_levels = arr(tr[2]) end
		rec.buildings = count(ctx.buildings[t])
	end,
	function(t, rec)
		local u = arr(api.engine.util.town.getTownCapacityUsage(t))
		rec.usage = {}
		for i, x in ipairs(u) do rec.usage[i] = { used = num(x.used), capacity = num(x.capacity) } end
	end,
	function(t, rec)
		local h = api.engine.util.town.getTownHappinessStats(t, 3)
		local function pair(p) p = arr(p); return { unhappy = num(p[1]), total = num(p[2]) } end
		rec.happiness = { inside = pair(h.travellingInside), at_building = pair(h.atBuilding), by_car = pair(h.byCar), walking = pair(h.walking),
			to_resident = pair(h.travellingTo.resident), to_non_resident = pair(h.travellingTo.nonResident),
			from_resident = pair(h.travellingFrom.resident), from_non_resident = pair(h.travellingFrom.nonResident) }
		rec.top_lines = {}
		for _, bl in ipairs(arr(h.byLine)) do
			rec.top_lines[#rec.top_lines + 1] = { line = bl[1], resident = pair(bl[2].resident), non_resident = pair(bl[2].nonResident) }
		end
	end,
	function(t, rec)
		local e = api.engine.util.town.getTownEmissionDB(t)
		rec.noise_db, rec.pollution_db, rec.area_km2 = num(e.noise), num(e.pollution), num(e.areaSquareKm)
	end,
	function(t, rec)
		local r = api.engine.util.town.getTownReachability(t)
		rec.reach = { com_private = num(r.commercialPrivate), com_public = num(r.commercialPublic), ind_private = num(r.industrialPrivate), ind_public = num(r.industrialPublic) }
	end,
	function(t, rec) rec.line_usage = num(api.engine.util.town.getTownLineUsage(t)) end,
	function(t, rec, ctx)
		rec.stock = {}
		for ct, p in pairs(api.engine.util.town.getTownStockCargo(t)) do
			p = arr(p)
			rec.stock[#rec.stock + 1] = { cargo_type = num(ct), cargo = ctx.names[num(ct)], stock = num(p[1]), capacity = num(p[2]) }
		end
	end,
	-- What the town window shows ("supplied / needed"): townBuildingSystem.getCargoSupplyAndLimit(town)
	-- -> { cargoType = { supply, limit, group } }, decimals (the game rounds). Verified in game: v1/v2 = the window's
	-- "supplied / needed"; v3 = an internal group id, stored but not displayed. land_use is always 0 (whole town):
	-- the call costs ~55 ms per town in game (it walks every building), so the per-land-use variants (which only
	-- partition the same figures) are not exported any more (rev 5), and the towns are refreshed in rotation:
	-- SUPPLY_TOWNS_PER_CYCLE towns per slow cycle (the stalest first), the others keep their last value. The figures
	-- move slowly (rolling supply, needs grow with the town), the dashboard shows them with the snapshot time anyway.
	function(t, rec, ctx)
		local cached = supplyCache[t]
		if cached and not ctx.refreshSupply[t] then rec.supply = cached.rows; return end
		local rows = {}
		for ct, p in pairs(api.engine.system.townBuildingSystem.getCargoSupplyAndLimit(t)) do
			p = arr(p)
			rows[#rows + 1] = { land_use = 0, cargo_type = num(ct), v1 = num(p[1]), v2 = num(p[2]), v3 = num(p[3]) }
		end
		supplyCache[t] = { rows = rows, at = os.clock() }
		rec.supply = rows
	end,
	function(t, rec)
		rec.pos = vec3(api.engine.util.town.getTownDistrictCenter(t, 1))
		rec.stations = count(api.engine.system.stationSystem.getStations(t))
	end,
}

local function townsBeginParts(cargoNames, allSupply)
	local towns, ctx = townsBegin(cargoNames)
	ctx.recs = {}
	local items = {}
	for _, t in ipairs(towns) do
		ctx.recs[t] = { id = t }
		for p = 1, #TOWN_PARTS do items[#items + 1] = { t, p } end
	end
	-- supply rotation: towns never collected first, then the stalest
	local order = {}
	for _, t in ipairs(towns) do order[#order + 1] = t end
	table.sort(order, function(a, b)
		local ca, cb = supplyCache[a], supplyCache[b]
		if (ca == nil) ~= (cb == nil) then return ca == nil end
		if ca == nil then return a < b end
		return ca.at < cb.at
	end)
	ctx.refreshSupply = {}
	for i = 1, (allSupply and #order or math.min(SUPPLY_TOWNS_PER_CYCLE, #order)) do ctx.refreshSupply[order[i]] = true end
	-- forget towns that no longer exist
	local alive = {}
	for _, t in ipairs(towns) do alive[t] = true end
	for t in pairs(supplyCache) do if not alive[t] then supplyCache[t] = nil end end
	return items, ctx
end

-- returns the record once its last part is done (nil before), so the driver appends each town exactly once;
-- a failing part is reported through ctx.errors (merged by the driver) and the town is still exported
local function townItem(item, ctx)
	local t, p = item[1], item[2]
	local rec = ctx.recs[t]
	local ok, err = pcall(TOWN_PARTS[p], t, rec, ctx)
	if not ok then
		ctx.errors = ctx.errors or {}
		ctx.errors[#ctx.errors + 1] = { section = "towns", error = "town " .. tostring(t) .. " part " .. p .. ": " .. tostring(err) }
	end
	if p == #TOWN_PARTS then return rec end
	return nil
end

local function industriesBegin(cargoNames)
	return arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.INDUSTRY)), { names = cargoNames }
end

local function industryItem(i, ctx)
	local cargoNames = ctx.names
	do
		local ind = api.engine.getComponent(i, api.type.ComponentType.INDUSTRY)
		if ind then
			local rec = { id = i, name = entityName(i), level = num(ind.level), max_level = num(ind.maxLevel), closure_time = num(ind.closureTimeStamp),
				upgrade_progress = num(ind.upgradeProgress), manual = ind.manualDevelopment and true or false, stock_list = num(ind.stockList) }
			local sl = ind.stockList
			pcall(function()
				local c = api.engine.getComponent(ind.construction, api.type.ComponentType.CONSTRUCTION)
				if c then local m = c.transf; rec.pos = { x = num(m[13]), y = num(m[14]), z = num(m[15]) }; rec.construction = c.fileName end
			end)
			pcall(function() rec.production_rating = num(api.engine.util.stock.getProductionRating(sl)) end)
			pcall(function()
				local p = api.engine.util.industry.getIndustryProductivityInfo(i)
				rec.producing = p.producing and true or false; rec.boost_rule = p.boostFromRule and true or false; rec.boost_persons = p.boostFromPersonCapacity and true or false
			end)
			pcall(function() local s = api.engine.getComponent(sl, api.type.ComponentType.STOCK_LIST); if s then rec.thrown_away = num(s.thrownAwayCargo) end end)
			pcall(function()
				local io = arr(api.engine.util.stock.getInputsOutputsFromRules(sl))
				rec.inputs, rec.outputs = {}, {}
				for _, ct in ipairs(arr(io[1])) do
					local r = { cargo_type = num(ct), cargo = cargoNames[num(ct)] }
					pcall(function() r.consumed_year = num(api.engine.util.stock.getCargoConsumedPerYear(sl, ct)) end)
					pcall(function() r.max_consumption_year = num(api.engine.util.stock.getCargoMaxConsumptionPerYear(sl, ct)) end)
					pcall(function() r.delivered_year = num(api.engine.util.stock.getCargoTypeDeliveredPerYear(sl, ct)) end)
					rec.inputs[#rec.inputs + 1] = r
				end
				for _, ct in ipairs(arr(io[2])) do
					local r = { cargo_type = num(ct), cargo = cargoNames[num(ct)] }
					pcall(function() r.produced_year = num(api.engine.util.stock.getCargoProducedPerYear(sl, ct)) end)
					pcall(function() r.max_production_year = num(api.engine.util.stock.getCargoMaxProductionPerYear(sl, ct)) end)
					pcall(function() r.shipped_year = num(api.engine.util.stock.getCargoTypeShippedPerYear(sl, ct)) end)
					rec.outputs[#rec.outputs + 1] = r
				end
			end)
			return rec
		end
	end
	return nil
end

local function depotsBegin(player)
	return arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.VEHICLE_DEPOT)), { player = player }
end

local function depotItem(d, ctx)
	do
		local owned = api.engine.getComponent(d, api.type.ComponentType.PLAYER_OWNED)
		if owned and owned.player == ctx.player then
			local dep = api.engine.getComponent(d, api.type.ComponentType.VEHICLE_DEPOT)
			local carrier = nil
			if dep and dep.carrier ~= nil then carrier = enumName("Carrier", CARRIERS, dep.carrier) end
			if (carrier == nil or carrier == "nil") and dep then
				pcall(function()
					local modes = {}
					for m, on in pairs(dep.transportModes) do if on then modes[#modes + 1] = m end end
					local cs = arr(api.engine.util.transport.transportModesToCarriers(modes))
					if cs[1] ~= nil then carrier = enumName("Carrier", CARRIERS, cs[1]) end
				end)
			end
			local rec = { id = d, name = entityName(d), carrier = carrier,
				maintenance_pool = num(dep and dep.maintenancePool), pool_max = num(dep and dep.maxPoolUsage), pool_avg = num(dep and dep.averagePoolUsage) }
			pcall(function() rec.vehicles = count(api.engine.system.transportVehicleSystem.getDepotVehicles(d)) end)
			pcall(function() rec.incoming = count(api.engine.system.transportVehicleSystem.getGoingToDepotVehicles(d)) end)
			return rec
		end
	end
	return nil
end

-- Cargo types: localized display name (follows the game language) + a language-neutral key derived from
-- the resource file name ("grain.cargo" -> "grain", "mod/xyz/raw_fish.cargo" -> "raw_fish") used for icons.
-- Refreshed on every slow cycle so a language change in the game settings is picked up without restart.
local cargoNamesCache, cargoKeysCache
local function cargoNames(refresh)
	if cargoNamesCache and not refresh then return cargoNamesCache, cargoKeysCache end
	local names, keys = {}, {}
	local ok = pcall(function()
		for id, resName in pairs(api.res.cargoTypeRep.getAll()) do
			local n = resName
			pcall(function() local ct = api.res.cargoTypeRep.get(id); if ct and ct.name and ct.name ~= "" then n = ct.name end end)
			names[num(id)] = n
			local k = tostring(resName or ""):gsub("^.*/", ""):gsub("%.cargo.*$", ""):lower()
			if k ~= "" then keys[num(id)] = k end
		end
	end)
	if ok and next(names) then cargoNamesCache, cargoKeysCache = names, keys end
	return cargoNamesCache or names, cargoKeysCache or keys
end

-- ---------------------------------------------------------------- slow sections, time-sliced
-- A slow cycle used to collect everything (every line with all its terminals, every station, town, industry and
-- depot) in one guiUpdate call: with a few dozen lines that is a visible stutter every slow interval. Instead the
-- cycle is a job that walks through the sections one entity per step; guiUpdate runs steps until SLOW_BUDGET is
-- spent and resumes on the next frame. The result replaces slowCache in one go when the job is complete, so the
-- snapshot never mixes two cycles (slow_seq semantics unchanged for the collector).
local SLOW_SECTIONS = {
	{ name = "lines", begin = function(c) return linesBegin(c.player, c.names) end, item = lineItem },
	{ name = "stations", begin = function(c) return stationsBegin(c.player) end, item = stationItem },
	{ name = "towns", begin = function(c) return townsBeginParts(c.names, c.first) end, item = townItem,
	  label = function(it) return tostring(it[1]) .. "/" .. tostring(it[2]) end },
	{ name = "industries", begin = function(c) return industriesBegin(c.names) end, item = industryItem },
	{ name = "depots", begin = function(c) return depotsBegin(c.player) end, item = depotItem },
	{ name = "vehicles", begin = function() return vehiclesBegin() end, item = vehicleStaticItem },
}

local slowJob = nil    -- cycle in progress
local slowCache = nil  -- last cycle whose slow_*.lua files are all written: what the fast snapshots refer to
local slowPending = nil    -- a finished cycle whose files are still being written (one per frame)
local slowWriteQueue = {}  -- section names of slowPending still to be written
local slowFailure = nil    -- error text of the last failed cycle, reported in every fast snapshot until a cycle succeeds

local function slowJobStart(player, names, keys, seqNow)
	local slow = { errors = {} }
	section(slow, "company", collectCompany)
	slow.cargo_types = {}
	for id, n in pairs(names) do slow.cargo_types[#slow.cargo_types + 1] = { id = id, name = n, key = keys[id] } end
	-- the collector detects a new cycle by a change of slow_seq: keep it strictly increasing even if no fast
	-- snapshot was written between two cycles
	if slowCache and slowCache.collected_seq and seqNow <= slowCache.collected_seq then seqNow = slowCache.collected_seq + 1 end
	slow.collected_seq = seqNow
	slowJob = { slow = slow, common = { player = player, names = names, first = slowCache == nil }, sec = 1, items = nil, ctx = nil, i = 0,
		started = os.clock(), steps = 0, worst = {} }
end

-- profiling (debug log): keep the slowest steps of the cycle to see what is worth slicing further
local function noteStep(job, label, dt)
	job.steps = job.steps + 1
	local w = job.worst
	if #w < 8 then w[#w + 1] = { label, dt }
	else
		local mi = 1
		for i = 2, #w do if w[i][2] < w[mi][2] then mi = i end end
		if dt > w[mi][2] then w[mi] = { label, dt } end
	end
end

-- one step = one entity of the current section; returns true when the whole job is finished
local function slowJobStep()
	local job = slowJob
	local def = SLOW_SECTIONS[job.sec]
	if def == nil then return true end
	local t0 = os.clock()
	if job.items == nil then
		local ok, items, ctx = pcall(def.begin, job.common)
		noteStep(job, def.name .. ".begin", os.clock() - t0)
		if not ok then
			job.slow.errors[#job.slow.errors + 1] = { section = def.name, error = tostring(items) }
			job.slow[def.name] = {}
			job.sec = job.sec + 1
			return SLOW_SECTIONS[job.sec] == nil
		end
		job.items, job.ctx, job.i = items, ctx or {}, 0
		job.slow[def.name] = {}
		return false
	end
	job.i = job.i + 1
	local e = job.items[job.i]
	if e == nil then
		for _, err in ipairs(job.ctx.errors or {}) do job.slow.errors[#job.slow.errors + 1] = err end
		job.items, job.ctx = nil, nil
		job.sec = job.sec + 1
		return SLOW_SECTIONS[job.sec] == nil
	end
	local ok, rec = pcall(def.item, e, job.ctx)
	noteStep(job, def.name .. "#" .. (def.label and def.label(e) or tostring(e)), os.clock() - t0)
	if ok then
		if rec ~= nil then local out = job.slow[def.name]; out[#out + 1] = rec end
	else
		-- one broken entity must not hide the whole section: report and go on
		job.slow.errors[#job.slow.errors + 1] = { section = def.name, error = tostring(e) .. ": " .. tostring(rec) }
	end
	return false
end

-- run steps until the budget is spent; returns the finished slow table or nil
local function slowJobRun(budget)
	if slowJob == nil then return nil end
	local t0 = os.clock()
	repeat
		if slowJobStep() then
			local slow = slowJob.slow
			slow.collect_duration = os.clock() - slowJob.started
			if options().debug_log then
				table.sort(slowJob.worst, function(a, b) return a[2] > b[2] end)
				local parts = {}
				for _, w in ipairs(slowJob.worst) do parts[#parts + 1] = string.format("%s %.0fms", w[1], w[2] * 1000) end
				log(string.format("slow cycle: %d steps, slowest: %s", slowJob.steps, table.concat(parts, ", ")))
			end
			slowJob = nil
			return slow
		end
	until os.clock() - t0 >= budget
	return nil
end

-- ---------------------------------------------------------------- snapshot
local seq = 0
local lastFast, lastSlow = -1e9, -1e9
local announced = false
local lastCmdId = nil
local lastAck = nil

-- Where the player is looking: api.gui.camera.getCameraData() is a Vec5f {center.x, center.y, distance, angle, pitch}
-- (map coordinates, metres, radians). follow = the vehicle the camera is attached to, if any. The dashboard stores
-- named views from this and sends them back through the set_camera command.
local camPath, camPathProgress  -- camera travelling state, defined below

local function collectCamera()
	local c = api.gui.camera.getCameraData()
	local cam = { x = num(c.x), y = num(c.y), dist = num(c.z), angle = num(c.w), pitch = num(c.q) }
	local okF, f = pcall(api.gui.camera.getFollowEntity)
	if okF and type(f) == "table" then
		local e = num(f[1])
		if e and e > 0 then cam.follow = e end
	end
	if camPath then cam.path = { playing = true, progress = camPathProgress(), loop = camPath.loop, n = #camPath.pts } end
	return cam
end

-- ---------------------------------------------------------------- camera travelling (rev 10)
-- camera_path: the dashboard sends a list of waypoints once ({x, y, dist, angle, pitch} + the duration of each
-- leg); the mod interpolates on every frame (guiUpdate runs per rendered frame) and calls setCameraData, so the
-- movement is as smooth as the frame rate. Nothing touches the simulation. Catmull-Rom on the ground point and the
-- distance (the path bends through the waypoints instead of cornering), shortest-way interpolation of the heading,
-- smoothstep easing per leg when the dashboard asks for it. Stops on camera_stop, on a new path, when the player
-- grabs the camera (the camera no longer is where we left it), or when a follow camera takes over.
camPath = nil  -- { pts = {...}, legs = { duration }, t0, total, loop, ease, lastSet = Vec5 we wrote, tick }

local function lerp(a, b, t) return a + (b - a) * t end
local function angLerp(a, b, t)
	local d = (b - a) % (2 * math.pi)
	if d > math.pi then d = d - 2 * math.pi end
	return a + d * t
end
-- Catmull-Rom between p1 and p2 (p0, p3 = neighbours, clamped at the ends), t in [0,1]
local function catmull(p0, p1, p2, p3, t)
	local t2, t3 = t * t, t * t * t
	return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
end

camPathProgress = function()
	if not camPath then return 0 end
	local e = os.clock() - camPath.t0
	if camPath.loop and camPath.total > 0 then e = e % camPath.total end
	return math.max(0, math.min(1, e / camPath.total))
end

local followFrame = nil  -- { entity, dist, angle, pitch, left }: framing to apply over a follow camera (follow_view)
local function camPathStop(reason)
	if camPath then debug("camera path stopped: " .. tostring(reason)); camPath = nil end
end

-- the camera is "ours" if it is within a small tolerance of what we last wrote; otherwise the player moved it
local function camPathUserTouched()
	if not camPath or not camPath.lastSet then return false end
	local ok, c = pcall(api.gui.camera.getCameraData)
	if not ok or not c then return false end
	local l = camPath.lastSet
	local tol = math.max(2, l.dist * 0.01)
	return math.abs(num(c.x) - l.x) > tol or math.abs(num(c.y) - l.y) > tol or math.abs(num(c.z) - l.dist) > tol
		or math.abs(num(c.w) - l.angle) > 0.02 or math.abs(num(c.q) - l.pitch) > 0.02
end

-- Ground clearance (rev 11): the eye of the camera sits dist * sin(pitch) above the TARGET's ground; over a hill or a
-- town the terrain / buildings between the two can be higher than that, and a low pass clips through them. Before
-- every frame the height of the terrain is sampled under the target, under the eye and at two points in between;
-- if the eye would be lower than the highest of them + CAM_CLEARANCE, the distance is raised (same heading and
-- pitch, the camera backs up and climbs) so that it is not. Cheap: four getHeightAt per frame.
local CAM_CLEARANCE = 60      -- m above the highest ground sampled (buildings are rarely taller)
local CAM_MIN_PITCH = 0.25    -- a flatter camera cannot be lifted by distance alone: raise the pitch to this first
local function camClear(x, y, dist, angle, pitch)
	local terrain = api.engine.terrain
	if not terrain or not terrain.getHeightAt then return dist, pitch end
	if pitch < CAM_MIN_PITCH then pitch = CAM_MIN_PITCH end
	local sp, cp = math.sin(pitch), math.cos(pitch)
	local sa, ca = math.sin(angle), math.cos(angle)
	local function hAt(px, py) local ok, h = pcall(terrain.getHeightAt, api.type.Vec2f.new(px, py)); return ok and num(h) or 0 end
	local h0 = hAt(x, y)
	local back = dist * cp
	local hmax = h0
	for _, f in ipairs({ 0.33, 0.66, 1.0 }) do
		local h = hAt(x + sa * back * f, y - ca * back * f)
		if h > hmax then hmax = h end
	end
	local eyeZ = h0 + dist * sp
	local need = hmax + CAM_CLEARANCE
	if eyeZ < need and sp > 0.01 then dist = dist + (need - eyeZ) / sp end
	return dist, pitch
end

local function camSet(x, y, dist, angle, pitch)
	dist, pitch = camClear(x, y, dist, angle, pitch)
	local ok, err = pcall(api.gui.camera.setCameraData, api.type.Vec5f.new(x, y, dist, angle, pitch))
	if not ok then camPathStop("setCameraData failed: " .. tostring(err)); return false end
	camPath.lastSet = { x = x, y = y, dist = dist, angle = angle, pitch = pitch }
	camPath.tick = camPath.tick + 1
	return true
end
local function smooth(t) return t * t * (3 - 2 * t) end
-- heading that looks along (dx, dy): the eye sits at centre + (sin a, -cos a) * back
local atan2 = math.atan2 or math.atan  -- Lua 5.1 / 5.3+ (two-argument math.atan)
local function headingOf(dx, dy) return atan2(-dx, dy) end

-- Line tour (rev 10): ONE camera path built when the command arrives, from the points of interest of the line =
-- its stops (route sent by the dashboard, in order) + the positions of its vehicles AT THAT MOMENT, inserted at
-- their place along the route. Then it is played exactly like camera_path (Catmull-Rom, constant ground speed).
-- Altitude: high enough to read the line (derived from the size of the route, never a ground-level shot);
-- the camera dips a little over a vehicle and over a stop, flies higher in between. Heading = direction of
-- travel along the route, bisector at the corners so the turns are gentle.
local function camTourPos(v)
	local ok, p = pcall(api.engine.util.vehicle.getPosition, v)
	if not ok or not p then return nil end
	local x, y = num(p.x) or num(p[1]), num(p.y) or num(p[2])
	if not x or not y then return nil end
	return x, y
end
-- projection of (x,y) on the polyline: s along it, lateral offset
local function routeProject(pts, cum, x, y)
	local bs, bd = 0, math.huge
	for i = 2, #pts do
		local a, b = pts[i - 1], pts[i]
		local dx, dy = b.x - a.x, b.y - a.y
		local l2 = dx * dx + dy * dy
		local t = l2 > 0 and math.max(0, math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) or 0
		local px, py = a.x + dx * t, a.y + dy * t
		local d = (x - px) ^ 2 + (y - py) ^ 2
		if d < bd then bd = d; bs = cum[i - 1] + math.sqrt(l2) * t end
	end
	return bs, math.sqrt(bd)
end
-- camera_tour args: { line = id, route = { {x, y}, ... } (stops in order), closed = bool (default: 3+ points),
-- alt = flying distance in m (optional; default from the size of the route), speed = m/s (optional), loop = bool }
local function camTourBuild(args)
	local l = num(args.line); if not l then error("camera_tour needs args.line") end
	local raw = args.route
	if type(raw) ~= "table" or #raw < 2 then error("camera_tour needs args.route with 2+ points") end
	-- route = the ground track; every point is a stop unless args.stops lists which ones are (rev 11: the dashboard
	-- sends the real path along the tracks / roads, with the stops marked, so the camera follows the rails)
	local isStop = nil
	if type(args.stops) == "table" then isStop = {}; for _, i in ipairs(args.stops) do local k = num(i); if k then isStop[k] = true end end end
	local pts = {}
	for i, p in ipairs(raw) do
		local x, y = num(p.x) or num(p[1]), num(p.y) or num(p[2])
		if not x or not y then error("route point " .. i .. ": missing x/y") end
		local st = isStop == nil or isStop[i - 1] or false  -- args.stops: 0-based indices into route
		pts[#pts + 1] = { x = x, y = y, stop = st and true or false }
	end
	local closed = args.closed ~= false and #pts > 2
	if closed then pts[#pts + 1] = { x = pts[1].x, y = pts[1].y, stop = pts[1].stop } end
	-- cumulative length + size of the route
	local cum, len = { 0 }, 0
	local minx, maxx, miny, maxy = math.huge, -math.huge, math.huge, -math.huge
	for i, p in ipairs(pts) do
		if i > 1 then len = len + math.sqrt((p.x - pts[i - 1].x) ^ 2 + (p.y - pts[i - 1].y) ^ 2) end
		cum[i] = len
		minx, maxx, miny, maxy = math.min(minx, p.x), math.max(maxx, p.x), math.min(miny, p.y), math.max(maxy, p.y)
	end
	if len < 1 then error("route has no length") end
	local span = math.sqrt((maxx - minx) ^ 2 + (maxy - miny) ^ 2)
	-- altitude: a line is read from a height comparable to its spacing between stops, 250..900 m by default
	local alt = num(args.alt) or math.max(250, math.min(900, span * 0.15))
	-- points of interest: stops, plus every vehicle of the line at its place along the route (now)
	local poi = {}
	for i, p in ipairs(pts) do if p.stop then poi[#poi + 1] = { s = cum[i], x = p.x, y = p.y, kind = "stop" } end end
	if #poi == 0 then poi[#poi + 1] = { s = 0, x = pts[1].x, y = pts[1].y, kind = "stop" } end
	local vs = arr(api.engine.system.transportVehicleSystem.getLineVehicles(l))
	local nv = 0
	for _, v in ipairs(vs) do
		local x, y = camTourPos(v)
		if x then
			local sv, off = routeProject(pts, cum, x, y)
			if off < math.max(300, alt) then poi[#poi + 1] = { s = sv, x = x, y = y, kind = "vehicle" }; nv = nv + 1 end
		end
	end
	table.sort(poi, function(a, b) return a.s < b.s end)
	-- merge points closer than alt/2 along the route (a vehicle standing in a station = one point)
	local merged = {}
	for _, q in ipairs(poi) do
		local last = merged[#merged]
		if last and q.s - last.s < alt * 0.5 then
			if q.kind == "vehicle" then last.x, last.y, last.kind = q.x, q.y, "vehicle" end
		else merged[#merged + 1] = { s = q.s, x = q.x, y = q.y, kind = q.kind } end
	end
	-- point of the route at s
	local function routeAt(sm)
		local j = 2
		while j < #pts and cum[j] < sm do j = j + 1 end
		local a, b = pts[j - 1], pts[j]
		local seg = cum[j] - cum[j - 1]
		local t = seg > 0 and (sm - cum[j - 1]) / seg or 0
		return a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t
	end
	-- Around every point of interest: an approach point before it and an exit point after it (0.6 x alt along
	-- the route), both high; the heading swings from -SWING through the route direction to +SWING across the
	-- three, so the camera pans across the subject as it passes (a slow look, not an orbit). Long empty
	-- stretches get a high waypoint in the middle so the path does not cut the corner of the route.
	local SWING = 0.3  -- ~17 degrees either side (0.5 made the camera yaw too much, motion sickness)
	local gap = alt * 0.6
	local out = {}
	for i, q in ipairs(merged) do
		local prv, nxt = merged[i - 1], merged[i + 1]
		if prv and q.s - prv.s > gap * 2 then
			local x, y = routeAt(q.s - gap); out[#out + 1] = { s = q.s - gap, x = x, y = y, kind = "mid", swing = -SWING }
		end
		out[#out + 1] = q
		if nxt and nxt.s - q.s > gap * 2 then
			local x, y = routeAt(q.s + gap); out[#out + 1] = { s = q.s + gap, x = x, y = y, kind = "mid", swing = SWING }
		end
		if nxt and nxt.s - q.s > alt * 4 then
			-- long stretch: high waypoints every ~2 x alt along the route so the camera follows the track's bends
			-- (one point in the middle used to be enough for straight stop-to-stop routes)
			local span2 = nxt.s - q.s - 2 * gap
			local n = math.max(1, math.floor(span2 / (alt * 2)))
			for k = 1, n do
				local sm = q.s + gap + span2 * k / (n + 1)
				local x, y = routeAt(sm)
				out[#out + 1] = { s = sm, x = x, y = y, kind = "mid" }
			end
		end
	end
	-- headings: along the route (next point), bisector where the direction changes, plus the swing
	local path = {}
	for i, q in ipairs(out) do
		local prv, nxt = out[i - 1], out[i + 1]
		if closed and not nxt then nxt = out[2] end
		if closed and not prv then prv = out[#out - 1] end
		local hx, hy = 0, 0
		if nxt then local dx, dy = nxt.x - q.x, nxt.y - q.y; local n = math.sqrt(dx * dx + dy * dy); if n > 0 then hx, hy = dx / n, dy / n end end
		if prv then local dx, dy = q.x - prv.x, q.y - prv.y; local n = math.sqrt(dx * dx + dy * dy); if n > 0 then hx, hy = hx + dx / n, hy + dy / n end end
		if hx == 0 and hy == 0 then hy = 1 end
		-- zoom profile, kept shallow (rev 11.1): vehicle = 0.7 x alt, stop = 0.8 x alt, approach/exit = 1.05 x alt,
		-- mid-stretch = 1.15 x alt. The former 0.45 .. 1.5 range made the camera dive and climb by a factor of three
		-- every few seconds, together with the pitch swinging 0.75 .. 1.05: that is what turned stomachs.
		local dist = q.kind == "vehicle" and alt * 0.7 or q.kind == "stop" and alt * 0.8 or q.swing and alt * 1.05 or alt * 1.15
		local pitch = q.kind == "vehicle" and 0.9 or q.kind == "stop" and 0.95 or 1.0
		path[#path + 1] = { x = q.x, y = q.y, dist = dist, angle = headingOf(hx, hy) + (q.swing or 0), pitch = pitch, s = q.s }
	end
	-- durations: constant ground speed; speed = alt/8 m/s by default
	local speed = math.max(10, num(args.speed) or alt / 8)
	local raw2 = {}
	for i, q in ipairs(path) do
		local d = i > 1 and (q.s - path[i - 1].s) / speed or nil
		raw2[#raw2 + 1] = { x = q.x, y = q.y, dist = q.dist, angle = q.angle, pitch = q.pitch, duration = d and math.max(1.5, d) or nil }
	end
	-- the leg duration belongs to the leg ENDING at a point in camPathStart (point i>1 carries legs[i-1]) - ok as built
	return raw2, nv, alt, len
end

local function camPathTick()
	if not camPath then return end
	local okF, f = pcall(api.gui.camera.getFollowEntity)
	if okF and type(f) == "table" and (num(f[1]) or 0) > 0 then return camPathStop("follow camera active") end
	if camPath.tick > 0 and camPathUserTouched() then return camPathStop("player moved the camera") end
	local e = os.clock() - camPath.t0
	if e >= camPath.total then
		if camPath.loop then e = e % camPath.total else e = camPath.total end
	end
	-- find the leg
	local pts, legs = camPath.pts, camPath.legs
	local i, acc = 1, 0
	while i < #legs and e > acc + legs[i] do acc = acc + legs[i]; i = i + 1 end
	local t = legs[i] > 0 and (e - acc) / legs[i] or 1
	if t > 1 then t = 1 end
	if camPath.ease then t = t * t * (3 - 2 * t) end
	local p0, p1, p2, p3 = pts[math.max(1, i - 1)], pts[i], pts[math.min(#pts, i + 1)], pts[math.min(#pts, i + 2)]
	if camPath.loop and #pts > 2 then p0 = pts[i == 1 and #pts - 1 or i - 1]; p3 = pts[(i + 1) % (#pts - 1) + 1] end
	local x = catmull(p0.x, p1.x, p2.x, p3.x, t)
	local y = catmull(p0.y, p1.y, p2.y, p3.y, t)
	local dist = math.max(10, catmull(p0.dist, p1.dist, p2.dist, p3.dist, t))
	local angle = angLerp(p1.angle, p2.angle, t)
	local pitch = lerp(p1.pitch, p2.pitch, t)
	if not camSet(x, y, dist, angle, pitch) then return end
	if e >= camPath.total and not camPath.loop then camPathStop("finished") end
end

local function camPathStart(args)
	local raw = args and args.points
	if type(raw) ~= "table" or #raw < 2 then error("camera_path needs at least 2 points") end
	local pts, legs, total = {}, {}, 0
	for i, p in ipairs(raw) do
		local x, y, dist = num(p.x), num(p.y), num(p.dist)
		if not x or not y or not dist then error("point " .. i .. ": missing x/y/dist") end
		pts[#pts + 1] = { x = x, y = y, dist = math.max(10, dist), angle = num(p.angle) or 0, pitch = num(p.pitch) or 0 }
		if i > 1 then
			local d = math.max(0.1, num(p.duration) or num(args.duration) or 5)
			legs[#legs + 1] = d; total = total + d
		end
	end
	if args.loop and (pts[1].x ~= pts[#pts].x or pts[1].y ~= pts[#pts].y) then
		-- close the loop: come back to the first point
		pts[#pts + 1] = pts[1]
		local d = math.max(0.1, num(args.duration) or legs[#legs] or 5)
		legs[#legs + 1] = d; total = total + d
	end
	-- a follow camera would pull the view back to its vehicle: detach it first
	local okF, f = pcall(api.gui.camera.getFollowEntity)
	if okF and type(f) == "table" and (num(f[1]) or 0) > 0 then
		pcall(api.gui.camera.focusPosition, api.type.Vec3f.new(pts[1].x, pts[1].y, 0), pts[1].dist)
	end
	camPath = { pts = pts, legs = legs, total = total, loop = args.loop == true, ease = args.ease ~= false, t0 = os.clock(), tick = 0, lastSet = nil }
	camPathTick()
	debug(string.format("camera path started: %d points, %.1fs%s", #pts, total, camPath.loop and ", loop" or ""))
	return true
end

local function camTourStart(args)
	local points, nv, alt, len = camTourBuild(args)
	camPathStart({ points = points, loop = args.loop == true, ease = false })
	debug(string.format("camera tour: %d points (%d vehicles), route %.0f m, alt %.0f m", #points, nv, len, alt))
	return true
end

-- ---------------------------------------------------------------- geography (rev 11)
-- Static picture of the map for the dashboard's map tab: the terrain bounds, the water (contours of the water
-- meshes: sea, lakes, rivers) and the network (every street and track edge as a segment with its type). Written to
-- tf3dash_geo.lua once after the first slow cycle, then again only when the number of edges changed (the player
-- built or removed something) and at most once a minute. Collected one tile / one batch of edges per step with the
-- slow budget, so a 10 000-edge map costs a few ms per frame for a couple of seconds, never a stall. Everything is
-- rounded to the metre and contours are simplified (Douglas-Peucker) so the file stays a few hundred KB.
local GEO_FILE = PREFIX .. "geo"
local GEO_EDGE_BATCH = 40          -- edges per step (~1 ms measured target)
local GEO_WATER_EPS = 6            -- m: contour simplification tolerance (the map shows 1 px = 5..50 m)
local GEO_MIN_INTERVAL = 60        -- s between two collections when the network keeps changing
local GEO_GRID = 256               -- land/water grid: cells along the longer side (44 m per cell on an 11 km map)
local GEO_GRID_BATCH = 400         -- isOnWater samples per step (~0.5 ms)
local GEO_HEIGHT_EVERY = 2         -- a height sample every N grid points in x and y (128x128 for the relief)
local GEO_SHORE_SUB = 11           -- shore refinement: cells on a land/water boundary are resampled SUBxSUB (4 m on an 11 km map,
                                   -- the terrain resolution; ~1 400 cells x 121 = 170 000 isOnWater samples, ~4 s of frames)
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64C = {}
for i = 1, 64 do B64C[i - 1] = B64:sub(i, i) end
local geoJob = nil
local geoCache = nil               -- { geo_seq, edges, water_tiles, duration } of the last written file
local geoSeq = 0
local lastGeoAt = -1e9
local lastGeoEdgeCount = nil

local function round(x) return math.floor(x + 0.5) end

-- Douglas-Peucker on a closed/open ring of {x, y}; keeps the shape within eps metres
local function simplify(pts, eps)
	local n = #pts
	if n <= 3 then return pts end
	local keep = {}
	keep[1], keep[n] = true, true
	local stack = { { 1, n } }
	local eps2 = eps * eps
	while #stack > 0 do
		local seg = table.remove(stack)
		local a, b = seg[1], seg[2]
		if b - a >= 2 then
			local ax, ay, bx, by = pts[a][1], pts[a][2], pts[b][1], pts[b][2]
			local dx, dy = bx - ax, by - ay
			local len2 = dx * dx + dy * dy
			local best, bi = 0, nil
			for i = a + 1, b - 1 do
				local px, py = pts[i][1] - ax, pts[i][2] - ay
				local d2
				if len2 == 0 then d2 = px * px + py * py
				else
					local t = (px * dx + py * dy) / len2
					if t < 0 then t = 0 elseif t > 1 then t = 1 end
					local ex, ey = px - t * dx, py - t * dy
					d2 = ex * ex + ey * ey
				end
				if d2 > best then best, bi = d2, i end
			end
			if bi and best > eps2 then
				keep[bi] = true
				stack[#stack + 1] = { a, bi }
				stack[#stack + 1] = { bi, b }
			end
		end
	end
	local out = {}
	for i = 1, n do if keep[i] then out[#out + 1] = pts[i] end end
	return out
end

-- Every street and track edge. BASE_EDGE is not enumerable ("Cannot loop over this component type", build 40420);
-- the street system's node -> segments map lists them all, each edge from both its nodes, so dedupe. One call
-- (~a few ms for 10 000 edges); returns the list and its size.
local function geoEdgeList()
	local ok, m = pcall(api.engine.system.streetSystem.getNode2SegmentMap)
	if not ok or type(m) ~= "table" then return nil, nil, tostring(m) end
	local seen, list = {}, {}
	for _, segs in pairs(m) do
		for _, e in pairs(segs) do
			local k = num(e) or tostring(e)
			if not seen[k] then seen[k] = true; list[#list + 1] = e end
		end
	end
	return list, #list, nil
end

local function geoEdgeCount()
	local _, n = geoEdgeList()
	return n
end

local function geoJobStart()
	local geo = { schema = SCHEMA, mod = MOD_ID, errors = {}, water = {}, edges = {} }
	-- bounds + water level: one call each
	local okB, box = pcall(api.engine.terrain.getBoundingBox)
	if okB and box then
		local mn, mx = vec2(box.min), vec2(box.max)
		if mn and mx then geo.bounds = { round(mn.x), round(mn.y), round(mx.x), round(mx.y) } end
	else geo.errors[#geo.errors + 1] = { section = "bounds", error = tostring(box) } end
	local tiles = nil
	pcall(function()
		local world = api.engine.util.getWorld()
		local tr = api.engine.getComponent(world, api.type.ComponentType.TERRAIN)
		if tr then
			geo.water_level = num(tr.waterLevel)
			local sz = vec2(tr.size)
			if sz then tiles = { x = sz.x, y = sz.y }; geo.tiles = { sz.x, sz.y } end
		end
	end)
	-- water meshes: all entities in the tile range (tile indices start at 0)
	local waterEntities = {}
	if tiles then
		-- tile indices: the API does not say whether they start at 0 or are centred on the map; ask for both ranges
		-- and dedupe (the same entity comes back once per matching range)
		local seen = {}
		for _, range in ipairs({ { 0, 0, tiles.x, tiles.y }, { -tiles.x, -tiles.y, tiles.x, tiles.y } }) do
			local okW, list = pcall(api.engine.system.riverSystem.getWaterMeshEntities, api.type.Vec2i.new(range[1], range[2]), api.type.Vec2i.new(range[3], range[4]))
			if okW and type(list) == "table" then
				for _, e in pairs(list) do local k = num(e) or tostring(e); if not seen[k] then seen[k] = true; waterEntities[#waterEntities + 1] = e end end
			else geo.errors[#geo.errors + 1] = { section = "water", error = tostring(list) } end
		end
		debug(string.format("geo: %d water mesh entities (tiles %dx%d)", #waterEntities, tiles.x, tiles.y))
	end
	local edges, _, errE = geoEdgeList()
	if edges == nil then edges = {}; geo.errors[#geo.errors + 1] = { section = "edges", error = tostring(errE) } end
	geoSeq = geoSeq + 1
	geo.geo_seq = geoSeq
	-- land / water grid: the sea and lakes are terrain below the water level, not water meshes (those only exist
	-- for rivers and some lakes); sample isOnWater on a regular grid like the game's own minimap mods do
	-- (schbrongx's minimap samples 256x256). GEO_GRID cells over the bounds, GEO_GRID_BATCH points per step.
	local grid = nil
	if geo.bounds then
		local n = GEO_GRID
		local w, h = geo.bounds[3] - geo.bounds[1], geo.bounds[4] - geo.bounds[2]
		if w > 0 and h > 0 then
			local ny = math.max(8, math.floor(n * h / math.max(w, h) + 0.5)); local nx = math.max(8, math.floor(n * w / math.max(w, h) + 0.5))
			grid = { nx = nx, ny = ny, i = 0, rows = {}, cur = {}, run = nil, runOn = nil, heights = {}, hsum = 0, hmin = math.huge, hmax = -math.huge,
				cells = {}, shoreList = nil, si = 0, shore = {} }
			geo.grid = { nx, ny }
		end
	end
	geoJob = { geo = geo, water = waterEntities, wi = 0, edges = edges, ei = 0, grid = grid, started = os.clock(), steps = 0,
		vertsIn = 0, vertsOut = 0 }
end

-- a batch of grid points: isOnWater, encoded per row as run lengths starting with land ("3,5,2" = 3 land, 5 water,
-- 2 land); heights sampled every 4th point in both directions for a coarse relief (getHeightAt, rounded to the metre)
local function geoGridStep(job)
	local g = job.grid
	local total = g.nx * g.ny
	local b = job.geo.bounds
	local cw, ch = (b[3] - b[1]) / g.nx, (b[4] - b[2]) / g.ny
	local Vec2f = api.type.Vec2f
	for _ = 1, GEO_GRID_BATCH do
		if g.i >= total then return true end
		local col, row = g.i % g.nx, math.floor(g.i / g.nx)
		local x, y = b[1] + (col + 0.5) * cw, b[4] - (row + 0.5) * ch  -- rows from north (max y) to south
		local p = Vec2f.new(x, y)
		local on = api.engine.terrain.isOnWater(p) and true or false
		g.cells[g.i] = on
		if col == 0 then g.cur = {}; g.run = 0; g.runOn = false end
		if on == g.runOn then g.run = g.run + 1
		else g.cur[#g.cur + 1] = g.run; g.run = 1; g.runOn = on end
		if col == g.nx - 1 then g.cur[#g.cur + 1] = g.run; g.rows[#g.rows + 1] = table.concat(g.cur, ",") end
		if col % GEO_HEIGHT_EVERY == 0 and row % GEO_HEIGHT_EVERY == 0 then
			local hh = api.engine.terrain.getHeightAt(p)
			local hv = round(num(hh) or 0)
			g.heights[#g.heights + 1] = hv
			if hv < g.hmin then g.hmin = hv end
			if hv > g.hmax then g.hmax = hv end
		end
		g.i = g.i + 1
	end
	return false
end

-- shore refinement: once the coarse grid is complete, list the cells whose 4-neighbourhood mixes land and water,
-- then sample each SUBxSUB; a cell = { col, row, mask } with bit k = sub-cell k (row-major, north-west first) on water.
-- A coast of 11 km on a 256 grid is ~1 400 boundary cells x 121 = 170 000 extra samples, a few seconds of frames.
local function geoShoreStep(job)
	local g = job.grid
	if g.shoreList == nil then
		local list = {}
		for row = 0, g.ny - 1 do
			for col = 0, g.nx - 1 do
				local i = row * g.nx + col
				local c = g.cells[i]
				local mixed = (col > 0 and g.cells[i - 1] ~= c) or (col < g.nx - 1 and g.cells[i + 1] ~= c)
					or (row > 0 and g.cells[i - g.nx] ~= c) or (row < g.ny - 1 and g.cells[i + g.nx] ~= c)
				if mixed then list[#list + 1] = i end
			end
		end
		g.shoreList = list
		g.cells = nil  -- the coarse samples are in the rows already
		debug(string.format("geo: %d shore cells to refine (%dx%d sub-samples each)", #list, GEO_SHORE_SUB, GEO_SHORE_SUB))
		return #list == 0
	end
	local b = job.geo.bounds
	local cw, ch = (b[3] - b[1]) / g.nx, (b[4] - b[2]) / g.ny
	local sub = GEO_SHORE_SUB
	local Vec2f = api.type.Vec2f
	local budgetCells = math.max(1, math.floor(GEO_GRID_BATCH / (sub * sub)))
	for _ = 1, budgetCells do
		g.si = g.si + 1
		local i = g.shoreList[g.si]
		if i == nil then return true end
		local col, row = i % g.nx, math.floor(i / g.nx)
		local x0, y0 = b[1] + col * cw, b[4] - row * ch
		-- sub x sub bits do not fit a number past sub 7 (53-bit doubles): the mask is a string of base-64 digits,
		-- 6 bits each, bit k of the mask = sub-cell k (row-major, north-west first) on water
		local digits, acc, nb = {}, 0, 0
		for sr = 0, sub - 1 do
			for sc = 0, sub - 1 do
				local p = Vec2f.new(x0 + (sc + 0.5) * cw / sub, y0 - (sr + 0.5) * ch / sub)
				if api.engine.terrain.isOnWater(p) then acc = acc + 2 ^ nb end
				nb = nb + 1
				if nb == 6 then digits[#digits + 1] = B64C[acc]; acc, nb = 0, 0 end
			end
		end
		if nb > 0 then digits[#digits + 1] = B64C[acc] end
		g.shore[#g.shore + 1] = { col, row, table.concat(digits) }
	end
	return false
end

-- one water mesh: its contours, simplified; coordinates rounded to the metre
local function geoWaterStep(job)
	job.wi = job.wi + 1
	local e = job.water[job.wi]
	if e == nil then return true end
	local ok, err = pcall(function()
		local wm = api.engine.getComponent(e, api.type.ComponentType.WATER_MESH)
		if not wm or not wm.contours then return end
		local pos = vec2(wm.pos)
		debug(string.format("geo: water mesh %s tile (%s,%s): %d contours, %d mesh vertices", tostring(e), pos and pos.x or "?", pos and pos.y or "?", count(wm.contours), wm.vertices and count(wm.vertices) or 0))
		for _, c in pairs(wm.contours) do
			local pts = {}
			for _, v in pairs(c.vertices) do
				local p = vec2(v)
				if p then pts[#pts + 1] = { p.x, p.y } end
			end
			job.vertsIn = job.vertsIn + #pts
			if #pts >= 3 then
				local s = simplify(pts, GEO_WATER_EPS)
				if #s >= 3 then
					local flat = {}
					for _, p in ipairs(s) do flat[#flat + 1] = round(p[1]); flat[#flat + 1] = round(p[2]) end
					job.vertsOut = job.vertsOut + #s
					job.geo.water[#job.geo.water + 1] = flat
				end
			end
		end
	end)
	if not ok then job.geo.errors[#job.geo.errors + 1] = { section = "water", error = tostring(err) } end
	return false
end

-- a batch of edges: {x0, y0, x1, y1, kind} with kind 0 street, 1 track, +2 bridge, +4 tunnel
local function geoEdgeStep(job)
	local out = job.geo.edges
	for _ = 1, GEO_EDGE_BATCH do
		job.ei = job.ei + 1
		local e = job.edges[job.ei]
		if e == nil then return true end
		local ok, err = pcall(function()
			local be = api.engine.getComponent(e, api.type.ComponentType.BASE_EDGE)
			if not be then return end
			local p0, p1 = vec2(be.position0), vec2(be.position1)
			if not (p0 and p1) then
				-- older builds: positions only on the nodes
				local n0 = api.engine.getComponent(be.node0, api.type.ComponentType.BASE_NODE)
				local n1 = api.engine.getComponent(be.node1, api.type.ComponentType.BASE_NODE)
				p0, p1 = n0 and vec2(n0.position), n1 and vec2(n1.position)
			end
			if not (p0 and p1) then return end
			local kind = 0
			if enumName("RoadType", { "STREET", "TRACK" }, be.roadType) == "TRACK" then kind = 1 end
			local et = enumName("BaseEdgeType", { "NORMAL", "BRIDGE", "TUNNEL" }, be.type)
			if et == "BRIDGE" then kind = kind + 2 elseif et == "TUNNEL" then kind = kind + 4 end
			-- the entity id lets the line paths (vehicle MOVE_PATH edge ids) refer to this segment
			out[#out + 1] = { round(p0.x), round(p0.y), round(p1.x), round(p1.y), kind, num(e) }
		end)
		if not ok then job.geo.errors[#job.geo.errors + 1] = { section = "edges", error = tostring(err) } end
	end
	return false
end

-- run steps until the budget is spent; returns the finished geo table or nil
local function geoJobRun(budget)
	if geoJob == nil then return nil end
	local t0 = os.clock()
	local job = geoJob
	repeat
		job.steps = job.steps + 1
		-- phases in order: water meshes, edges, land/water grid; each step function returns true when its phase
		-- has nothing left, the job is done when no phase has work left
		local done = false
		if job.wi < #job.water then geoWaterStep(job)
		elseif job.ei < #job.edges then geoEdgeStep(job)
		elseif job.grid and job.grid.i < job.grid.nx * job.grid.ny then geoGridStep(job)
		elseif job.grid and not job.grid.shoreDone then job.grid.shoreDone = geoShoreStep(job)
		else done = true end
		if done then
			job.geo.duration = os.clock() - job.started
			job.geo.edge_count = #job.edges
			if job.grid then
				job.geo.water_rows = job.grid.rows
				job.geo.heights = job.grid.heights
				job.geo.height_every = GEO_HEIGHT_EVERY
				job.geo.height_range = { job.grid.hmin, job.grid.hmax }
				job.geo.shore = job.grid.shore
				job.geo.shore_sub = GEO_SHORE_SUB
			end
			geoJob = nil
			return job
		end
	until os.clock() - t0 >= budget
	return nil
end

-- ---------------------------------------------------------------- heightmap (full resolution)
-- The terrain is stored tile by tile (256 m, TERRAIN_TILE_HEIGHTMAP: 65x65 integers at 4 m, metres = raw * baseResolution.z
-- + offsetZ, 5 cm steps), readable in Lua at no cost (the array is already in memory, ~0 ms per tile measured). The
-- whole map (44x44 tiles = 7.9 M values on an 11 km map) does not fit one Lua file, so the tiles go out in band files
-- tf3dash_height_<band>.lua of HEIGHT_BAND tile rows each, one tile per frame, each tile one printable string: the
-- first height in full, then the difference to the previous vertex (row-major), both as variable-length base-64 digits
-- (6 bits per character, the low bit of the first digit is the sign, the top bit of every digit says "more digits").
-- Flat land is 1 character per vertex: ~5 KB per tile, ~10 MB for the map, written once per load and again when the
-- terrain changed (getTerrainEntityRevisions, the game's own change counter, checked with the geo edge count).
local HEIGHT_PREFIX = PREFIX .. "height_"
local HEIGHT_BAND = 4              -- tile rows per file (44 tiles x 4 rows x ~5 KB = ~1 MB per file)
local HEIGHT_TILES_PER_STEP = 2    -- tiles encoded per frame (~1 ms each: 4 225 values through the encoder)
local heightJob = nil
local heightRevs = nil             -- revision signature of the terrain at the last export
local lastHeightCheck = -1e9
local heightCache = nil            -- { bands, tiles } of the last export

-- variable-length signed integer: digits of 5 payload bits, bit 6 (value 32) = another digit follows; sign in the low
-- bit of the first digit (zigzag)
local function vint(out, v)
	local z = v >= 0 and v * 2 or (-v * 2 - 1)
	repeat
		local d = z % 32
		z = (z - d) / 32
		if z > 0 then d = d + 32 end
		out[#out + 1] = B64C[d]
	until z == 0
end

local function heightRevSignature()
	local ok, revs = pcall(api.engine.terrain.getTerrainEntityRevisions)
	if not ok or type(revs) ~= "table" then return nil end
	local acc, n = 0, 0
	for e, r in pairs(revs) do
		local a = num(r and r.num and r.num[1]) or 0
		local b = num(r and r.num and r.num[2]) or 0
		acc = (acc + (num(e) or 0) * 31 + a * 7 + b) % 2147483647
		n = n + 1
	end
	return string.format("%d:%d", n, acc)
end

local function heightJobStart()
	local world = api.engine.util.getWorld()
	local tr = api.engine.getComponent(world, api.type.ComponentType.TERRAIN)
	if not tr then return false end
	local sz = vec2(tr.size)
	if not sz or sz.x <= 0 or sz.y <= 0 then return false end
	-- tile indices are centred on the map: -n/2 .. n/2-1 (probe: tile -1,-1 exists, tile 43,43 does not on 44x44)
	local tx0, ty0 = -math.floor(sz.x / 2), -math.floor(sz.y / 2)
	heightJob = { nx = sz.x, ny = sz.y, tx0 = tx0, ty0 = ty0, i = 0, band = {}, bandNo = 0, bands = 0, tiles = 0, started = os.clock(),
		meta = { schema = SCHEMA, mod = MOD_ID, grid = { sz.x, sz.y }, origin = { tx0, ty0 }, side = 65, step = num(tr.baseResolution.x) or 4,
			res_z = num(tr.baseResolution.z) or 0.05, offset_z = num(tr.offsetZ) or 0, water_level = num(tr.waterLevel) or 0,
			band_rows = HEIGHT_BAND, revs = heightRevSignature() } }
	return true
end

-- one band file: { meta..., band = k, rows = {first tile row, last}, tiles = { "<encoded>", ... row-major } }
local function heightBandWrite(job)
	local k = job.bandNo
	local data = { band = k, row0 = k * HEIGHT_BAND, tiles = job.band }
	for key, v in pairs(job.meta) do data[key] = v end
	data.bands = math.ceil(job.ny / HEIGHT_BAND)
	local ok, err = pcall(app.saveUserdata, DIR, HEIGHT_PREFIX .. k, data)
	if not ok then log("saveUserdata failed for heightmap band " .. k .. ":", tostring(err)) end
	job.band = {}
	job.bandNo = k + 1
	job.bands = job.bands + 1
	return ok
end

-- returns true when the whole map is out
local function heightJobRun()
	local job = heightJob
	if job == nil then return false end
	local Vec2i = api.type.Vec2i
	for _ = 1, HEIGHT_TILES_PER_STEP do
		local total = job.nx * job.ny
		if job.i >= total then
			if #job.band > 0 then heightBandWrite(job) end
			heightCache = { bands = job.bands, tiles = job.tiles }
			log(string.format("heightmap written: %d tiles in %d files, %.1fs", job.tiles, job.bands, os.clock() - job.started))
			heightJob = nil
			return true
		end
		local col, row = job.i % job.nx, math.floor(job.i / job.nx)
		local ok, e = pcall(api.engine.terrain.getHeightmapEntity, Vec2i.new(job.tx0 + col, job.ty0 + row))
		local hm = ok and e and api.engine.getComponent(e, api.type.ComponentType.TERRAIN_TILE_HEIGHTMAP)
		local out = {}
		if hm and hm.vertices then
			local prev = nil
			for _, v in pairs(hm.vertices) do
				local iv = math.floor(num(v) or 0)
				if prev == nil then vint(out, iv) else vint(out, iv - prev) end
				prev = iv
			end
		end
		job.band[#job.band + 1] = table.concat(out)
		job.tiles = job.tiles + 1
		job.i = job.i + 1
		-- a band is complete when its last tile row is done
		if col == job.nx - 1 and (row + 1) % HEIGHT_BAND == 0 then heightBandWrite(job); return false end
	end
	return false
end

local function geoWrite(job)
	local t0 = os.clock()
	local ok, err = pcall(app.saveUserdata, DIR, GEO_FILE, job.geo)
	if not ok then log("saveUserdata failed for geo:", tostring(err)); return false end
	geoCache = { geo_seq = job.geo.geo_seq, edges = #job.geo.edges, water = #job.geo.water }
	log(string.format("geo written: %d edges, %d water contours (%d -> %d vertices), grid %s (%d heights, %d shore cells), %d steps, collected in %.2fs, written in %.0fms, %d error(s)",
		#job.geo.edges, #job.geo.water, job.vertsIn, job.vertsOut, job.geo.grid and (job.geo.grid[1] .. "x" .. job.geo.grid[2]) or "none",
		job.geo.heights and #job.geo.heights or 0, job.geo.shore and #job.geo.shore or 0, job.steps, job.geo.duration, (os.clock() - t0) * 1000, #job.geo.errors))
	for i = 1, math.min(3, #job.geo.errors) do log("  geo error:", job.geo.errors[i].section, job.geo.errors[i].error) end
	return true
end

local function buildSnapshot(player, names)
	seq = seq + 1
	local snap = { schema = SCHEMA, mod = MOD_ID, seq = seq, real_time = os.time(), errors = {} }
	snap.player = num(player)

	section(snap, "time", collectTime)
	section(snap, "finance", function() return collectFinance(player) end)
	section(snap, "alerts", function() return collectAlerts(player) end)
	if options().export_vehicles then
		section(snap, "vehicles", collectVehicles)
	end
	-- cosmetic: no entry in snap.errors if the camera API is missing (the dashboard then hides the views panel)
	local okC, cam = pcall(collectCamera)
	if okC then snap.camera = cam end

	-- the slow sections live in their own files; the fast snapshot only says which cycle they belong to, so the
	-- collector knows when a new set is complete (slow_seq changes once all slow_*.lua of a cycle are written)
	snap.slow_seq = slowCache.collected_seq
	snap.slow_errors = slowCache.errors
	if slowFailure then snap.errors[#snap.errors + 1] = { section = "slow_cycle", error = slowFailure } end
	snap.cmd_ack = lastAck
	snap.accept_commands = options().accept_commands and true or false
	return snap
end

local function writeSnapshot(snap)
	local ok, err = pcall(app.saveUserdata, DIR, FILE, snap)
	if not ok then
		log("saveUserdata failed:", tostring(err))
		setStatus("error", err)
		return false
	end
	setStatus("ok")
	return true
end

-- Slow sections are written one file per frame after a cycle completes: slow_lines.lua, slow_stations.lua...
-- Each file carries the cycle number (slow_seq) so the collector can tell a complete set from a half-written one.
-- Returns true when something was written this frame.
local SLOW_FILE_SECTIONS = { "company", "cargo_types", "lines", "stations", "towns", "industries", "depots", "vehicles" }

local function slowWriteNext()
	if slowPending == nil then return false end
	local name = table.remove(slowWriteQueue, 1)
	if name == nil then
		-- every file of the cycle is on disk: the next fast snapshot may now point at it
		slowCache = slowPending
		slowPending = nil
		return false
	end
	local body = { schema = SCHEMA, mod = MOD_ID, slow_seq = slowPending.collected_seq, section = name, items = slowPending[name] or {} }
	local t0 = os.clock()
	local ok, err = pcall(app.saveUserdata, DIR, SLOW_FILE_PREFIX .. name, body)
	if not ok then log("saveUserdata failed for " .. name .. ":", tostring(err)); setStatus("error", err)
	elseif options().debug_log then
		local dt = os.clock() - t0
		if dt > 0.01 then log(string.format("slow file %s written in %.0fms", name, dt * 1000)) end
	end
	return true
end

-- line paths: their own file (tf3dash_line_paths.lua), outside the slow_seq set, rewritten only when a leg changed
-- (typically a few times after loading, then rarely); the collector re-reads it on mtime change
local LINE_PATHS_FILE = PREFIX .. "line_paths"
local function linePathsWrite()
	if not linePathsDirty then return false end
	linePathsDirty = false
	local items = linePathsExport()
	local t0 = os.clock()
	local ok, err = pcall(app.saveUserdata, DIR, LINE_PATHS_FILE, { schema = SCHEMA, mod = MOD_ID, real_time = os.time(), items = items })
	if not ok then log("saveUserdata failed for line_paths:", tostring(err)); return false end
	local legs = 0
	for _, r in ipairs(items) do legs = legs + #r.legs end
	debug(string.format("line paths written: %d lines, %d legs, %.0fms", #items, legs, (os.clock() - t0) * 1000))
	return true
end

-- ---------------------------------------------------------------- commands (dashboard -> game)
-- The dashboard writes <userdata>\dashboard_export\cmd.lua :
--   function data() return { id = <number>, cmd = "<name>", args = { ... } } end
-- Each file is executed once (dedup on id), then removed. The result is reported in the next
-- snapshot under snapshot.cmd_ack = { id, cmd, ok, error, real_time }.
-- Only a short whitelist of harmless, reversible actions is accepted (no buy/sell/destroy).
-- (lastCmdId / lastAck are declared above buildSnapshot, which reports the ack.)

local function sendCmd(c)
	local done, okRes, errRes = false, nil, nil
	api.cmd.sendCommand(c, function(res, success)
		done = true; okRes = success and true or false
		if not success then errRes = "command rejected" end
	end)
	-- callbacks are usually asynchronous; report "sent" and let the next snapshot reflect the state
	if done then return okRes, errRes end
	return true, nil
end

local function vehicleEntity(args)
	local v = num(args and args.vehicle)
	if not v then error("missing args.vehicle") end
	local tv = api.engine.getComponent(v, api.type.ComponentType.TRANSPORT_VEHICLE)
	if not tv then error("not a transport vehicle: " .. tostring(v)) end
	return v
end

local function lineEntity(args)
	local l = num(args and args.line)
	if not l then error("missing args.line") end
	if not api.engine.entityExists(l) or not api.engine.getComponent(l, api.type.ComponentType.LINE) then error("not a line: " .. tostring(l)) end
	return l
end

-- send one command per vehicle of the line; returns ok if at least one was sent
local function forEachLineVehicle(args, make)
	local l = lineEntity(args)
	local vs = arr(api.engine.system.transportVehicleSystem.getLineVehicles(l))
	if #vs == 0 then error("line has no vehicle") end
	local n = 0
	for _, v in ipairs(vs) do
		local ok = pcall(function() api.cmd.sendCommand(make(v), function() end) end)
		if ok then n = n + 1 end
	end
	if n == 0 then return false, "no command sent" end
	return true, nil
end

local COMMANDS = {
	-- game speed: 0 = pause, 1, 2, 4
	set_speed = function(args)
		local s = num(args and args.speed)
		if s == nil or s < 0 or s > 4 then error("speed must be 0..4") end
		return sendCmd(api.cmd.makeGameSetSpeedCmd(math.floor(s)))
	end,
	-- calendar speed (the game's "Calendar speed" slider: 0.25x .. 4x), independent from the simulation speed.
	-- The engine stores it as the length of a day in ms; 1x = 4000 ms/day (observed: 16000 = 0.25x ... 1000 = 4x).
	set_calendar_speed = function(args)
		local f = num(args and args.factor)
		if f == nil or (f ~= 0 and (f < 0.25 or f > 4)) then error("factor must be 0 (calendar paused) or 0.25..4") end
		return sendCmd(api.cmd.makeGameSetCalendarSpeedCmd(f == 0 and 0 or math.floor(4000 / f + 0.5)))
	end,
	pause = function() return sendCmd(api.cmd.makeGameSetSpeedCmd(0)) end,
	toggle_pause = function()
		local gs = api.engine.getComponent(api.engine.util.getWorld(), api.type.ComponentType.GAME_SPEED)
		local cur = num(gs and gs.speedup) or 1
		return sendCmd(api.cmd.makeGameSetSpeedCmd(cur == 0 and 1 or 0))
	end,
	-- camera (GUI thread only, no simulation command involved)
	focus_entity = function(args)
		local e = num(args and args.entity); if not e then error("missing args.entity") end
		api.gui.camera.focusEntity(e); return true
	end,
	focus_position = function(args)
		local x, y = num(args and args.x), num(args and args.y)
		if not x or not y then error("missing args.x/y") end
		local z = num(args.z) or 0
		api.gui.camera.focusPosition(api.type.Vec3f.new(x, y, z), num(args.distance) or 600); return true
	end,
	follow_entity = function(args)
		local e = num(args and args.entity); if not e then error("missing args.entity") end
		api.gui.camera.followEntity(e, args.jump ~= false); return true
	end,
	-- recall a stored view: the five numbers of snapshot.camera. A running follow camera would pull the view back
	-- to the vehicle, so detach it first by focusing the target position.
	set_camera = function(args)
		local x, y, dist = num(args and args.x), num(args and args.y), num(args and args.dist)
		if not x or not y or not dist then error("missing args.x/y/dist") end
		local angle, pitch = num(args.angle) or 0, num(args.pitch) or 0
		local okF, f = pcall(api.gui.camera.getFollowEntity)
		if okF and type(f) == "table" and (num(f[1]) or 0) > 0 then
			pcall(api.gui.camera.focusPosition, api.type.Vec3f.new(x, y, 0), dist)
		end
		camPathStop("set_camera")
		dist, pitch = camClear(x, y, dist, angle, pitch)
		api.gui.camera.setCameraData(api.type.Vec5f.new(x, y, dist, angle, pitch))
		return true
	end,
	-- a view attached to a vehicle (rev 11): follow it, then apply the saved framing (distance, heading, pitch) on
	-- top of the follow camera, which owns the position. The framing is re-applied for a few frames because the
	-- follow camera slides to the vehicle first (see followFrame in guiUpdate).
	follow_view = function(args)
		local e = num(args and args.entity); if not e then error("missing args.entity") end
		if not api.engine.entityExists(e) then return false, "vehicle no longer exists" end
		camPathStop("follow_view")
		api.gui.camera.followEntity(e, args.jump ~= false)
		followFrame = { entity = e, dist = num(args.dist), angle = num(args.angle), pitch = num(args.pitch), left = 12 }
		return true
	end,
	-- camera travelling: args = { points = { {x, y, dist, angle, pitch, duration?}, ... }, duration?, loop?, ease? }
	-- (duration = seconds per leg when a point has none; ease defaults to true). Played by the mod frame by frame.
	camera_path = function(args) camPathStop("new path"); return camPathStart(args) end,
	camera_stop = function() camPathStop("camera_stop"); return true end,
	-- line tour: one path over the stops of a line + its vehicles' positions at this moment (see camTourBuild)
	camera_tour = function(args) camPathStop("new tour"); return camTourStart(args or {}) end,
	-- experiment (rev 10): play a cutscene keyframe file (the Advanced Camera Tool format: free camera, roll, fov,
	-- vehicle attachment). args.file = resource path ("modid::/path.lua") or absolute path; whether the game accepts
	-- it outside a mission / from userdata is what this command is here to find out. Answer carries the API result.
	camera_cutscene = function(args)
		local f = args and args.file
		if type(f) ~= "string" or f == "" then error("missing args.file") end
		if not (api.gui.mission and api.gui.mission.playCutscene) then error("api.gui.mission.playCutscene not available") end
		camPathStop("cutscene")
		local ok, err = pcall(api.gui.mission.playCutscene, f, args.resolve_language == true)
		if not ok then error("playCutscene: " .. tostring(err)) end
		local playing = false
		pcall(function() playing = api.gui.mission.isCutscenePlaying() end)
		debug("camera_cutscene " .. f .. " -> playing=" .. tostring(playing))
		return true, nil
	end,
	-- selection: opens the entity window (line, vehicle, station, town, industry...) exactly like a click in the
	-- game; same react event the game's notifications use. args.focus (default true) also moves the camera.
	select_entity = function(args)
		local e = num(args and args.entity); if not e then error("missing args.entity") end
		if not api.engine.entityExists(e) then error("entity does not exist: " .. tostring(e)) end
		if args.focus ~= false then pcall(api.gui.camera.focusEntity, e) end
		api.gui.fireReactEvent("selectEntity", { entity = e, stack = args.stack == true })
		return true
	end,
	-- line manager window opened on a given line
	open_line_manager = function(args)
		local e = num(args and args.line); if not e then error("missing args.line") end
		if not api.engine.entityExists(e) then error("line does not exist: " .. tostring(e)) end
		api.gui.fireReactEvent("openVehicleManager", { openWithLineEntity = e })
		return true
	end,
	close_windows = function() api.gui.closeAllWindows(); return true end,
	-- horn: a sound only, nothing changes in the simulation (api.gui.sound.letVehicleHorn, GUI thread).
	-- args.vehicle = one vehicle, or args.line = every vehicle of the line
	horn = function(args)
		local vs
		if num(args and args.line) then
			vs = arr(api.engine.system.transportVehicleSystem.getLineVehicles(lineEntity(args)))
			if #vs == 0 then error("line has no vehicle") end
		else
			vs = { vehicleEntity(args) }
		end
		local n = 0
		for _, v in ipairs(vs) do
			if pcall(api.gui.sound.letVehicleHorn, v) then n = n + 1 end
		end
		if n == 0 then return false, "no horn sounded" end
		return true, nil
	end,
	-- vehicles (reversible actions only)
	vehicle_stop = function(args) return sendCmd(api.cmd.makeVehicleSetStoppedByUserCmd(vehicleEntity(args), true)) end,
	vehicle_start = function(args) return sendCmd(api.cmd.makeVehicleSetStoppedByUserCmd(vehicleEntity(args), false)) end,
	vehicle_reverse = function(args) return sendCmd(api.cmd.makeVehicleReverseCmd(vehicleEntity(args))) end,
	vehicle_depart = function(args) return sendCmd(api.cmd.makeVehicleTryToDepartCmd(vehicleEntity(args))) end,
	vehicle_to_depot = function(args) return sendCmd(api.cmd.makeVehicleSendToDepotCmd(vehicleEntity(args), false)) end,
	-- ---- lines
	-- Edit the departure configuration of one stop. Same mechanism as the game's cargo filter window:
	-- copy the Line component, change the fields given in args, send the whole line back.
	-- args: { line, stop (1-based index), load_mode = 0|1|2, min_wait, max_wait (-1 = unlimited), max_add_wait,
	--         force_unload, destroy_for_config_change, destroy_for_refresh, no_load = { cargo ids not to load } }
	-- Only the given fields are changed; the route (stations, terminals, waypoints) is never touched.
	line_set_stop = function(args)
		local l = lineEntity(args)
		local lineData = api.type.Line.new(api.engine.getComponent(l, api.type.ComponentType.LINE))
		local stops = {}
		for _, s in ipairs(arr(lineData.stops)) do stops[#stops + 1] = s end
		local idx = num(args.stop)
		if not idx or idx < 1 or idx > #stops then error("stop index out of range (1.." .. #stops .. ")") end
		local stop = stops[idx]
		local changed = false
		local function setNum(field, key, lo, hi)
			local v = num(args[key])
			if v == nil then return end
			if v < lo or v > hi then error(key .. " must be " .. lo .. ".." .. hi) end
			stop[field] = v; changed = true
		end
		setNum("loadMode", "load_mode", 0, 2)
		setNum("minWaitingTime", "min_wait", 0, 600)
		setNum("maxWaitingTime", "max_wait", -1, 600)
		setNum("maxAdditionalWaitingTime", "max_add_wait", 0, 600)
		-- keep the same invariants as the game UI (min <= max unless max == -1, add <= max)
		if stop.maxWaitingTime ~= -1 then
			if stop.minWaitingTime > stop.maxWaitingTime then stop.minWaitingTime = stop.maxWaitingTime end
			if stop.maxAdditionalWaitingTime > stop.maxWaitingTime then stop.maxAdditionalWaitingTime = stop.maxWaitingTime end
		end
		if args.force_unload ~= nil or args.destroy_for_config_change ~= nil or args.destroy_for_refresh ~= nil or type(args.no_load) == "table" then
			local cfg = api.type.Line.StopConfig.new(stop.stopConfig)
			if args.force_unload ~= nil then cfg.forceUnload = args.force_unload and true or false end
			if args.destroy_for_config_change ~= nil then cfg.destroyForConfigChange = args.destroy_for_config_change and true or false end
			if args.destroy_for_refresh ~= nil then cfg.destroyForRefresh = args.destroy_for_refresh and true or false end
			if type(args.no_load) == "table" then
				-- dense arrays over all cargo types, Lua index = cargo id + 1 (see cargofilter_window.tl)
				local blocked = {}
				for _, ct in pairs(args.no_load) do local c = num(ct); if c then blocked[c] = true end end
				-- no_load only covers the cargo types the dashboard knows (getAll(), the ones exported in
				-- cargo_types). getAll(true) also lists types that getAll() leaves out (on a 1900 start: books,
				-- cement, paper, rubber, sawdust, tires); the game's filter window does not show them either and
				-- defaults them to "not loaded". They stay not loaded here: allowing them because they are missing
				-- from no_load made them appear on the stop after every filter change, with no way to remove them.
				local known = {}
				for k in pairs(api.res.cargoTypeRep.getAll()) do known[num(k)] = true end
				local load, maxLoad = {}, {}
				for k in pairs(api.res.cargoTypeRep.getAll(true)) do
					local id = num(k)
					load[id + 1] = known[id] == true and not blocked[id]
					local old = stop.stopConfig and stop.stopConfig.maxLoad and stop.stopConfig.maxLoad[id + 1]
					maxLoad[id + 1] = num(old) or 1
				end
				cfg.load = load; cfg.maxLoad = maxLoad
				lineData.customFilters = true
			end
			stop.stopConfig = cfg; changed = true
		end
		if not changed then error("nothing to change") end
		stops[idx] = stop
		lineData.stops = stops
		return sendCmd(api.cmd.makeLineUpdateCmd(l, lineData))
	end,
	-- Choose which terminals of the station a stop may use. Same mechanism as the game's terminal panel
	-- (manager_window.tl changeMainTerminal / selectAlternativeTerminal): the preferred terminal is stop.station /
	-- stop.terminal, the other allowed ones are stop.alternativeTerminals. Indices are 0-based as in the engine.
	-- args: { line, stop (1-based), main = { station, terminal }, alternatives = { { station, terminal }, ... } }
	-- The station group itself never changes, so the route stays the same (the path to the new preferred terminal
	-- is recomputed by the game; it may refuse if there is no path, like in its own window).
	line_set_terminals = function(args)
		local l = lineEntity(args)
		local lineData = api.type.Line.new(api.engine.getComponent(l, api.type.ComponentType.LINE))
		local stops = {}
		for _, s in ipairs(arr(lineData.stops)) do stops[#stops + 1] = s end
		local idx = num(args.stop)
		if not idx or idx < 1 or idx > #stops then error("stop index out of range (1.." .. #stops .. ")") end
		local stop = stops[idx]
		local main = args.main
		if type(main) ~= "table" or num(main.station) == nil or num(main.terminal) == nil then error("missing args.main {station, terminal}") end
		-- validate every index against the station group as it exists now (the station may have been rebuilt)
		local sg = api.engine.getComponent(stop.stationGroup, api.type.ComponentType.STATION_GROUP)
		local stations = arr(sg and sg.stations or {})
		local function check(st, tm, what)
			st, tm = num(st), num(tm)
			local se = stations[st + 1]
			if se == nil then error(what .. ": station index " .. st .. " out of range") end
			local station = api.engine.getComponent(se, api.type.ComponentType.STATION)
			if station == nil or arr(station.terminals)[tm + 1] == nil then error(what .. ": terminal index " .. tm .. " out of range") end
			return st, tm
		end
		local ms, mt = check(main.station, main.terminal, "main")
		stop.station = ms
		stop.terminal = mt
		local alts, seen = {}, { [ms .. ":" .. mt] = true }
		for _, a in ipairs(type(args.alternatives) == "table" and args.alternatives or {}) do
			if type(a) == "table" then
				local s2, t2 = check(a.station, a.terminal, "alternative")
				local key = s2 .. ":" .. t2
				if not seen[key] then seen[key] = true; alts[#alts + 1] = api.type.StationTerminal.new(s2, t2) end
			end
		end
		stop.alternativeTerminals = alts
		stops[idx] = stop
		lineData.stops = stops
		return sendCmd(api.cmd.makeLineUpdateCmd(l, lineData))
	end,
	-- Same departure configuration applied to every stop of the line (load_mode / waits only).
	line_set_all_stops = function(args)
		local l = lineEntity(args)
		local lineData = api.type.Line.new(api.engine.getComponent(l, api.type.ComponentType.LINE))
		local stops = {}
		local lm, mn, mx, ad = num(args.load_mode), num(args.min_wait), num(args.max_wait), num(args.max_add_wait)
		if lm == nil and mn == nil and mx == nil and ad == nil then error("nothing to change") end
		for _, s in ipairs(arr(lineData.stops)) do
			if lm ~= nil then s.loadMode = lm end
			if mn ~= nil then s.minWaitingTime = mn end
			if mx ~= nil then s.maxWaitingTime = mx end
			if ad ~= nil then s.maxAdditionalWaitingTime = ad end
			stops[#stops + 1] = s
		end
		lineData.stops = stops
		return sendCmd(api.cmd.makeLineUpdateCmd(l, lineData))
	end,
	-- Stop / start every vehicle of a line (one command per vehicle, reversible).
	line_stop_all = function(args) return forEachLineVehicle(args, function(v) return api.cmd.makeVehicleSetStoppedByUserCmd(v, true) end) end,
	line_start_all = function(args) return forEachLineVehicle(args, function(v) return api.cmd.makeVehicleSetStoppedByUserCmd(v, false) end) end,
	line_all_to_depot = function(args) return forEachLineVehicle(args, function(v) return api.cmd.makeVehicleSendToDepotCmd(v, false) end) end,
	-- Rename a line / vehicle / station (any named entity)
	rename_entity = function(args)
		local e = num(args and args.entity); if not e then error("missing args.entity") end
		if not api.engine.entityExists(e) then error("entity does not exist") end
		local n = args.name; if type(n) ~= "string" or n == "" or #n > 80 then error("name must be 1..80 chars") end
		return sendCmd(api.cmd.makeEntitySetNameCmd(e, n))
	end,
	ping = function() return true end,
}

-- names present in the export folder (without .lua); loadUserdata logs a warning when a file is missing, so the
-- listing is checked first. One listing per poll serves both cmd.lua and activity.lua.
local function listUserdata()
	local present = {}
	local ok, list = pcall(app.getAllUserdata, DIR)
	if not ok or type(list) ~= "table" then return present end
	for _, n in pairs(list) do present[tostring(n):gsub("%.lua$", "")] = true end
	return present
end

-- ---------------------------------------------------------------- activity hint (dashboard -> mod)
-- The dashboard tells the mod when the player is interacting with it (click, key, wheel): their attention is on the
-- second screen, so for ACTIVITY_WINDOW seconds the mod may do its heavy work (collect the slow cycle, write the
-- slow_*.lua files) without anybody noticing a hitch in the game, and the dashboard gets fresh data right when it is
-- being looked at. Not a command: works whatever "Permit game control" is set to, changes timing only.
local ACTIVITY_FILE = PREFIX .. "activity"
local ACTIVITY_WINDOW = 2.0      -- seconds of relaxed budget after a hint
local ACTIVITY_BUDGET = 0.05     -- per-frame budget for slow steps during the window (50 ms = a frame nobody sees)
local ACTIVITY_MIN_AGE = 5.0     -- restart the slow cycle on a hint only if the last one is older than this
local activityUntil = -1e9
local lastActivityId = nil

local function pollActivity(now)
	local ok, a = pcall(app.loadUserdata, DIR, ACTIVITY_FILE)
	pcall(app.removeUserdata, DIR, ACTIVITY_FILE)
	if not ok or type(a) ~= "table" then return false end
	if a.id ~= nil and a.id == lastActivityId then return false end
	lastActivityId = a.id
	activityUntil = now + ACTIVITY_WINDOW
	return true
end

local function pollCommands()
	if not options().accept_commands then return end
	local ok, c = pcall(app.loadUserdata, DIR, CMD_FILE)
	if not ok or type(c) ~= "table" or c.cmd == nil then return end
	local id = c.id
	if id ~= nil and id == lastCmdId then return end -- already processed, file not yet removed
	lastCmdId = id
	local ack = { id = id, cmd = tostring(c.cmd), real_time = os.time() }
	local fn = COMMANDS[c.cmd]
	if not fn then
		ack.ok = false; ack.error = "unknown command"
	else
		local okRun, res, err = pcall(fn, c.args or {})
		if not okRun then ack.ok = false; ack.error = tostring(res)
		else ack.ok = res and true or false; ack.error = err end
	end
	lastAck = ack
	pcall(app.removeUserdata, DIR, CMD_FILE)
	debug("command", ack.cmd, ack.ok and "ok" or ("failed: " .. tostring(ack.error)))
end

-- ---------------------------------------------------------------- hooks
local script = {}

function script.update(_userParams, _state, _dt)
	-- engine side: nothing to do, everything happens in guiUpdate
end

local lastPoll = -1e9

function script.guiUpdate(_userParams, _state, _guiState)
	local now = os.clock()
	local o = options()
	statusTick(now)
	if camPath then  -- camera travelling: one interpolation + setCameraData per frame, a few microseconds
		local okT, errT = pcall(camPathTick)
		if not okT then log("camera path tick failed:", tostring(errT)); camPath = nil end
	end
	if followFrame then  -- follow_view: keep the saved distance / heading / pitch while the follow camera settles
		local ff = followFrame
		local okF, errF = pcall(function()
			local c = api.gui.camera.getCameraData()
			local d, p = camClear(c.x, c.y, ff.dist or c.z, ff.angle or c.w, ff.pitch or c.q)
			api.gui.camera.setCameraData(api.type.Vec5f.new(c.x, c.y, d, ff.angle or c.w, p))
		end)
		ff.left = ff.left - 1
		if not okF then log("follow framing failed:", tostring(errF)); followFrame = nil
		elseif ff.left <= 0 then followFrame = nil end
	end
	if now - lastPoll >= 0.25 then
		lastPoll = now
		local present = listUserdata()
		if present[ACTIVITY_FILE] or present[CMD_FILE] then status.companion_seen = os.time() end
		if present[ACTIVITY_FILE] then
			local okA, hinted = pcall(pollActivity, now)
			if not okA then debug("pollActivity failed:", tostring(hinted))
			elseif hinted then debug("activity hint: relaxed budget for " .. ACTIVITY_WINDOW .. "s") end
		end
		if present[CMD_FILE] then
			local okP, errP = pcall(pollCommands)
			if not okP then debug("pollCommands failed:", tostring(errP)) end
		end
	end
	local active = now < activityUntil

	-- slow cycle: start a job when due, then advance it a little on every frame; a finished cycle is then written
	-- to its slow_*.lua files one per frame (slowWriteNext) before the fast snapshots start referring to it.
	-- While the player is busy on the dashboard (activity hint) a cycle is started early and run with a much larger
	-- per-frame budget, and the slow files are flushed in one go: the hitch lands while nobody watches the game.
	local due = (now - lastSlow) >= o.interval_slow or (active and (now - lastSlow) >= ACTIVITY_MIN_AGE)
	if slowJob == nil and slowPending == nil and due then
		lastSlow = now
		local ok, err = pcall(function()
			local names, keys = cargoNames(true)
			gameLanguage(true)
			slowJobStart(api.engine.util.getPlayer(), names, keys, seq + 1)
		end)
		if not ok then log("slow cycle failed to start:", tostring(err)) end
	end
	if slowJob ~= nil then
		-- the very first cycle runs unthrottled so that the dashboard gets a complete picture right away
		local budget = SLOW_BUDGET
		if slowCache == nil then budget = 1e9 elseif active then budget = ACTIVITY_BUDGET end
		local ok, done = pcall(slowJobRun, budget)
		if not ok then
			log("slow cycle failed:", tostring(done))
			slowJob = nil
			slowFailure = tostring(done)
			-- rev 7: a failing first cycle used to block live.lua forever (the dashboard stayed empty with no hint).
			-- Stand in with an empty cycle so the fast snapshots flow and carry the error to the dashboard.
			if slowCache == nil then slowCache = { collected_seq = 0, errors = { { section = "slow_cycle", error = slowFailure } } } end
		elseif done then
			slowFailure = nil
			slowPending = done
			slowWriteQueue = {}
			for _, name in ipairs(SLOW_FILE_SECTIONS) do slowWriteQueue[#slowWriteQueue + 1] = name end
			debug(string.format("slow cycle %d collected in %.2fs (%d lines, %d stations, %d towns, %d industries, %d depots, %d vehicles)",
				done.collected_seq, done.collect_duration or 0, #(done.lines or {}), #(done.stations or {}), #(done.towns or {}),
				#(done.industries or {}), #(done.depots or {}), #(done.vehicles or {})))
		end
	end
	if slowPending ~= nil then
		-- one slow file per frame; on the very first cycle, or while the player is on the dashboard, write them all
		-- now so that live.lua can follow at once
		local okW, errW = pcall(function()
			if slowCache == nil or active then while slowWriteNext() do end; slowWriteNext() else slowWriteNext() end
		end)
		if not okW then log("slow write failed:", tostring(errW)); slowPending = nil; slowWriteQueue = {} end
		if slowPending ~= nil then return end  -- do not write live.lua in the same frame as a slow file
	end
	if slowCache == nil then return end  -- first cycle still running: nothing complete to write yet

	-- line paths: a small file, only when a leg changed; its own frame
	if linePathsDirty then
		local okL, wrote = pcall(linePathsWrite)
		if not okL then log("line paths write failed:", tostring(wrote)); linePathsDirty = false end
		if wrote then return end
	end

	-- finance journal: once per game month (or after a save game reload); its own frame
	do
		local okJ, wroteJ = pcall(function()
			local gt = api.engine.getComponent(api.engine.util.getWorld(), api.type.ComponentType.GAME_TIME)
			return journalWriteIfDue(api.engine.util.getPlayer(), num(gt and gt.gameTime))
		end)
		if not okJ then log("journal write failed:", tostring(wroteJ)) end
		if wroteJ then return end
	end

	-- geography: first collection right after the first slow cycle, then again when the network changed (edge
	-- count checked once a minute, one cheap call); advanced with the slow budget, written in one go when complete
	if geoJob == nil and now - lastGeoAt >= GEO_MIN_INTERVAL then
		lastGeoAt = now
		local tc = os.clock()
		local n = geoEdgeCount()
		debug(string.format("geo: %s edges in the network (counted in %.0fms)", tostring(n), (os.clock() - tc) * 1000))
		if geoCache == nil or (n ~= nil and n ~= lastGeoEdgeCount) then
			lastGeoEdgeCount = n
			local okG, errG = pcall(geoJobStart)
			if not okG then log("geo collection failed to start:", tostring(errG)); geoJob = nil end
		end
	end
	if geoJob ~= nil then
		local okG, done = pcall(geoJobRun, active and ACTIVITY_BUDGET or SLOW_BUDGET)
		if not okG then log("geo collection failed:", tostring(done)); geoJob = nil
		elseif done then pcall(geoWrite, done); return end  -- not in the same frame as live.lua (a big write)
	end
	-- full-resolution heightmap: after the geography, once per load, and again when the terrain revisions changed
	-- (the player raised or dug ground); checked with the geo minute tick above, two tiles per frame meanwhile
	if heightJob == nil and geoJob == nil and geoCache ~= nil and now - lastHeightCheck >= GEO_MIN_INTERVAL then
		lastHeightCheck = now
		local sig = heightRevSignature()
		if heightCache == nil or (sig ~= nil and sig ~= heightRevs) then
			heightRevs = sig
			local okH, startedH = pcall(heightJobStart)
			if not okH then log("heightmap export failed to start:", tostring(startedH)); heightJob = nil end
		end
	end
	if heightJob ~= nil then
		local okH, doneH = pcall(heightJobRun)
		if not okH then log("heightmap export failed:", tostring(doneH)); heightJob = nil
		elseif doneH then return end
	end

	if now - lastFast < o.interval_fast then return end
	local tb = os.clock()
	local ok, snap = pcall(buildSnapshot, api.engine.util.getPlayer(), cargoNames(false))
	if not ok then
		log("snapshot failed:", tostring(snap))
		lastFast = now
		return
	end
	lastFast = now
	local tw = os.clock()
	local written = writeSnapshot(snap)
	if o.debug_log then
		local te = os.clock()
		if te - tb > 0.01 then log(string.format("fast snapshot: build %.0fms, write %.0fms", (tw - tb) * 1000, (te - tw) * 1000)) end
	end
	if written then
		if not announced then
			announced = true
			local folder = ""
			pcall(function() folder = app.getUserDataFolder() end)
			log(string.format("writing %s/%s.lua every %ds (slow sections every %ds, %.0f ms budget per frame) under %s",
				DIR, FILE, o.interval_fast, o.interval_slow, SLOW_BUDGET * 1000, tostring(folder)))
		end
		debug(string.format("seq %d written, %d error(s), %d vehicles", snap.seq, #snap.errors, snap.vehicles and #snap.vehicles or 0))
	end
end

-- ---------------------------------------------------------------- status window (rev 10)
-- The status window (status_ui.script.lua, a plugin of the game's mod button area) reads from this script with
--   api.gui.fireGuiScriptEvent(UI_ID, "read")  -> guiHandleEvent returns { status, current = { key = 1-based index } }
-- Read-only: settings are changed in the game's mod menu, like for any other mod. (A rev 9 prototype wrote them to
-- the saved state through handleEvent; the window did not follow the engine-side state reliably, so it was dropped.)
-- The event name has to be subscribed on the engine side for gui events to reach guiHandleEvent at all.
local UI_ID = "TF3_DASHBOARD_EXPORT"
local UI_EVENTS = { "read" }

local function paramIndex(key, value)
	for i, v in ipairs(PARAM_VALUES[key] or {}) do if v == value then return i end end
	return PARAM_DEFAULT_INDEX[key]
end

function script.handleEvent(_userParams, state, _src, id, _name, _param)
	-- lifecycle events come with an empty id: (re)subscribe to our names, nothing else to do
	if id == "" then for _, ev in ipairs(UI_EVENTS) do pcall(function() state:subscribeToEvent(ev) end) end end
end

function script.guiHandleEvent(_userParams, _state, _guiState, _src, id, name, _param)
	if id ~= UI_ID or name ~= "read" then return nil end
	local o = options()
	local current = {}
	for key in pairs(PARAM_VALUES) do current[key] = paramIndex(key, o[key]) end
	if status.folder == nil then pcall(function() status.folder = tostring(app.getUserDataFolder()) .. "/" .. DIR end) end
	return {
		status = { state = status.state, last_ok = status.last_ok, last_error = status.last_error,
			companion_seen = status.companion_seen, folder = status.folder, now = os.time() },
		current = current,
	}
end

-- .script.lua resources expose their exports through data(), not a return value
function data()
	return script
end
