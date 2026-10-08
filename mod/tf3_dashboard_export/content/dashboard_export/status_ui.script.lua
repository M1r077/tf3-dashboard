-- Status button and window (rev 10): a small button in the game's mod button area (the same place other mods put
-- theirs), coloured by the state of the export, and a window with the state of the export and the current mod
-- settings. Read-only: settings are changed in the game's mod menu when loading the game, like any other mod.
--
-- Nothing here runs per frame. The button is rendered once and re-rendered when the export script fires
-- "TF3DashboardStatus" (only when the state changes). The window reads the script state once when it opens
-- (api.gui.fireGuiScriptEvent -> guiHandleEvent) and again on each status change.

local react = ug_require "::/gui/main/react.lua"
local builtin = ug_require "::/gui/main/builtin.lua"
local gameGlobals = ug_require "::/gui/main/game_react_globals.tl"
local styleutil = ug_require "::/gui/main/styleutil.tl"

local UI_ID = "TF3_DASHBOARD_EXPORT"
local STATUS_EVENT = "TF3DashboardStatus"
local ICON = "::/gui/line_vehicle_mgmt/icons/symbol_info_outline@2x.tga"  -- the game's "i" symbol; readable at 16 px
-- the settings in the order of mod.json; labels and value labels reuse the mod.json strings
local SETTINGS = {
	{ key = "interval_fast", name = "param_interval_fast_name", tooltip = "param_interval_fast_tooltip", labels = { "1 s", "2 s", "5 s", "10 s" } },
	{ key = "interval_slow", name = "param_interval_slow_name", tooltip = "param_interval_slow_tooltip", labels = { "10 s", "30 s", "60 s", "120 s" } },
	{ key = "export_vehicles", name = "param_export_vehicles_name", tooltip = "param_export_vehicles_tooltip", labels = { "param_on", "param_off" } },
	{ key = "accept_commands", name = "param_accept_commands_name", tooltip = "param_accept_commands_tooltip", labels = { "param_off", "param_on" } },
	{ key = "debug_log", name = "param_debug_log_name", tooltip = "param_debug_log_tooltip", labels = { "param_off", "param_on" } },
}
local COLORS = {
	ok = { 0.30, 0.75, 0.40, 1 },
	error = { 0.85, 0.30, 0.25, 1 },
	starting = { 0.55, 0.55, 0.55, 1 },
}
local WIDTH = 420
local WRAP = 52  -- characters per line for the small texts (TextViews do not wrap by themselves; 420 px, body font)

local function tr(key) return _(key) end

local function style(def)
	local result = styleutil.makeStyle(def)
	if def.padding then
		local p = def.padding
		result.padding = api.type.Vec4f.new(p[1], p[2], p[3], p[4])
	end
	return result
end

