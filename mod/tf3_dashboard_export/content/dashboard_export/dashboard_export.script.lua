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

local cachedOptions
local function options()
	if cachedOptions then return cachedOptions end
	local ok, all = pcall(api.engine.config.getModParams)
	local raw = (ok and all and all[MOD_ID]) or {}
	local o = {}
	for key, values in pairs(PARAM_VALUES) do
		local r = raw[key]
		local v
		if type(r) == "number" then
			-- params declared with "numbers" in mod.json come back as the number itself (1, 2, 5, 10...),
			-- the others as an index (1-based observed on Button params; tolerate 0-based).
			-- Match the value first, then fall back to index. Both conventions give the right slider value.
			for _, cand in ipairs(values) do
				if cand == r then v = cand; break end
			end
			if v == nil then v = values[r] end
			if v == nil then v = values[r + 1] end
		end
		if v == nil then v = values[PARAM_DEFAULT_INDEX[key]] end
		o[key] = v
	end
	if ok and all then cachedOptions = o end
	return o
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

local function vehiclesBegin()
	return arr(api.engine.util.vehicle.getVehicles()), {}
end

local function vehicleStaticItem(v)
	local tv = api.engine.getComponent(v, api.type.ComponentType.TRANSPORT_VEHICLE)
	if not tv then return nil end
	local rec = { id = v, name = entityName(v), carrier = enumName("Carrier", CARRIERS, tv.carrier) }
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
local function collectCamera()
	local c = api.gui.camera.getCameraData()
	local cam = { x = num(c.x), y = num(c.y), dist = num(c.z), angle = num(c.w), pitch = num(c.q) }
	local okF, f = pcall(api.gui.camera.getFollowEntity)
	if okF and type(f) == "table" then
		local e = num(f[1])
		if e and e > 0 then cam.follow = e end
	end
	return cam
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
		return false
	end
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
	if not ok then log("saveUserdata failed for " .. name .. ":", tostring(err))
	elseif options().debug_log then
		local dt = os.clock() - t0
		if dt > 0.01 then log(string.format("slow file %s written in %.0fms", name, dt * 1000)) end
	end
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
		if f == nil or f < 0.25 or f > 4 then error("factor must be 0.25..4") end
		return sendCmd(api.cmd.makeGameSetCalendarSpeedCmd(math.floor(4000 / f + 0.5)))
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
		api.gui.camera.setCameraData(api.type.Vec5f.new(x, y, dist, angle, pitch))
		return true
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
	if now - lastPoll >= 0.25 then
		lastPoll = now
		local present = listUserdata()
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

-- .script.lua resources expose their exports through data(), not a return value
function data()
	return script
end
