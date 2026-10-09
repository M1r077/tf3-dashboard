# Transport Fever 3 — `settings.lua` reference

*(FR : référence non officielle de toutes les clés de `settings.lua`, obtenue en croisant le fichier écrit par le jeu,
les chaînes du binaire `TransportFever3.exe` et les libellés du menu Options dans `base.mo`. Les valeurs possibles
des énumérations viennent du binaire ; les explications sont déduites du nom, du type et du libellé de menu — rien
n'est inventé, les doutes sont marqués « ? ».)*

There is no official documentation. This file was built on game build **40420 (8 Oct 2026)** from three sources:

1. `userdata\<id>\3493540\local\settings.lua` — rewritten by the game at every options change, so it holds every key
   the game knows, with the current values (140 top-level keys, 18 nested).
2. `TransportFever3.exe` — the keys live in one contiguous string block (`0x368d7c0`), which also lists the accepted
   values of each enumeration and **4 keys the game never writes** (hidden settings, marked *hidden* below).
3. `base\strings\<lang>\LC_MESSAGES\base.mo` — the labels of the Options menu, which tell which key is which option.

Edit the file with the game **closed** (it is overwritten on exit). Lua syntax; a broken file makes the game fall
back to defaults. Steam path: `C:\Program Files (x86)\Steam\userdata\<account id>\3493540\local\settings.lua`;
Epic/GOG: `%APPDATA%\Transport Fever 3\settings.lua`. Key bindings are in `settings_keys_v3.lua` next to it (not
covered here).

Quality levels used by several keys (`graphics-quality-settings` labels): **0 = Off/Low, 1 = Medium, 2 = High,
3 = Very High** (the menu shows Low/Medium/High/Very High; "Custom" appears when the keys do not match a preset).

## Display and renderer

| Key | Type / values | Menu label | Meaning |
|---|---|---|---|
| `renderer` | `"VULKAN"`, `"DX12"`, `"OPENGL"`, `"METAL"` | Graphic Mode | Graphics API. Vulkan is the default on Windows; Metal is macOS, "AGC" (PS5) exists as label only. |
| `graphicalDeviceOverride` | int, `-1` = auto | — | Index of the GPU to use when several are present. |
| `screenMode` / `oldScreenMode` | `"FULLSCREEN"`, `"BORDERLESS"`, `"WINDOW"` | Display Mode | Current and previous display mode (the "old" one is restored when toggling). |
| `fullscreenSize`, `fullscreenPos` | `{w, h}`, `{x, y}` | Output Resolution | Fullscreen resolution and monitor origin. |
| `windowSize`, `oldWindowSize` | `{w, h}` | Window Settings | Windowed-mode size; `-1` = unset. |
| `refreshRate` | int Hz, `0` = monitor default | — | Fullscreen refresh rate. |
| `vsync` / `oldVsync` | bool | VSync | Vertical synchronisation (and its previous value). |
| `resolutionScale` | float, typically 0.5–2 | Resolution Scale | Internal 3D render scale (0.75 = 75 % of the output, upscaled). The biggest single performance lever. |
| `viewportScale` | float | — | Scale of the 3D viewport inside the window (1 = full). ? Console/handheld oriented. |
| `numMSAASamples` | 0, 2, 4, 8 | Anti-Aliasing | MSAA samples. |
| `useLegacyHdr` | bool | — | Old HDR tone-mapping path (`hdrScale`-style). Off = current pipeline. |
| `experimentalSwapChainSize` | int, `-1` = default | — | Number of swap-chain images (2/3); latency vs smoothness. *Experimental.* |
| `experimentalMailboxPresent` | bool | — | Vulkan mailbox present mode (uncapped frame rate without tearing) instead of FIFO. *Experimental.* |
| `experimentalOptimizeShaders` | bool | — | Extra shader optimisation pass at load. *Experimental.* |
| `rendererDebugMode`, `rendererDebugGpuCrash` | bool | — | Validation layers / GPU crash dumps. Big slowdown; debugging only. |
| `showIntelHDwarning`, `showVideoMemoryUsageWarning` | bool | — | One-time warnings (integrated GPU, VRAM nearly full). |
| `videoMemoryUsageWarningThreshold` | float 0–1 | — | VRAM usage ratio that triggers the warning (0.95). |

## Graphics quality

| Key | Type / values | Menu label | Meaning |
|---|---|---|---|
| `shadowQuality` | 0–3 | Shadows | Shadow map resolution/cascades. |
| `textureQuality` | 0–3 | — (Textures) | Model texture resolution (mip bias). |
| `terrainQuality` | 0–3 | — (Terrain) | Terrain mesh detail. |
| `terrainTextureQuality` | 0–3 | — | Terrain material texture resolution. |
| `terrainTextureResolution` | int | — | *hidden* — explicit terrain texture size overriding the quality level. ? |
| `terrainTesselationEnabled` | bool | — | Hardware tessellation of the terrain. |
| `terrainTriplanarDistance` | float m (3000) | — | Distance up to which triplanar terrain texturing is used (removes stretching on slopes). |
| `geometryQuality` | 0–3 | — (Geometry / LOD) | Model level-of-detail distances. |
| `grassQuality` | 0–3 | Vegetation | Grass density and draw distance. |
| `bloomQuality` | 0–2 | — | Bloom (0 = off). |
| `ssrQuality` | 0–3 | Reflections (SSR) | Screen-space reflections. |
| `useReflection` | bool | — | Planar/water reflections (older path). |
| `useSsao` | bool | — | Screen-space ambient occlusion. |
| `maxDegreeOfAnisotropy` | 1, 2, 4, 8, 16 | — | Anisotropic filtering. |
| `enableMeshStreaming` | bool | — | Stream meshes on demand instead of loading everything (lower RAM/VRAM, possible pop-in). |
| `enableDeferredTextures` | bool | — | Load textures in the background after the map appears. |
| `streamingTextureLodOffsetModel` | int (−4) | — | Mip bias for streamed model textures: more negative = sharper, more VRAM. |
| `streamingTextureLodOffsetTerrain` | int (−2) | — | Same for terrain textures. |
| `disableConstructionParticles` | bool | — | No dust/particles during construction. |
| `cloudTransparencyMode` | `"None"`, `"Center"`, `"Always"`, `"Never"`, `"Off"` | Cloud Transparency | Where clouds become see-through: near the screen centre, near the mouse/inspector, always, never. Menu labels: None / Near Screen Center / Near Mouse Cursor / Near Inspector. |
| `backgroundContrastMode` | `"Both"`, `"Center"`, `"Left"`, `"Right"`, `"Always"`, `"Never"`, `"None"`, `"Off"` | — | Contrast backdrop behind HUD icons (icon-overlap setting): Always / Never / Near Mouse Cursor / Near Inspector. |

### VRAM budget (all `vramBudget*`)

The game caps each resource class to a share of the GPU memory. `-1` = automatic.

| Key | Meaning |
|---|---|
| `vramBudgetMinGpuMB` (4096) | GPU memory assumed at minimum; below this the game lowers settings. |
| `vramBudgetFixedGpuMB` | Force the GPU memory size the budget is computed from (−1 = detected). |
| `vramBudgetReserve` (0.2) | Share kept free for the driver/OS. |
| `vramBudget{Textures,Meshes,TerrainMaterialTextures,TerrainHeightmapTextures}SizeMB` | Hard cap per class, MB (−1 = auto). |
| `…EnableLimit` | Apply the cap (true) or let the class grow. |
| `…EnableCache` | Keep evicted resources in a RAM cache for fast re-upload. |

## Camera and mouse

| Key | Type / values | Menu label | Meaning |
|---|---|---|---|
| `panningMode` | `"perspective"`, `"simple"`, `"grab"` (`"flat"`, `"ground"`, `"plane"` also in the binary) | Panning Mode | How right-drag moves the camera: Perspective (ground point stays under the cursor), Simple (screen-space), Grab. |
| `invertPan`, `invertRotate`, `invertTilt`, `invertZoom`, `invertRotateKeys` | bool | Invert … | Axis inversions (mouse; `invertRotateKeys` = keyboard rotation). |
| `zoomToCursor`, `zoomOutFromCursor` | bool | Zoom In to Cursor / Zoom Out From Cursor | Zoom towards/away from the mouse position instead of the screen centre. |
| `zoomPrecise` | bool | Continuous Zoom | Smooth, velocity-based zoom instead of stepped. |
| `zoomPreciseAccel` (0.25), `zoomPreciseDeccel` (8), `zoomPreciseMaxSpeed` (4) | float | — | Acceleration, deceleration and cap of the continuous zoom. |
| `mouseWheelSensitivity` (0.5), `mouseMovementSensitivity` (5) | float | Mouse Wheel / Movement Sensitivity | Zoom step and pan/rotate speed. |
| `scrollAtBorder` | bool | Edge Scrolling | Pan when the cursor touches the screen edge. |
| `mouseEnableRightClickBack` | bool | — | Right click closes the current tool/window (back). |
| `useHardwareCursor` | bool | Use System Mouse Cursor | OS cursor instead of the game-drawn one (less lag). |
| `keyboardCameraSpeed.{game,cockpit,cameraTool}` | float 0–1 | Camera Movement Speed | Keyboard camera speed per mode. |
| `cameraTool` | bool | Camera Tool | Enables the cinematic camera tool (key frames, recording). |
| `customCameraManagerResolutions` | list `{w, h}` | Camera Manager | Extra output resolutions for camera-tool captures. |
| `cameraPositions` | table | — | *hidden* — saved camera positions (the game writes it only when some exist; `m_cameraPositions.empty` guard in the binary). |
| `cssEffectsVelocity` | float (1) | — | ? Camera "cockpit screen-space" effect strength tied to vehicle speed (shake/blur in cockpit view). |
| `hudEffectMode` | `"CockpitOnly"`, `"Always"`, `"Never"`, `"All"`, `"Off"` | — | When post effects (depth of field etc.) apply: cockpit only / always / never. |

## Controller / gamepad

| Key | Meaning |
|---|---|
| `enableKeyboardMouse` | Keyboard+mouse input enabled (false = controller-only UI). |
| `gamepadDeadzone` (0.2) | Stick dead zone. |
| `controllerCameraFlags.{invertRotate,invertTilt,invertZoom,swapSticks}` | Per-axis inversions and stick swap for the camera. |
| `controllerNavigateSwapSticks` | Swap sticks for UI navigation. |
| `controllerCameraSpeed.{gameScroll,gameRotate,gameZoom,cockpitMove,cockpitRotate}` | Stick speeds per action, 0–1. |

## Interface

| Key | Type / values | Menu label | Meaning |
|---|---|---|---|
| `uiscaling` (0.75) | float | Interface Scaling / Game UI Scaling | UI scale factor. |
| `uiAutoScaling` | bool | — | Pick the scale from the resolution/DPI automatically. |
| `fontScaleClass` | `"SMALL"`, `"MEDIUM"`, `"LARGE"` | Text Scaling | Text size class. |
| `hudMode` | int (1) | HUD Filters | ? HUD icon display mode (0 = minimal, 1 = normal, 2 = all). |
| `hudMaxNewIconsMovingOverride`, `hudMaxNewIconsToolSwitchOverride` | int | — | *hidden* — caps on how many HUD icons may appear per frame while the camera moves / a tool switches (pop-in smoothing). |
| `moneyMode` | `"KMB"`, `"Full"`, `"Short"`, `"Long"`, `"Exact"` | Money Number Format | 1.2M / 1,200,000. Menu offers Full / Short. |
| `moneyPrefix`, `moneySuffix` | string | — | Currency symbol placement (`$` before, or e.g. ` €` after). |
| `distanceSpeedUnit` | `"Metric"`, `"Imperial"` | Distance and Speed Units | km & km/h vs miles & mph. |
| `powerUnit` | `"HP"`, `"KW"`, `"PS"` | Power Units | |
| `weightUnit` | `"T"`, `"LB"` | Weight Units | |
| `forceUnit` | `"KN"`, `"LBF"` | Force Units | Tractive effort. |
| `disableMessageBox` | bool | — | Suppress blocking message boxes (warnings become log lines). ? |
| `showReleaseNotes`, `showSplashScreen`, `showMissingResourcesDialog` | bool | — | One-time/startup dialogs. |
| `firstStart`, `hasShownInitialDeluxeThankYou`, `updateMessageID` | bool/int | — | Internal flags: first launch done, Deluxe thank-you shown, id of the last "what's new" message shown. |
| `guideSystemActive` | bool | Guide | In-game guide/hints system. |
| `enableCelebrations` | bool | Enable Celebrations | Milestone celebrations (fireworks, popups). |
| `industryClosureNotification`, `industrySpawnNotification`, `newVehicleNotification`, `townCargoNeedsNotification` | bool | Notifications | Which notification categories are shown. |

## Gameplay and building

| Key | Type / values | Menu label | Meaning |
|---|---|---|---|
| `autosaveIntervalMinutes` (10) | int, 0 = off | Autosave Interval | Real minutes between autosaves. |
| `autosaveKeepNumber` (10) | int | Autosaves To Keep | Rotation depth. |
| `crashSaveEnabled` | bool | — | Write a save when the game crashes. |
| `crashSaveSingleFile` | bool | — | Always overwrite the same crash save instead of one per crash. |
| `enableSeamlessStreetBuilder` | bool | — | Road builder joins segments continuously (the "seamless" builder). |
| `deferredProposal` | bool | Enable Drag-and-Confirm Construction Mode | Construction proposals are shown and confirmed instead of built on click. |
| `parallelEdgesMaxDistance` (2000) | float m | — | How far the parallel track/road tool searches for an edge to run parallel to. |
| `lineAssignVisibleOnly` | bool | — | "Send to line" lists only lines visible with the current HUD filter. |
| `experimentalTunnelAndBridgeMinHeight` | bool | — | Relaxed minimum height for tunnels/bridges. *Experimental, can produce clipping.* |
| `experimentalMapFeatures`, `experimentalTerrainGeneratorEditor` | bool | — | Unfinished map-generation UI / terrain generator editor. |
| `trafficDensity` | number | — | *hidden* — override of the private traffic density (the advanced map option `trafficSpeedSensitivityScale` is the public knob). ? Range unknown. |
| `debugMode` | bool | Debug Mode | Enables the debug panel/console (`~`) and debug tools in menus. |
| `debugInfoShowFps` | bool | — | FPS counter. |
| `waitForStartReadyGame` | bool | — | ? Block the main loop until all startup resources are ready (vs show the menu early). |

## Audio

| Key | Meaning |
|---|---|
| `masterVolume`, `soundVolume`, `musicVolume`, `voiceOverVolume` | 0–1. |
| `musicEnabled`, `menuMusicEnabled`, `splashMusicEnabled`, `voiceOverEnabled` | Switches. |
| `musicEraDependent` | Playlist follows the game year. |
| `playlist` | Playlist file (`music/default/default.plist`). |
| `audioEffectSettings.{bulldozer,construction}` | Individual effect switches. |

## Mods and telemetry

| Key | Meaning |
|---|---|
| `externalModPath` | Extra folder scanned for mods (besides userdata/mods and staging_area). |
| `modHubVerboseLogging` | mod.io client debug output in `stdout.txt`. |
| `uploadCrashDumps`, `uploadHangDumps` | Send dumps to Urban Games. |
| `customColors` | 10 × `{r,g,b}` custom line colours, `-1` = unset. |
| `mainMenuState` | Last choices of the New Game screen: `newGameState` (seed, start year index, climate generator), `mapGenParamsState` (mountains, oceans, water), `activeModsState`, `activeModsParamsState` (advanced options per mod; `""` = base game: `advancedOptions.*`, `economy.*`, `townConfig.sensitivity*`, `locations.*`, `map.size/format`, `gameTimeConfig.timeOfDayMode`, `weatherConfig.dynamicWeather`, `guideSystemConfig.tutorial`). Values are option indices, not the actual numbers. |

## Not settings (same string block, do not add them)

`modKey`, `keycode`, `scancode`, `axis`, `longPress`, `keySequences`, `IA_*` belong to `settings_keys_v3.lua`;
`hdrExposure*`, `mie*`, `cloudBase`, `sunIlluminance`… are environment (sky) parameters of climate files, not user settings.
