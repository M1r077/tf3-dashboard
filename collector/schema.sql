-- TF3 Dashboard database. One row per snapshot in `snapshot`; every other time-series table
-- references it through snapshot_id. Entities (vehicles, lines, towns...) have a dimension table
-- (current attributes, upserted) and a fact table (one row per snapshot where they were seen).
-- All ids are the game's entity ids; they are only unique within one savegame -> `game_id`.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game (
    game_id        INTEGER PRIMARY KEY,
    key            TEXT NOT NULL UNIQUE,          -- stable key: player entity + first seen date
    player_entity  INTEGER,
    first_seen     TEXT NOT NULL,                 -- ISO real time
    last_seen      TEXT NOT NULL,
    note           TEXT,
    lang           TEXT                           -- game UI language code (fr, en, de, zh_CN...)
);

CREATE TABLE IF NOT EXISTS snapshot (
    snapshot_id    INTEGER PRIMARY KEY,
    game_id        INTEGER NOT NULL REFERENCES game(game_id),
    seq            INTEGER NOT NULL,              -- mod sequence number (restarts with the game)
    slow_seq       INTEGER,                       -- seq at which the slow sections were collected
    real_time      TEXT NOT NULL,                 -- ISO, from os.time() in the mod
    received_at    TEXT NOT NULL,                 -- ISO, collector clock
    game_time_ms   INTEGER,
    year           INTEGER,
    month          INTEGER,
    day            INTEGER,
    time_of_day_s  INTEGER,
    speed          INTEGER,                       -- 0 = paused
    millis_per_day INTEGER,
    tick           INTEGER,
    update_count   INTEGER,
    n_errors       INTEGER NOT NULL DEFAULT 0,
    accept_commands INTEGER,                      -- mod param: dashboard -> game commands allowed
    cmd_ack        TEXT,                          -- JSON {id, cmd, ok, error, real_time} of the last executed command
    camera         TEXT,                          -- JSON {x, y, dist, angle, pitch, follow?} where the player looks (mod rev 7+)
    UNIQUE (game_id, seq, real_time)
);
CREATE INDEX IF NOT EXISTS ix_snapshot_time ON snapshot(game_id, real_time);
CREATE INDEX IF NOT EXISTS ix_snapshot_game_time ON snapshot(game_id, game_time_ms);

CREATE TABLE IF NOT EXISTS snapshot_error (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    section     TEXT NOT NULL,
    error       TEXT
);

-- ---------------------------------------------------------------- finance / company
CREATE TABLE IF NOT EXISTS finance (
    snapshot_id            INTEGER PRIMARY KEY REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    balance                INTEGER,
    bank_balance           INTEGER,
    loan                   INTEGER,
    earnings_ytd           INTEGER,
    passengers_transported INTEGER,
    cargo_transported      INTEGER
);

CREATE TABLE IF NOT EXISTS company (
    snapshot_id          INTEGER PRIMARY KEY REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    total_score          INTEGER,
    rail_vehicles        INTEGER,
    trams                INTEGER,
    road_vehicles        INTEGER,
    aircrafts            INTEGER,
    ships                INTEGER,
    track_length_m       REAL,
    track_electric_m     REAL,
    bridge_length_m      REAL,
    tunnel_length_m      REAL,
    road_length_m        REAL,
    supplied_towns       INTEGER,
    connected_industries INTEGER,
    number_of_lines      INTEGER,
    total_stations       INTEGER,
    rail_stations        INTEGER,
    tram_stations        INTEGER,
    road_stations        INTEGER,
    aircraft_stations    INTEGER,
    ship_stations        INTEGER,
    top_speed            REAL,
    top_length           REAL,
    oldest_vehicle       INTEGER,
    total_assets         INTEGER,
    debt                 INTEGER
);

-- ---------------------------------------------------------------- reference data
CREATE TABLE IF NOT EXISTS cargo_type (
    game_id   INTEGER NOT NULL REFERENCES game(game_id),
    cargo_id  INTEGER NOT NULL,
    name      TEXT,                                -- localized display name (game language)
    key       TEXT,                                -- language-neutral key from the resource file ("grain")
    PRIMARY KEY (game_id, cargo_id)
);

