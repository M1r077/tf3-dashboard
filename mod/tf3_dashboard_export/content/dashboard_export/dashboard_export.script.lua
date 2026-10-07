-- Dashboard Export : periodically writes a snapshot of the game state to
--   <userdata>\dashboard_export\live.lua
-- via app.saveUserdata, for an external dashboard / collector (second monitor).
--
-- Everything runs on the GUI thread (guiUpdate): the GUI state has read access to the whole
-- engine state, "app" is available there, and nothing is stored in the savegame.
-- Every section is wrapped in pcall: a failing section is reported in snapshot.errors and the
-- rest of the snapshot is still written. Read-only: no api.cmd is ever sent.

local MOD_ID = "tf3_dashboard_export"
local SCHEMA = 3  -- 2: line capacity cargo ids fixed (dense array was read 1-based => off by one); 3: towns.supply
local DIR = "dashboard_export"
local FILE = "live"

-- ---------------------------------------------------------------- params
local PARAM_VALUES = {
	interval_fast = { 1, 2, 5, 10 },
	interval_slow = { 10, 30, 60, 120 },
	export_vehicles = { true, false },
	accept_commands = { false, true }, -- off by default (rev 2): the player opts in to remote control
	debug_log = { false, true },
}
local PARAM_DEFAULT_INDEX = { interval_fast = 2, interval_slow = 2, export_vehicles = 1, accept_commands = 1, debug_log = 1 }
local CMD_FILE = "cmd"

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

local function collectCompany()
	local cv = api.engine.util.headquarters.getCompaniesValue()
	local keys = { "totalScore", "railVehicles", "trams", "roadVehicles", "aircrafts", "ships", "trackTotalLength", "trackElectricLength",
		"bridgeTotalLength", "tunnelTotalLength", "roadTotalLength", "suppliedTowns", "connectedIndustries", "numberOfLines", "totalStations",
		"railStations", "tramStations", "roadStations", "aircraftStations", "shipStations", "topSpeed", "topLength", "oldestTransportVehicle",
		"balance", "totalAssets", "debt" }
	local out = {}
	for _, k in ipairs(keys) do out[k] = num(cv[k]) end
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

