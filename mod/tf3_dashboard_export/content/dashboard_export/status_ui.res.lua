-- Puts the status button of the mod in the game's mod button area (gui/main/main_mod_button_area.tl).
function data()
	return {
		type = "react-plugin ::MainModButtonAreaExtension",
		data = {
			filePath = "tf3_dashboard_export::/dashboard_export/status_ui.script@MainButton",
			order = 60,
		},
	}
end
