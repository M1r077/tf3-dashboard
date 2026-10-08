# Integrations with other mods

How the dashboard relates to other mods, and the rule we follow before touching anything of theirs.

## The rule

1. **Reading what another mod publishes is fine, no permission needed.** If a mod stores data in the savegame
   (`metadata` fields, script state answered through `api.gui.fireGuiScriptEvent`) or in userdata, reading it from our
   export is like a player opening that mod's window: it is data the game exposes, and the author chose to expose it.
2. **Copying their code or assets, or writing into their state, needs the author's agreement.** A function lifted from
   their script, an icon from their zip, a value written into their saved state or their files: ask first, in public
   (mod.io comment or GitHub), and keep the answer.
3. **Degrade silently.** Every read of foreign data is wrapped in `pcall` and tolerates `nil`: the mod is not installed,
   is disabled in this save, changed its format, or did not answer in this context. No log line above debug level, no
   alert for the player, no dashboard panel that looks broken. The player must not know an integration exists unless
   both mods are there.
4. **Credit.** The other mod is named in the README and the mod.io description of the dashboard, with a link, and a word
   of thanks goes to the author when the integration ships.
5. **Never the other way round.** We do not expect, nor ask, other mods to adapt to us. If one wants to read our export
   (`towns_industries/tf3dash_*.lua`), the format is documented in `API_CATALOGUE.md` and DETAILS.md and they are free to.

The game itself enforces part of this: a savegame script cannot `require` another mod's files reliably (load order),
and build 40420 restricts `app.saveUserdata` / `loadUserdata` to a few folders (see DETAILS.md), so "writing into another
mod's files" is not even available for most cases. The rule is about what we would do if it were.

## Licences seen so far (mod.io, Transport Fever 3)

Not legal advice, just what the pages say, to know who can be read and who could be copied.

| Mod | Author | Licence shown | Copy code/assets? |
|---|---|---|---|
| Timetables | — | GPL-3 | yes, under GPL-3 (would force our mod part to GPL-3: no) |
| Auto Line Namer | — | MIT | yes, with attribution |
| N-Signalsystem | — | all rights reserved | no |
| Comfort Cameras | brian | all rights reserved | no |
| ModWerkstatt Base | ModWerkstatt | "use with dependency" | as a dependency only |
| Realistic Smoke | — | "permission required" | ask |
| akoya_camera_bookmarks | akoya | not stated | ask |
| Auto Passenger Cameras | Dome_e39 | not stated | ask |
| Cockpit Speedometers | — | not stated | nothing to copy |

Reading their published data is covered by rule 1 whatever the licence.

## Candidates

### akoya_camera_bookmarks (mod.io 6435426)

Saves camera bookmarks in the script state and answers a gui script event:
`pcall(api.gui.fireGuiScriptEvent, "AKOYA_CAMERA_BOOKMARKS", "AkoyaBookmarkRead", {})` returns the list
(`bookmarks.script.tl`, `subscribeToEvent` on id `""`, `guiHandleEvent`). The dashboard has its own camera views
(Map tab, Shift+1..9) stored in the companion; showing akoya's bookmarks next to ours, read-only, and sending
`set_camera` to one of them would be rule 1. Importing them into our list, or writing ours into theirs, is rule 2.
Not implemented. Note that `fireGuiScriptEvent` does not answer inside a React deferred step (see DETAILS.md,
"API is currently restricted"): read from `guiUpdate`, not from a timer.

### Auto Passenger Cameras (Dome_e39, mod.io 6422630)

Stores per-vehicle cameras in `metadata.domeWagonCameras` of the vehicle model. Readable from the export like any
other metadata field. Nothing to show for the dashboard today; kept as an example of rule 1 data.

### Comfort Cameras (brian, 6432412), Cockpit Speedometers (6431326)

Nothing persistent to read. No integration possible or needed.

## When adding one

- Read in the mod (`dashboard_export.script.lua`), export under a clear key (`live.integrations.<mod_id>`), parse in
  `collector.py`, show in `app.js`. Nothing of the other mod goes through the companion otherwise.
- Keep the cost in mind: one `pcall` per snapshot is nothing, one per vehicle per snapshot is not. Measure like for
  everything else (`[dashboard_export] fast snapshot: build ..ms` / `slow file ... written in ..ms` lines in
  `stdout.txt`, and the per-step timings of the slow sections with the debug log on).
- Add the mod to the table above, to the README "Works with" paragraph, and to the mod.io description.
- Tell the author, publicly, when it is live.
