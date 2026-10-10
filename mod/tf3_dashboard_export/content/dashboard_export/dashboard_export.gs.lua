-- Resource name "tf3_dashboard_export::/dashboard_export/dashboard_export.gs" identifies the saved
-- mod state. Never rename or move this file after release.
-- guiHandleEvent answers the status window's reads; handleEvent only subscribes to the event name.
function data()
	return {
		updateScript = { fileName = "dashboard_export.script@update" },
		handleEventScript = { fileName = "dashboard_export.script@handleEvent" },
		guiUpdateScript = { fileName = "dashboard_export.script@guiUpdate" },
		guiHandleEventScript = { fileName = "dashboard_export.script@guiHandleEvent" },
	}
end
