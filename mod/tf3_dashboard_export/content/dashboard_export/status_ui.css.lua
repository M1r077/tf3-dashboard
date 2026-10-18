local ssu = require "::/gui/main/stylesheetutil.lua"

-- The status button looks like the other buttons of the mod button area (rev 26): the game's dark square
-- ToggleButton, 32 points, a 24-point icon, a 1-point gap to the button before it (as Traffic Light Tools does).
function data()
	local result = {}
	local a = ssu.makeAdder(result)
	a("R::TF3DashboardStatusButton ToggleButton!tf3-dashboard-status-button", {
		size = { 32, 32 }, minSize = { 32, 32 }, maxSize = { 32, 32 },
		padding = { 4, 4, 4, 4 }, margin = { 0, 0, 0, 1 }, gravity = { 0.5, 0.5 },
	})
	a("R::TF3DashboardStatusButton !tf3-dashboard-status-icon", {
		size = { 24, 24 }, minSize = { 24, 24 }, maxSize = { 24, 24 }, gravity = { 0.5, 0.5 },
	})
	return result
end
