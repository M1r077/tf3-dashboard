return {
  schema = 1, mod = "tf3_dashboard_export", seq = 3, slow_seq = 3, real_time = 1791270000, player = 12345, errors = { { section = "depots", error = "x" } },
  time = { game_time_ms = 123456789, year = 1902, month = 5, day = 17, speed = 1, millis_per_day = 2000, tick = 10, update_count = 9, time_of_day_sec = 43200 },
  finance = { balance = 1500000, loan = 200000, earnings_year_to_date = 35000, passengers_transported = 420, cargo_transported = 99 },
  company = { totalScore = 1200, railVehicles = 2, numberOfLines = 3, trackTotalLength = 12345.5 },
  alerts = { line_problems = { { line = 501, type = 4, pos = { x = 1, y = 2, z = 3 } } }, blocked_trains = {}, no_path_vehicles = { 777 }, vehicle_problems = { { vehicles = { 777 }, type = 3 } } },
  vehicles = { { id = 777, name = "Loco 1", carrier = "RAIL", state = "EN_ROUTE", line = 501, pos = { x = 10.5, y = -20, z = 300 }, speed = 22.2, load = 40, capacity = 120, maintenance = 0.9 } },
  lines = { { id = 501, name = "L1", stops = 2, vehicles = 1, color = { x = 1, y = 0, z = 0 }, quality = { pax_bad = 1, pax_total = 10 }, capacity = { { cargo_type = 0, used = 40, capacity = 120 } }, stop_list = { { station_group = 9, station = 0, terminal = 1, name = "Gare A" }, { station_group = 10, station = 0, terminal = 0, name = "Gare B" } }, transport_modes = { 2, 3 } } },
  stations = { { id = 31, name = "Gare A", town = 7, cargo = false, used = 5, overflow = 0, pos = { x = 0, y = 0, z = 0 } } },
  towns = { { id = 7, name = "Nyon", development_active = true, cap_res = 100, cap_com = 50, cap_ind = 30, usage = { { used = 90, capacity = 100 }, { used = 40, capacity = 50 }, { used = 10, capacity = 30 } }, happiness = { inside = { unhappy = 2, total = 20 }, byLine = {} }, stock = { { cargo_type = 5, stock = 3, capacity = 10 } }, top_lines = { { line = 501, resident = { unhappy = 1, total = 8 }, non_resident = { unhappy = 0, total = 2 } } } } },
  industries = { { id = 88, name = "Scierie", level = 1, max_level = 4, stock_list = 89, inputs = { { cargo_type = 2, consumed_year = 50, max_consumption_year = 100 } }, outputs = { { cargo_type = 3, produced_year = 45, max_production_year = 100, shipped_year = 40 } } } },
  depots = { { id = 60, name = "Depot", carrier = "RAIL", vehicles = 1, incoming = 0 } },
  cargo_types = { { id = 0, name = "PASSENGERS" }, { id = 2, name = "LOGS" }, { id = 3, name = "PLANKS" }, { id = 5, name = "FOOD" } },
}