-- ---------------------------------------------------------------- vehicles
CREATE TABLE IF NOT EXISTS vehicle (
    game_id     INTEGER NOT NULL REFERENCES game(game_id),
    vehicle_id  INTEGER NOT NULL,
    name        TEXT,
    carrier     TEXT,
    capacity    INTEGER,
    icon_type   TEXT,                             -- Bus/Truck/TrainSteam/TrainElectric/TrainDiesel/Tram/Aircraft/Helicopter/Ship
    model       TEXT,                             -- localized model name of the leading part
    model_key   TEXT,                             -- language-neutral key of the leading part ("train/alco_hh600") -> icons/vehicles/
    parts       TEXT,                             -- all parts in consist order, comma separated, "-" prefix = reversed
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    PRIMARY KEY (game_id, vehicle_id)
);

CREATE TABLE IF NOT EXISTS vehicle_state (
    snapshot_id      INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    vehicle_id       INTEGER NOT NULL,
    line_id          INTEGER,
    state            TEXT,                       -- IN_DEPOT / EN_ROUTE / AT_TERMINAL / GOING_TO_DEPOT
    stop_index       INTEGER,
    x REAL, y REAL, z REAL,
    speed_ms         REAL,
    load             INTEGER,
    maintenance      REAL,
    running_cost     REAL,
    value            INTEGER,
    user_stopped     INTEGER,
    no_path          INTEGER,
    doors_open       INTEGER,
    depot_id         INTEGER,
    days_in_depot    INTEGER,
    days_at_terminal INTEGER,
    closest_town     INTEGER,
    cargo            TEXT,                       -- mod rev 8+: JSON {"<cargo id>": count} of what is on board
    PRIMARY KEY (snapshot_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS ix_vehicle_state_vehicle ON vehicle_state(vehicle_id, snapshot_id);

-- ---------------------------------------------------------------- lines
CREATE TABLE IF NOT EXISTS line (
    game_id    INTEGER NOT NULL REFERENCES game(game_id),
    line_id    INTEGER NOT NULL,
    name       TEXT,
    color_r REAL, color_g REAL, color_b REAL,
    transport_modes TEXT,                         -- JSON array of mode ids
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    custom_filters INTEGER,                       -- line uses per-stop cargo filters
    reservation_priority REAL,                    -- 1 standard, 2 high, 3 very high
    PRIMARY KEY (game_id, line_id)
);

CREATE TABLE IF NOT EXISTS line_state (
    snapshot_id     INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    line_id         INTEGER NOT NULL,
    stops           INTEGER,
    vehicles        INTEGER,
    max_frequency   REAL,
    throughput      INTEGER,
    persons_on_line INTEGER,
    pax_bad         INTEGER,
    pax_total       INTEGER,
    pax_avg_quality REAL,
    cargo_bad       INTEGER,
    cargo_total     INTEGER,
    cargo_avg_quality REAL,
    PRIMARY KEY (snapshot_id, line_id)
);

CREATE TABLE IF NOT EXISTS line_capacity (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    line_id     INTEGER NOT NULL,
    cargo_id    INTEGER NOT NULL,
    used        REAL,
    capacity    REAL,
    PRIMARY KEY (snapshot_id, line_id, cargo_id)
);

CREATE TABLE IF NOT EXISTS line_stop (
    game_id       INTEGER NOT NULL REFERENCES game(game_id),
    line_id       INTEGER NOT NULL,
    stop_index    INTEGER NOT NULL,
    station_group INTEGER,
    station       INTEGER,
    terminal      INTEGER,
    name          TEXT,
    slow_seq      INTEGER,                        -- last refresh
    -- departure configuration (editable from the dashboard via line_set_stop)
    load_mode     INTEGER,                        -- 0 load if available, 1 full load any, 2 full load all
    min_wait      REAL,                           -- seconds
    max_wait      REAL,                           -- seconds, -1 = unlimited
    max_add_wait  REAL,                           -- seconds
    waypoints     INTEGER,                        -- number of waypoints after this stop
    force_unload  INTEGER,
    destroy_for_config_change INTEGER,
    destroy_for_refresh INTEGER,
    no_load       TEXT,                           -- JSON list of cargo ids NOT loaded here (NULL = everything allowed)
    max_load      TEXT,                           -- JSON list of {cargo_type, max} for cargo limited below 100 %
    terminals     TEXT,                           -- JSON list of the station group terminals {n, station, terminal, pax, cargo, class, class_name, class_color, length, speed_mod, compatible, overlength}
    alternatives  TEXT,                           -- JSON list of {station, terminal} the stop may use besides the main one (station/terminal above)
    PRIMARY KEY (game_id, line_id, stop_index)
);

-- ---------------------------------------------------------------- stations
CREATE TABLE IF NOT EXISTS station (
    game_id       INTEGER NOT NULL REFERENCES game(game_id),
    station_id    INTEGER NOT NULL,
    name          TEXT,
    town_id       INTEGER,
    station_group INTEGER,
    is_cargo      INTEGER,
    construction  TEXT,
    x REAL, y REAL, z REAL,
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL,
    PRIMARY KEY (game_id, station_id)
);

CREATE TABLE IF NOT EXISTS station_state (
    snapshot_id       INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    station_id        INTEGER NOT NULL,
    used              INTEGER,
    overflow          INTEGER,
    pool_capacity     INTEGER,
    terminal_capacity INTEGER,
    lines             INTEGER,
    PRIMARY KEY (snapshot_id, station_id)
);

-- ---------------------------------------------------------------- towns
CREATE TABLE IF NOT EXISTS town (
    game_id    INTEGER NOT NULL REFERENCES game(game_id),
    town_id    INTEGER NOT NULL,
    name       TEXT,
    x REAL, y REAL, z REAL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (game_id, town_id)
);

CREATE TABLE IF NOT EXISTS town_state (
    snapshot_id        INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    town_id            INTEGER NOT NULL,
    development_active INTEGER,
    cap_res INTEGER, cap_com INTEGER, cap_ind INTEGER,
    used_res INTEGER, used_com INTEGER, used_ind INTEGER,
    stations           INTEGER,
    buildings          INTEGER,
    noise_db           REAL,
    pollution_db       REAL,
    area_km2           REAL,
    line_usage         REAL,                      -- fraction of people using lines
    traffic_speed      REAL,
    congestion_levels  TEXT,                      -- JSON array
    reach_com_private INTEGER, reach_com_public INTEGER, reach_ind_private INTEGER, reach_ind_public INTEGER,
    -- happiness: unhappy / total per mode
    hap_inside_unhappy INTEGER, hap_inside_total INTEGER,
    hap_building_unhappy INTEGER, hap_building_total INTEGER,
    hap_car_unhappy INTEGER, hap_car_total INTEGER,
    hap_walk_unhappy INTEGER, hap_walk_total INTEGER,
    hap_to_res_unhappy INTEGER, hap_to_res_total INTEGER,
    hap_to_nonres_unhappy INTEGER, hap_to_nonres_total INTEGER,
    hap_from_res_unhappy INTEGER, hap_from_res_total INTEGER,
    hap_from_nonres_unhappy INTEGER, hap_from_nonres_total INTEGER,
    PRIMARY KEY (snapshot_id, town_id)
);

CREATE TABLE IF NOT EXISTS town_cargo (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    town_id     INTEGER NOT NULL,
    cargo_id    INTEGER NOT NULL,
    stock       INTEGER,
    capacity    INTEGER,
    PRIMARY KEY (snapshot_id, town_id, cargo_id)
);

-- townBuildingSystem.getCargoSupplyAndLimit(town[, landUse]) = the "supplied / needed" figures of the town window.
-- land_use 0 = whole town (mod rev 4 also wrote 1 = commercial, 2 = industrial; dropped in rev 5, same figures).
-- v1 = supplied, v2 = needed (decimals, the game rounds), v3 = internal group id (not displayed).
CREATE TABLE IF NOT EXISTS town_supply (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    town_id     INTEGER NOT NULL,
    land_use    INTEGER NOT NULL,
    cargo_id    INTEGER NOT NULL,
    v1          REAL,
    v2          REAL,
    v3          REAL,
    PRIMARY KEY (snapshot_id, town_id, land_use, cargo_id)
);

CREATE TABLE IF NOT EXISTS town_top_line (
    snapshot_id         INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    town_id             INTEGER NOT NULL,
    line_id             INTEGER NOT NULL,
    resident_unhappy INTEGER, resident_total INTEGER,
    nonresident_unhappy INTEGER, nonresident_total INTEGER,
    PRIMARY KEY (snapshot_id, town_id, line_id)
);

-- ---------------------------------------------------------------- industries
CREATE TABLE IF NOT EXISTS industry (
    game_id       INTEGER NOT NULL REFERENCES game(game_id),
    industry_id   INTEGER NOT NULL,
    name          TEXT,
    construction  TEXT,
    stock_list    INTEGER,
    max_level     INTEGER,
    x REAL, y REAL, z REAL,
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL,
    PRIMARY KEY (game_id, industry_id)
);

CREATE TABLE IF NOT EXISTS industry_state (
    snapshot_id       INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    industry_id       INTEGER NOT NULL,
    level             INTEGER,
    upgrade_progress  REAL,
    closure_time      INTEGER,
    manual            INTEGER,
    producing         INTEGER,
    boost_rule        INTEGER,
    boost_persons     INTEGER,
    production_rating REAL,
    thrown_away       INTEGER,
    PRIMARY KEY (snapshot_id, industry_id)
);

CREATE TABLE IF NOT EXISTS industry_cargo (
    snapshot_id     INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    industry_id     INTEGER NOT NULL,
    cargo_id        INTEGER NOT NULL,
    direction       TEXT NOT NULL,                -- 'in' / 'out'
    produced_year   INTEGER,
    max_prod_year   INTEGER,
    shipped_year    INTEGER,
    consumed_year   INTEGER,
    max_cons_year   INTEGER,
    delivered_year  INTEGER,
    PRIMARY KEY (snapshot_id, industry_id, cargo_id, direction)
);

-- ---------------------------------------------------------------- depots
CREATE TABLE IF NOT EXISTS depot (
    game_id    INTEGER NOT NULL REFERENCES game(game_id),
    depot_id   INTEGER NOT NULL,
    name       TEXT,
    carrier    TEXT,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (game_id, depot_id)
);

CREATE TABLE IF NOT EXISTS depot_state (
    snapshot_id      INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    depot_id         INTEGER NOT NULL,
    vehicles         INTEGER,
    incoming         INTEGER,
    maintenance_pool INTEGER,
    pool_max         REAL,
    pool_avg         REAL,
    PRIMARY KEY (snapshot_id, depot_id)
);

-- ---------------------------------------------------------------- alerts (one row per alert per snapshot)
CREATE TABLE IF NOT EXISTS alert (
    snapshot_id INTEGER NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                    -- line_problem, line_issue, vehicle_problem, blocked_train, no_path_vehicle,
                                                  -- town_problem, closing_industry, thrown_away_cargo
    entity_id   INTEGER,                          -- main entity (line, vehicle, train, town, industry, stock list)
    related_id  INTEGER,                          -- e.g. blocking train, cargo type
    type_code   INTEGER,                          -- game enum value when available
    stop_index  INTEGER,
    amount      INTEGER,
    x REAL, y REAL, z REAL,
    detail      TEXT                              -- JSON for anything else
);
CREATE INDEX IF NOT EXISTS ix_alert_snapshot ON alert(snapshot_id, kind);

-- ---------------------------------------------------------------- aggregates (retention)
-- Detail rows (one per snapshot, every ~2 s) are kept for `detail_hours`; older snapshots are rolled up into
-- one row per minute bucket (bucket = unix minute of real_time) and the detail rows are deleted (CASCADE).
-- The aggregates are filled continuously by the collector (for closed minutes), so charts can read
-- detail + aggregate seamlessly.
CREATE TABLE IF NOT EXISTS agg_meta (
    game_id     INTEGER NOT NULL PRIMARY KEY REFERENCES game(game_id),
    agg_until   INTEGER NOT NULL DEFAULT 0      -- unix minute (inclusive) up to which aggregates are complete
);

CREATE TABLE IF NOT EXISTS agg_fleet_min (
    game_id      INTEGER NOT NULL,
    bucket       INTEGER NOT NULL,              -- unix time (s) of the minute start
    n            INTEGER NOT NULL,              -- snapshots folded into this bucket
    game_time_ms INTEGER, year INTEGER, month INTEGER, day INTEGER,   -- from the last snapshot of the minute
    vehicles     REAL, en_route REAL, at_terminal REAL, in_depot REAL, to_depot REAL,
    load         REAL, capacity REAL, avg_speed REAL, maint REAL, stuck REAL,
    PRIMARY KEY (game_id, bucket)
);

CREATE TABLE IF NOT EXISTS agg_vehicle_min (
    game_id      INTEGER NOT NULL,
    vehicle_id   INTEGER NOT NULL,
    bucket       INTEGER NOT NULL,
    n            INTEGER NOT NULL,
    year INTEGER, month INTEGER, day INTEGER,
    state        TEXT,                          -- dominant state of the minute
    speed_ms     REAL, load REAL, maintenance REAL,
    x REAL, y REAL, line_id INTEGER, stop_index INTEGER,
    PRIMARY KEY (game_id, vehicle_id, bucket)
);
CREATE INDEX IF NOT EXISTS ix_agg_vehicle_bucket ON agg_vehicle_min(game_id, bucket);

CREATE TABLE IF NOT EXISTS agg_finance_min (
    game_id      INTEGER NOT NULL,
    bucket       INTEGER NOT NULL,
    n            INTEGER NOT NULL,
    game_time_ms INTEGER, year INTEGER, month INTEGER, day INTEGER,
    balance REAL, loan REAL, earnings_ytd REAL, passengers_transported REAL, cargo_transported REAL,
    PRIMARY KEY (game_id, bucket)
);

-- ---------------------------------------------------------------- convenience views
CREATE VIEW IF NOT EXISTS v_latest_snapshot AS
    SELECT s.* FROM snapshot s
    WHERE s.snapshot_id = (SELECT MAX(snapshot_id) FROM snapshot);

CREATE VIEW IF NOT EXISTS v_finance_series AS
    SELECT s.game_id, s.snapshot_id, s.real_time, s.game_time_ms, s.year, s.month, s.day,
           f.balance, f.loan, f.earnings_ytd, f.passengers_transported, f.cargo_transported
    FROM snapshot s JOIN finance f USING (snapshot_id);

CREATE VIEW IF NOT EXISTS v_line_latest AS
    SELECT l.game_id, l.line_id, l.name, ls.*
    FROM line l
    JOIN line_state ls ON ls.line_id = l.line_id
    WHERE ls.snapshot_id = (SELECT MAX(snapshot_id) FROM line_state x WHERE x.line_id = l.line_id);

CREATE VIEW IF NOT EXISTS v_vehicle_latest AS
    SELECT v.game_id, v.vehicle_id, v.name, v.carrier, v.capacity, vs.*
    FROM vehicle v
    JOIN vehicle_state vs ON vs.vehicle_id = v.vehicle_id
    WHERE vs.snapshot_id = (SELECT MAX(snapshot_id) FROM vehicle_state x WHERE x.vehicle_id = v.vehicle_id);

CREATE VIEW IF NOT EXISTS v_alert_latest AS
    SELECT a.* FROM alert a
    WHERE a.snapshot_id = (SELECT MAX(snapshot_id) FROM snapshot);