local function text(value, class, extra, clipTip)
	local meta = { class = class or "font-scale-body" }
	if extra then for k, v in pairs(extra) do meta[k] = v end end
	-- tooltipWhenClipped is a TextView parameter, not a meta entry (a meta entry breaks the window's state update)
	return builtin.TextView { text = value, meta = meta, tooltipWhenClipped = clipTip }
end
-- TextViews do not wrap: long texts are broken into lines here (the game does the same in its context help).
-- One sentence per line; a sentence longer than `width` characters is broken at word boundaries.
local function wrap(value, width)
	local lines = {}
	for sentence in (tostring(value) .. " "):gmatch("(.-[%.!?])%s+") do
		local cur = ""
		for word in sentence:gmatch("%S+") do
			if cur == "" then cur = word
			elseif #cur + 1 + #word > width then lines[#lines + 1] = cur; cur = word
			else cur = cur .. " " .. word end
		end
		if cur ~= "" then lines[#lines + 1] = cur end
	end
	if #lines == 0 then return tostring(value) end
	return table.concat(lines, "\n")
end

-- a path is broken at its separators
local function wrapPath(value, width)
	local lines, cur = {}, ""
	for part in tostring(value):gmatch("[^/\\]+[/\\]?") do
		if cur ~= "" and #cur + #part > width then lines[#lines + 1] = cur; cur = "" end
		cur = cur .. part
	end
	if cur ~= "" then lines[#lines + 1] = cur end
	return table.concat(lines, "\n")
end
local function row(children) return builtin.BoxLayout { orientation = builtin.type.Orientation.Horizontal, children = children } end
local function column(children) return builtin.BoxLayout { orientation = builtin.type.Orientation.Vertical, children = children } end

local function readState()
	local ok, res = pcall(api.gui.fireGuiScriptEvent, UI_ID, "read", {})
	if ok and type(res) == "table" then return res end
	return nil
end

local function ago(now, t)
	if type(t) ~= "number" or type(now) ~= "number" then return nil end
	local d = now - t
	if d < 0 then d = 0 end
	if d < 60 then return string.format(tr("status_ago_s"), d) end
	if d < 3600 then return string.format(tr("status_ago_m"), math.floor(d / 60)) end
	return string.format(tr("status_ago_h"), math.floor(d / 3600))
end

local function stateLine(st)
	if st == nil then return tr("status_unknown"), COLORS.starting end
	if st.state == "ok" then
		local a = ago(st.now, st.last_ok)
		return tr("status_ok") .. (a and (" (" .. a .. ")") or ""), COLORS.ok
	elseif st.state == "error" then
		return tr("status_error"), COLORS.error
	end
	return tr("status_starting"), COLORS.starting
end

local StatusWindow
local function closeWindow()
	local windows = gameGlobals.getDefaultWindowApi()
	if windows then windows.removeAllWindows(StatusWindow) end
end

StatusWindow = react.RegisterWrapperRecipe("TF3DashboardStatusWindow", builtin.Window, function()
	local data = react.useState(nil)
	local function refresh() data:set(readState()) end
	react.onMount(refresh)
	react.onEvent(STATUS_EVENT, refresh)
	-- "x s ago" and "companion seen" move while the window is open: re-read every 2 s (one gui script event, nothing
	-- heavy), only while the window exists
	react.onStepTimer(refresh, 2.0)

	local d = data:old()
	local st = d and d.status or nil
	local line, color = stateLine(st)
	local children = {}

	-- state
	children[#children + 1] = row({
		builtin.Component { meta = { styleSheet = style({ size = { 10, 10 }, backgroundColor = color }) }, layout = column({}) },
		text(line, "font-scale-body", { styleSheet = style({ padding = { 0, 8, 0, 0 } }) }),
	})
	if st and st.state == "error" then
		if st.last_error then
			children[#children + 1] = text(wrap(st.last_error, WRAP), "font-scale-small")
		end
		children[#children + 1] = text(wrap(tr("status_error_help"), WRAP), "font-scale-small")
	end
	if st and st.folder then
		children[#children + 1] = text(tr("status_folder"), "font-scale-small", { styleSheet = style({ padding = { 6, 0, 0, 0 } }) })
		children[#children + 1] = text(wrapPath(st.folder, WRAP), "font-scale-small")
	end
	if st then
		local a = ago(st.now, st.companion_seen)
		children[#children + 1] = text(a and (tr("status_companion_seen") .. " " .. a) or tr("status_companion_never"), "font-scale-small")
	end

	-- settings (read-only)
	children[#children + 1] = text(tr("status_settings"), "font-scale-title-2", { styleSheet = style({ padding = { 10, 0, 4, 0 } }) })
	children[#children + 1] = text(wrap(tr("status_settings_help"), WRAP), "font-scale-small")
	for _, s in ipairs(SETTINGS) do
		local current = d and d.current and d.current[s.key] or nil
		local label = current and s.labels[current] or nil
		local shown = label and (label:match("^param_") and tr(label) or label) or "-"
		children[#children + 1] = row({
			text(tr(s.name), "font-scale-body", { tooltip = tr(s.tooltip), styleSheet = style({ size = { 220, 26 }, padding = { 2, 0, 0, 0 } }) }),
			text(shown, "font-scale-body", { styleSheet = style({ size = { WIDTH - 24 - 220, 26 }, padding = { 2, 0, 0, 0 } }) }),
		})
	end

	return builtin.Window {
		id = "tf3-dashboard-status-window",
		title = tr("status_title"),
		closable = true, movable = true, pinnable = false,
		onClose = closeWindow, initialX = 0.5, initialY = 0.5,
		content = builtin.Component { meta = { styleSheet = style({ padding = { 12, 12, 12, 12 }, size = { WIDTH, -1 } }) }, layout = column(children) },
	}
end)

local MainButton = react.RegisterRecipe("TF3DashboardStatusButton", function()
	local state = react.useState("starting")
	react.onMount(function()
		local d = readState()
		if d and d.status then state:set(d.status.state) end
	end)
	react.onEvent(STATUS_EVENT, function(_, param)
		if type(param) == "table" and param.state then state:set(param.state) end
	end)
	local color = COLORS[state:old()] or COLORS.starting
	return row({ builtin.Button {
		meta = { class = "secondary", tooltip = tr("status_button_tip"),
			styleSheet = style({ size = { 24, 24 }, padding = { 3, 3, 3, 3 }, borderColor = color, borderWidth = { 0, 0, 2, 0 } }) },
		content = builtin.ImageView { path = ICON, scaling = builtin.type.ImageViewScaling.AutoFit,
			meta = { styleSheet = style({ size = { 16, 16 } }) } },
		onClick = function()
			local windows = gameGlobals.getDefaultWindowApi()
			if windows then windows.addSingletonWindow(StatusWindow, {}) end
		end,
	} })
end)

-- .script.lua resources expose their exports through data(), not a return value
function data()
	return { MainButton = MainButton, StatusWindow = StatusWindow }
end
