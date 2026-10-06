-- Resource name "tf3_dashboard_export::/dashboard_export/dashboard_export.gs" identifies the saved
-- mod state. Never rename or move this file after release.
function data()
	return {
		updateScript = { fileName = "dashboard_export.script@update" },
		guiUpdateScript = { fileName = "dashboard_export.script@guiUpdate" },
	}
end