local function collectVehicles()
	local out = {}
	local sys = api.engine.system
	for _, v in ipairs(arr(api.engine.util.vehicle.getVehicles())) do
		local tv = api.engine.getComponent(v, api.type.ComponentType.TRANSPORT_VEHICLE)
		if tv then
			local rec = { id = v, name = entityName(v), carrier = enumName("Carrier", CARRIERS, tv.carrier),
				state = enumName("TransportVehicleState", VSTATES, tv.state), line = num(tv.line), stop_index = num(tv.stopIndex),
				user_stopped = tv.userStopped and true or false, no_path = tv.noPath and true or false, depot = num(tv.depot),
				days_in_depot = num(tv.daysInDepot), days_at_terminal = num(tv.daysAtTerminal), doors_open = tv.doorsOpen and true or false }
			pcall(function() rec.speed = num(api.engine.util.vehicle.getSpeed(v)) end)
			pcall(function() rec.pos = vec3(api.engine.util.vehicle.getPosition(v)) end)
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
			local okL, loadN = pcall(sys.simEntityAtVehicleSystem.getVehicleSimEntitiesCount, v)
			if okL and num(loadN) then rec.load = num(loadN)
			else
				pcall(function()
					local total = 0
					for _, n in ipairs(arr(api.engine.util.cargo.getNumCargoPerTypeInVehicle(v))) do total = total + (num(n) or 0) end
					rec.load = total
				end)
			end
			pcall(function() rec.maintenance = num(api.engine.util.vehicle.getVehicleMaintenanceState(v)) end)
			pcall(function() rec.running_cost = num(api.engine.util.vehicle.getRunningCost(v)) end)
			pcall(function() rec.value = num(api.engine.util.vehicle.getDepreciatedValue(v)) end)
			pcall(function() rec.closest_town = num(tv.closestTown) end)
			pcall(function()
				local caps = arr(api.engine.util.vehicle.getVehicleCapacities(v)); local total = 0
				for _, c in ipairs(caps) do total = total + (num(c) or 0) end
				rec.capacity = total
			end)
			out[#out + 1] = rec
		end
	end
	return out
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

local function terminalsOfGroup(groupEntity, lineModes, lineCargoClasses)
	local out = {}
	local sg = api.engine.getComponent(groupEntity, api.type.ComponentType.STATION_GROUP)
	if not sg then return out end
	local tpNet = nil
	pcall(function() tpNet = api.engine.system.transportNetworkSystem.getTpNetData() end)
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

local function collectLines(player, cargoNames)
	local out = {}
	local sys = api.engine.system
	for _, l in ipairs(arr(sys.lineSystem.getLinesForPlayer(player))) do
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
					st.terminals = terminalsOfGroup(s.stationGroup, lineModes, lineClasses)
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
		out[#out + 1] = rec
	end
	return out
end

local function collectStations(player)
	local out = {}
	local sys = api.engine.system
	local st2town = {}
	pcall(function() st2town = sys.stationSystem.getStation2TownMap() end)
	local st2con = {}
	pcall(function() st2con = sys.streetConnectorSystem.getStation2ConstructionMap() end)
	for _, s in ipairs(arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.STATION))) do
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
			out[#out + 1] = rec
		end
	end
	return out
end

local function collectTowns(cargoNames)
	local out = {}
	local sys = api.engine.system
	local caps = {}
	pcall(function() caps = sys.townBuildingSystem.getTown2personCapacitiesMap() end)
	local traffic = {}
	pcall(function() traffic = api.engine.util.town.computeTownsTrafficSpeedMap(1.0) end)
	for _, t in ipairs(arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.TOWN))) do
		local town = api.engine.getComponent(t, api.type.ComponentType.TOWN)
		local rec = { id = t, name = entityName(t), development_active = town and town.developmentActive and true or false }
		pcall(function() local c = arr(caps[t]); rec.cap_res, rec.cap_com, rec.cap_ind = num(c[1]), num(c[2]), num(c[3]) end)
		pcall(function()
			local u = arr(api.engine.util.town.getTownCapacityUsage(t))
			rec.usage = {}
			for i, x in ipairs(u) do rec.usage[i] = { used = num(x.used), capacity = num(x.capacity) } end
		end)
		pcall(function()
			local h = api.engine.util.town.getTownHappinessStats(t, 3)
			local function pair(p) p = arr(p); return { unhappy = num(p[1]), total = num(p[2]) } end
			rec.happiness = { inside = pair(h.travellingInside), at_building = pair(h.atBuilding), by_car = pair(h.byCar), walking = pair(h.walking),
				to_resident = pair(h.travellingTo.resident), to_non_resident = pair(h.travellingTo.nonResident),
				from_resident = pair(h.travellingFrom.resident), from_non_resident = pair(h.travellingFrom.nonResident) }
			rec.top_lines = {}
			for _, bl in ipairs(arr(h.byLine)) do
				rec.top_lines[#rec.top_lines + 1] = { line = bl[1], resident = pair(bl[2].resident), non_resident = pair(bl[2].nonResident) }
			end
		end)
		pcall(function()
			local e = api.engine.util.town.getTownEmissionDB(t)
			rec.noise_db, rec.pollution_db, rec.area_km2 = num(e.noise), num(e.pollution), num(e.areaSquareKm)
		end)
		pcall(function()
			local r = api.engine.util.town.getTownReachability(t)
			rec.reach = { com_private = num(r.commercialPrivate), com_public = num(r.commercialPublic), ind_private = num(r.industrialPrivate), ind_public = num(r.industrialPublic) }
		end)
		pcall(function() rec.line_usage = num(api.engine.util.town.getTownLineUsage(t)) end)
		pcall(function()
			local tr = traffic[t]
			if tr then rec.traffic_speed = num(tr[1]); rec.congestion_levels = arr(tr[2]) end
		end)
		pcall(function()
			rec.stock = {}
			for ct, p in pairs(api.engine.util.town.getTownStockCargo(t)) do
				p = arr(p)
				rec.stock[#rec.stock + 1] = { cargo_type = num(ct), cargo = cargoNames[num(ct)], stock = num(p[1]), capacity = num(p[2]) }
			end
		end)
		-- What the town window shows ("supplied / needed"): townBuildingSystem.getCargoSupplyAndLimit(town[, landUse])
		-- -> { cargoType = { supply, limit, n } }. Exported raw as v1/v2/v3, one flat list: land_use 0 = whole town,
		-- 1/2/3 = residential/commercial/industrial. The dashboard shows the same figures as the game; the exact
		-- meaning of v3 is not documented, so it is exported as is.
		pcall(function()
			rec.supply = {}
			local function dump(landUse)
				local m
				if landUse then m = sys.townBuildingSystem.getCargoSupplyAndLimit(t, landUse)
				else m = sys.townBuildingSystem.getCargoSupplyAndLimit(t) end
				for ct, p in pairs(m) do
					p = arr(p)
					rec.supply[#rec.supply + 1] = { land_use = landUse or 0, cargo_type = num(ct), v1 = num(p[1]), v2 = num(p[2]), v3 = num(p[3]) }
				end
			end
			dump(nil)
			for lu = 1, 3 do pcall(dump, lu) end
		end)
		pcall(function() rec.pos = vec3(api.engine.util.town.getTownDistrictCenter(t, 1)) end)
		pcall(function() rec.stations = count(sys.stationSystem.getStations(t)) end)
		pcall(function() rec.buildings = count(sys.townBuildingSystem.getTown2BuildingMap()[t]) end)
		out[#out + 1] = rec
	end
	return out
end

local function collectIndustries(cargoNames)
	local out = {}
	for _, i in ipairs(arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.INDUSTRY))) do
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
			out[#out + 1] = rec
		end
	end
	return out
end

local function collectDepots(player)
	local out = {}
	for _, d in ipairs(arr(api.engine.getEntitiesWithComponent(api.type.ComponentType.VEHICLE_DEPOT))) do
		local owned = api.engine.getComponent(d, api.type.ComponentType.PLAYER_OWNED)
		if owned and owned.player == player then
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
			out[#out + 1] = rec
		end
	end
	return out
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

-- ---------------------------------------------------------------- snapshot
local seq = 0
local lastFast, lastSlow = -1e9, -1e9
local slowCache = nil
local announced = false

local function buildSnapshot(doSlow)
	seq = seq + 1
	local snap = { schema = SCHEMA, mod = MOD_ID, seq = seq, real_time = os.time(), errors = {} }
	local player = api.engine.util.getPlayer()
	snap.player = num(player)
	local refreshSlow = doSlow or not slowCache
	local names, keys = cargoNames(refreshSlow)
	if refreshSlow then gameLanguage(true) end

	section(snap, "time", collectTime)
	section(snap, "finance", function() return collectFinance(player) end)
	section(snap, "alerts", function() return collectAlerts(player) end)
	if options().export_vehicles then
		section(snap, "vehicles", collectVehicles)
	end

	if doSlow or not slowCache then
		local slow = { errors = {} }
		section(slow, "company", collectCompany)
		section(slow, "lines", function() return collectLines(player, names) end)
		section(slow, "stations", function() return collectStations(player) end)
		section(slow, "towns", function() return collectTowns(names) end)
		section(slow, "industries", function() return collectIndustries(names) end)
		section(slow, "depots", function() return collectDepots(player) end)
		slow.cargo_types = {}
		for id, n in pairs(names) do slow.cargo_types[#slow.cargo_types + 1] = { id = id, name = n, key = keys[id] } end
		slow.collected_seq = seq
		slowCache = slow
	end
	for k, v in pairs(slowCache) do
		if k == "errors" then
			for _, e in ipairs(v) do snap.errors[#snap.errors + 1] = e end
		else
			snap[k] = v
		end
	end
	snap.slow_seq = slowCache.collected_seq
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

-- ---------------------------------------------------------------- commands (dashboard -> game)
-- The dashboard writes <userdata>\dashboard_export\cmd.lua :
--   function data() return { id = <number>, cmd = "<name>", args = { ... } } end
-- Each file is executed once (dedup on id), then removed. The result is reported in the next
-- snapshot under snapshot.cmd_ack = { id, cmd, ok, error, real_time }.
-- Only a short whitelist of harmless, reversible actions is accepted (no buy/sell/destroy).
local lastCmdId = nil
local lastAck = nil

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
				local load, maxLoad = {}, {}
				for k in pairs(api.res.cargoTypeRep.getAll(true)) do
					local id = num(k)
					load[id + 1] = not blocked[id]
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

local function cmdFileExists()
	local ok, list = pcall(app.getAllUserdata, DIR)
	if not ok or type(list) ~= "table" then return false end
	for _, n in pairs(list) do
		if n == CMD_FILE or n == CMD_FILE .. ".lua" then return true end
	end
	return false
end

local function pollCommands()
	if not options().accept_commands then return end
	-- loadUserdata logs a warning when the file is missing: check the listing first
	if not cmdFileExists() then return end
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
		local okP, errP = pcall(pollCommands)
		if not okP then debug("pollCommands failed:", tostring(errP)) end
	end
	if now - lastFast < o.interval_fast then return end
	local doSlow = (now - lastSlow) >= o.interval_slow
	local ok, snap = pcall(buildSnapshot, doSlow)
	if not ok then
		log("snapshot failed:", tostring(snap))
		lastFast = now
		return
	end
	lastFast = now
	if doSlow then lastSlow = now end
	if writeSnapshot(snap) then
		if not announced then
			announced = true
			local folder = ""
			pcall(function() folder = app.getUserDataFolder() end)
			log(string.format("writing %s/%s.lua every %ds (slow sections every %ds) under %s", DIR, FILE, o.interval_fast, o.interval_slow, tostring(folder)))
		end
		debug(string.format("seq %d written, %d error(s), %d vehicles", snap.seq, #snap.errors, snap.vehicles and #snap.vehicles or 0))
	end
end

-- .script.lua resources expose their exports through data(), not a return value
function data()
	return script
end
