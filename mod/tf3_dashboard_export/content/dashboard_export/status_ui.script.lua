-- Status button and window (rev 9): a small button in the game's mod button area (the same place other mods put
-- theirs), coloured by the state of the export, and a window with the state of the export and the mod settings,
-- changeable during the game.
--
-- Nothing here runs per frame. The button is rendered once and re-rendered when the export script fires
-- "TF3DashboardStatus" (only when the state changes). The window reads the script state once when it opens
-- (api.gui.fireGuiScriptEvent -> guiHandleEvent) and after each change it makes; settings go through
-- api.cmd.makeScriptingSendEventCmd -> handleEvent, where they are stored in the savegame.

local react = ug_require "::/gui/main/react.lua"
local builtin = ug_require "::/gui/main/builtin.lua"
local gameGlobals = ug_require "::/gui/main/game_react_globals.tl"
local styleutil = ug_require "::/gui/main/styleutil.tl"

local UI_ID = "TF3_DASHBOARD_EXPORT"
local STATUS_EVENT = "TF3DashboardStatus"
local REFRESH_EVENT = "TF3DashboardRefresh"
local ICON = "::/gui/context_helper/icons/menu_charts@2x.tga"
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

local function tr(key) return _(key) end

local function style(def)
	local result = styleutil.makeStyle(def)
	if def.padding then
		local p = def.padding
		result.padding = api.type.Vec4f.new(p[1], p[2], p[3], p[4])
	end
	return result
end

local function text(value, class, extra)
	local meta = { class = class or "font-scale-body" }
	if extra then for k, v in pairs(extra) do meta[k] = v end end
	return builtin.TextView { text = value, meta = meta }
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
	local pending = react.useState(false)
	local function refresh() data:set(readState()) end
	react.onMount(refresh)
	react.onEvent(STATUS_EVENT, refresh)
	react.onEvent(REFRESH_EVENT, function() pending:set(false); refresh() end)

	local function send(name, param)
		if pending:old() then return end
		pending:set(true)
		api.cmd.sendCommand(api.cmd.makeScriptingSendEventCmd("", UI_ID, name, param), function()
			api.gui.fireReactEvent(REFRESH_EVENT, {})
		end)
	end

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
			children[#children + 1] = text(tostring(st.last_error), "font-scale-small", { tooltipWhenClipped = tostring(st.last_error),
				styleSheet = style({ size = { WIDTH - 24, 22 } }) })
		end
		children[#children + 1] = text(tr("status_error_help"), "font-scale-small", { styleSheet = style({ size = { WIDTH - 24, 60 } }) })
	end
	if st and st.folder then
		children[#children + 1] = text(tr("status_folder") .. " " .. tostring(st.folder), "font-scale-small",
			{ tooltipWhenClipped = tostring(st.folder), styleSheet = style({ size = { WIDTH - 24, 22 } }) })
	end
	if st then
		local a = ago(st.now, st.companion_seen)
		children[#children + 1] = text(a and (tr("status_companion_seen") .. " " .. a) or tr("status_companion_never"), "font-scale-small")
	end

	-- settings
	children[#children + 1] = text(tr("status_settings"), "font-scale-title-2", { styleSheet = style({ padding = { 10, 0, 4, 0 } }) })
	children[#children + 1] = text(tr("status_settings_help"), "font-scale-small", { styleSheet = style({ size = { WIDTH - 24, 44 } }) })
	for _, s in ipairs(SETTINGS) do
		local buttons = {}
		for i, label in ipairs(s.labels) do
			local shown = label:match("^param_") and tr(label) or label
			local isDefault = d and d.default and d.default[s.key] == i
			buttons[i] = { content = text(shown .. (isDefault and " *" or "")) }
		end
		local current = (d and d.current and d.current[s.key]) or 1
		children[#children + 1] = row({
			text(tr(s.name), "font-scale-body", { tooltip = tr(s.tooltip), styleSheet = style({ size = { 150, 30 }, padding = { 6, 0, 0, 0 } }) }),
			builtin.ToggleButtonGroup {
				meta = { enabled = not pending:old(), styleSheet = style({ size = { WIDTH - 24 - 150, 30 } }) },
				buttons = buttons,
				selected = current,
				layout = "Uniform",
				onValueChange = function(index)
					if index ~= current then send("set", { key = s.key, index = index }) end
				end,
			},
		})
	end
	children[#children + 1] = row({
		text(tr("status_default_hint"), "font-scale-small", { styleSheet = style({ size = { WIDTH - 24 - 130, 30 }, padding = { 6, 0, 0, 0 } }) }),
		builtin.Button {
			meta = { enabled = (not pending:old()) and (d ~= nil and d.overridden == true), class = "secondary",
				tooltip = tr("status_reset_tip"), styleSheet = style({ size = { 130, 30 } }) },
			content = text(tr("status_reset")),
			onClick = function() send("reset", {}) end,
		},
	})

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
