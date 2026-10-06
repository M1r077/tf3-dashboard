# Catalogue : ce que le dashboard peut faire avec Transport Fever 3

Référence unique de tout ce que l'API Lua de TF3 permet depuis un *game script* tournant sur le thread GUI
(`guiUpdate`), telle qu'utilisée par le mod `tf3_dashboard_export`. Source : `api/tealdef/api/*.d.tl` du jeu
et les scripts de l'interface dans `base/content/gui.zip` / `game_mechanics.zip` (version du jeu installée le
2026-10-06). Chaque entrée indique un **statut** :

| Statut | Sens |
|---|---|
| **FAIT** | déjà exposé par le mod (lecture) ou déjà une commande `cmd.lua` + bouton dashboard |
| **FACILE** | faisable avec une commande simple, aucun risque de casser la partie |
| **MOYEN** | faisable, mais nécessite une lecture-modification-écriture d'une structure complète ou une validation que seul le jeu peut faire |
| **RISQUÉ** | possible techniquement mais irréversible / destructeur / argent réel ; à mettre derrière une confirmation |
| **NON** | hors de portée depuis un script (ou sans intérêt pour le dashboard) |

Convention de nommage des commandes `cmd.lua` : `{ id = <n>, cmd = "<nom>", args = { ... } }`, réponse dans
`live.lua` → `last_ack = { id, cmd, ok, error, real_time }`.

---

## 1. Mécanique générale

### 1.1 Trois canaux distincts

| Canal | API | Thread | Effet |
|---|---|---|---|
| **Commande simulation** | `api.cmd.sendCommand(api.cmd.makeXxxCmd(...), callback)` | GUI → moteur | modifie la partie (sauvegardé). Le callback reçoit `(cmd, success)` ; l'ack du mod attend ce callback. |
| **Événement React** | `api.gui.fireReactEvent(name, param)` | GUI | agit sur l'interface du jeu (ouvrir une fenêtre, sélectionner). Pas de retour, pas d'erreur si le nom est faux. |
| **Caméra / GUI direct** | `api.gui.camera.*`, `api.gui.closeAllWindows()`, `api.gui.byId.*` | GUI | immédiat, rien dans la sauvegarde. |

### 1.2 Limites structurelles

- Un game script ne peut **pas** dessiner dans la fenêtre du jeu (pas d'UI custom depuis un game script en TF3 ;
  l'UI est en React/Teal interne). Tout affichage reste dans le dashboard.
- Toute écriture passe par **une commande entière** : pas de « changer un seul champ d'un arrêt ». Pour une ligne,
  on lit `LINE`, on modifie la table, on renvoie tout (`makeLineUpdateCmd`).
- Les commandes sont validées par le moteur : une ligne dont un arrêt n'est plus accessible est acceptée mais
  les véhicules passent en « pas de chemin ». La validation « tracé possible » **n'existe que dans le jeu**.
- Le canal fichier (`cmd.lua` relu 4×/s) impose ~250 ms de latence et **une commande à la fois** (le serveur refuse
  si un `cmd.lua` est en attente).
- Argent : les achats/ventes/remplacements sont réels et immédiats, sans « annuler ».

---

## 2. Lecture (déjà exportée ou disponible)

### 2.1 Déjà dans `live.lua` (FAIT)

| Domaine | Fonctions utilisées |
|---|---|
| Monde | `GAME_TIME`, `GAME_SPEED`, `getYear`, `getPlayer`, lang |
| Véhicules | `vehicle.getVehicles/getSpeed/getPosition/getVehicleType/getVehicleCapacities/getVehicleMaintenanceState/getRunningCost/getDepreciatedValue/getVehicleProblems`, `cargo.getNumCargoPerTypeInVehicle`, composant `TRANSPORT_VEHICLE` (état, ligne, arrêt, user_stopped, modèle), `transportVehicleSystem.getDepotVehicles/getGoingToDepotVehicles/getNoPathVehicles`, `landVehicleMoveSystem.getBlockedTrains` |
| Lignes | composant `LINE` (arrêts, groupes de gares), `COLOR`, `line.getLineCapacityUsages/getMaxFrequency/calcLineStationThroughput/getLineProblems/getLinesIssues/getLineTransportModesUnion`, `cargo.getSummarizedCargoQualityDataForLine` |
| Villes | `TOWN`, `town.getTownCapacityUsage/getTownHappinessStats/getTownLineUsage/getTownReachability/getTownEmissionDB/getTownStockCargo/getTownProblems/computeTownsTrafficSpeedMap/getTownDistrictCenter` |
| Industries | `INDUSTRY`, `STOCK_LIST`, `stock.getProductionRating/getCargoProducedPerYear/…/getStockListsWithThrownAwayCargo/getInputsOutputsFromRules`, `industry.getIndustryProductivityInfo/getClosingIndustries` |
| Gares / dépôts | `station.calculateStationUsage/isStationOfType`, `VEHICLE_DEPOT`, `CONSTRUCTION` |
| Finances | `ACCOUNT`, `finance.getPlayersBalance/calculateEarnings`, `headquarters.getTransportedData/getCompaniesValue` |
| Référentiels | `api.res.cargoTypeRep`, `api.res.modelRep` |

### 2.2 Disponible, pas encore exporté

| Donnée | Fonction | Intérêt dashboard | Statut |
|---|---|---|---|
| Détail des problèmes par arrêt d'une ligne | `line.getDetailedLineProblems(line)` → `{{StopState}}` | diagnostiquer « pas de chemin » entre deux arrêts précis | FACILE |
| Problèmes ligne↔gare | `line.getLineStationProblems()` | gare non desservie / terminal incompatible | FACILE |
| Raison d'échec du chemin d'un véhicule | `line.getFailedPathReason(vehicle, line)` | texte explicite dans la fiche véhicule | FACILE |
| Routes sans connexion | `line.getNoRoadConnectionProblems()` | | FACILE |
| Qualité cargo par arrêt / gare / terminal | `cargo.getCargoQualityDataAtStop/AtStation/AtTerminal` | où les passagers attendent trop | FACILE |
| Occupation d'un terminal | `station.calculateStationTerminalUsage(station, idx)` | quai saturé | FACILE |
| Cargo d'un groupe de gares | `station.calculateStationGroupCargo` | | FACILE |
| Rayons d'attraction qui se chevauchent | `station.findStationGroupWithOverlappingCatchmentOfDifferentCarriers()` | | FACILE |
| Meilleur dépôt pour une ligne | `vehicle.findBestDepotForLine(carrier, modes, line)` | prérequis pour acheter depuis le dashboard | FACILE |
| Meilleure ligne/dépôt pour un véhicule | `vehicle.findBestLineAndDepotForVehicle` | | FACILE |
| Longueur / prix d'une composition | `vehicle.getLength`, `vehicle.getPartPrice` | | FACILE |
| Pénalités d'entretien | `vehicle.getMaintenance*Penalty` | | FACILE |
| Livraisons par ville / ligne | `town.getTownDeliveriesStats(town, interval, perLine, …)` | quelle ligne alimente quelle ville | FACILE |
| Flux origine→destination | `town.getSourceToDestinationCount` | matrice OD simplifiée | MOYEN (coût CPU) |
| Bruit par district | `town.getTownNoisePerDistrict` | | FACILE |
| Émetteurs de pollution / bruit | `emission.getPollutionEmittersInSettlementArea`, `getNoiseEmittersNearSettlementLandUses` | | FACILE |
| Logbooks (séries temporelles natives) | `logbook.getLogValuePerYear/MostRecent`, `getChartDiff` | les mêmes courbes que les stats du jeu, par entité | MOYEN |
| Tableau financier complet | `finance.computeFinanceTable(player, config)`, `getAccountChart` | onglet Finances identique au jeu | MOYEN |
| Entités dans un rayon | `octree.findEntitiesInCircle(center, r, componentType)` | « que se passe-t-il autour de ce point » | FACILE |
| Plus proche ville d'une position | `town.getClosestTown(pos)` | | FAIT (approché) |
| Chemin théorique | `pathfinding.findPathNodeToNode` | vérifier si deux gares sont reliées | MOYEN |
| Caméra actuelle | `api.gui.camera.getCameraData()`, `getFollowEntity()` | afficher sur la carte ce que le joueur regarde | FACILE |
| Vitesse max estimée | `api.gui.game.getEstimatedMaximumGameSpeed()` | griser le bouton ×4 si la machine ne suit pas | FACILE |
| Performances | `api.gui.benchmark.get*Times()` | mini moniteur FPS/sim | FACILE |
| Visibilité | `api.gui.byEntity.isVehicleVisible(e)` | savoir si le véhicule est à l'écran | FACILE |
| Position souris terrain | `api.gui.mouse.getTerrainPosition()` | | FACILE |
| Mission / campagne | `api.gui.mission.getMission()` | | NON (pas de campagne ici) |

---

## 3. Caméra et fenêtres du jeu (`api.gui`)

| Action | Appel | Commande dashboard | Statut |
|---|---|---|---|
| Centrer sur une entité | `camera.focusEntity(e)` | `focus_entity {entity}` | FAIT |
| Centrer sur une position | `camera.focusPosition(Vec3f, distance)` | `focus_position {x,y,z,distance}` | FAIT |
| Suivre un véhicule | `camera.followEntity(e, jump)` | `follow_entity {entity, jump}` | FAIT |
| Vue cockpit | `camera.enterFollowCameraCockpit(e)` / `leaveFollowCameraCockpit()` | `cockpit {entity}` / `cockpit_leave` | FACILE |
| Caméra libre | `camera.toggleFreeCamera()` | | FACILE |
| Poser la caméra précisément | `camera.setCameraData(Vec5f{x,y,dist,angleH,angleV})`, `setManualCamera(center, dist)` | `set_camera {...}` | FACILE — permet des « vues favorites » enregistrées dans le dashboard |
| Lire la caméra | `camera.getCameraData()` | export dans live.lua | FACILE |
| Capture d'écran | `camera.takeScreenshot(scale)` → dossier userdata | `screenshot {scale}` | FACILE (le fichier atterrit côté jeu, pas servi par le dashboard) |
| Klaxon | `api.gui.sound.letVehicleHorn(e)` | `horn {entity}` | FACILE (gadget) |
| Ouvrir la fiche d'une entité (ligne, véhicule, gare, ville, industrie, dépôt…) | `fireReactEvent("selectEntity", {entity=e, stack=bool})` | `select_entity {entity, focus, stack}` | FAIT (en test) |
| Fermer toutes les fenêtres | `api.gui.closeAllWindows()` | `close_windows` | FAIT (en test) |
| Gestionnaire lignes/véhicules sur une ligne | `fireReactEvent("openVehicleManager", {openWithLineEntity=e})` | `open_line_manager {line}` | FAIT (en test) |
| Gestionnaire sur un dépôt | `… {openWithDepotEntity=e}` | `open_depot_manager {depot}` | FACILE |
| Gestionnaire sur des véhicules | `… {openWithVehicleEntities={…}}` | `open_vehicle_manager {vehicles}` | FACILE |
| Mode « envoyer sur une ligne » | `… {openWithVehicleEntities={…}, sendToLineMode=true}` | | FACILE |
| Fermer le gestionnaire | `fireReactEvent("closeVehicleManager", {})` | | FACILE |
| Fenêtre Finances | `fireReactEvent("openFinanceWindow")` / `"closeFinanceWindow"` | `open_finance` | FACILE |
| Fenêtre Statistiques sur un onglet | `fireReactEvent("openStatisticsWindow", "Line")` — clés : `Line, Vehicle, Station, Town, Industry, Warehouse, Depot` | `open_statistics {tab}` | FACILE |
| Fenêtre Compagnie | `fireReactEvent("openCompanyWindow", {initialTabKey="Company"})` | | FACILE |
| Journal des notifications | `fireReactEvent("openNotificationLog")` | | FACILE |
| Couches (calques) | `fireReactEvent("openLayerRidge", {layer="menu.layers.<id>", stack=true})` — ids : `terrainButton, townsButton, speedButton, trafficButton, cargoButton, cargoFlowButton, mobilityButton, noiseButton, pollutionButton, publicTransportButton, hudFilters` ; `"closeLayerRidge"` | `open_layer {layer}` | FACILE |
| Configuration d'une couche (ex. cargo filtré) | `fireReactEvent("preferredLayerConfig", {config=LayerConfig})` | | MOYEN (structure LayerConfig à reverse-engineer par couche) |
| Menu construction sur un onglet | `fireReactEvent("constructionMenuSetTab", {tabIndex=n, sublistId=…})`, `"constructionMenuQuit"` | | FACILE mais peu utile sans souris en jeu |
| Menu pause | `fireReactEvent("openPauseMenu")` | | FACILE |
| Désélectionner | `fireReactEvent("selectNothing", {stack=true})` | | FACILE |
| Marqueur dans le monde (comme les missions) | `api.gui.mission.setMarkerAtEntity(key, e, type, scale)` / `setMarkerAtPosition` / `removeMarker(key)` | `mark {entity}` | FACILE — **très utile** : flèche sur un véhicule bloqué, un arrêt, une industrie |
| Zone colorée au sol | `api.gui.mission.setZoneCircle(key, center, radius, draw, color, prohibitBuilding)` / `setZone(polygon)` / `removeZone` | `zone {...}` | FACILE — rayon d'attraction, zone de bruit |
| Icône HUD éphémère | `api.gui.spawnEphemeralHudImage(icon, entity, color, pos, duration)` | | FACILE (feedback visuel d'une commande) |
| Visualiser le chemin d'un navire | `api.gui.mission.setMovePathVisualizationAtEntity` | | FACILE (navires uniquement) |
| Afficher/masquer un élément d'UI | `api.gui.byId.setVisible(id, bool)`, `setEnabled` | | NON (ids internes, fragile) |
| Musique | `api.gui.musicPlayer.*` | | NON (sans rapport) |

---

## 4. Simulation : commandes (`api.cmd`)

### 4.1 Jeu

| Action | Commande | Dashboard | Statut |
|---|---|---|---|
| Vitesse 0/1/2/4 | `makeGameSetSpeedCmd(n)` | `set_speed`, `pause`, `toggle_pause` | FAIT |
| Durée d'un jour (ms) | `makeGameSetCalendarSpeedCmd(ms)` | `set_calendar_speed` | FACILE (option sandbox) |
| Changer la date | `makeGameSetDateCmd(Date)` | | RISQUÉ (disponibilité des véhicules) |
| Heure de la journée | `makeGameSetTimeOfDayCmd(sec)` | `set_time_of_day` | FACILE (cosmétique : jour/nuit) |
| Couverture nuageuse | `makeGameSetCloudCoverageCmd(0..1)` | | FACILE (cosmétique) |
| Vent | `makeWorldChangeWindCmd(grid, Vec2f)` | | FACILE (cosmétique) |
| Avancer de N pas de sim | `makeGamePerformSimulationStepsCmd(n)` (debug) | | NON |

### 4.2 Véhicules

| Action | Commande | Dashboard | Statut |
|---|---|---|---|
| Arrêter / démarrer | `makeVehicleSetStoppedByUserCmd(v, bool)` | `vehicle_stop/start` | FAIT |
| Inverser | `makeVehicleReverseCmd(v)` | `vehicle_reverse` | FAIT |
| Forcer le départ | `makeVehicleTryToDepartCmd(v)` | `vehicle_depart` | FAIT |
| Envoyer au dépôt | `makeVehicleSendToDepotCmd(v, sellOnArrival=false)` | `vehicle_to_depot` | FAIT |
| Envoyer au dépôt **et vendre** | `… sellOnArrival=true` | `vehicle_to_depot {sell=true}` | RISQUÉ (confirmation) |
| Téléporter au dépôt | `… jumpToDepoEntity=depot` | | RISQUÉ |
| Départ manuel on/off (ne part jamais seul) | `makeVehicleSetManualDepartureCmd(v, bool)` | `vehicle_manual_departure` | FACILE |
| Changer de ligne (et aller à l'arrêt n) | `makeVehicleSetLineCmd(v, line, stopIndex)` | `vehicle_set_line {vehicle, line, stop}` | FACILE — vérifier compat carrier avec `line.isLineCompatibleWithCarrier` avant |
| Retirer de la ligne | `makeVehicleSetLineCmd(v, -1, 0)` (à vérifier en jeu) | | MOYEN |
| Vendre (au dépôt) | `makeVehicleSellCmd({v,…})` | `vehicle_sell` | RISQUÉ |
| Acheter | `makeVehicleBuyCmd(player, depot, TransportVehicleConfig)` | `vehicle_buy {depot, model(s)}` | MOYEN/RISQUÉ — il faut composer un `TransportVehicleConfig` (parts, groupes, muFileNames) ; cloner la config d'un véhicule existant est le cas simple et sûr (« +1 identique sur cette ligne ») |
| Remplacer (nouveau modèle) | `makeVehicleReplaceCmd(v, tvc)` | `vehicle_replace` | MOYEN/RISQUÉ |
| Modificateurs (vitesse max ×, bruit ×, pollution ×, confort ×) | `makeVehicleSetModifiersCmd(v, Modifiers)` | | NON (triche) |
| Renommer | `makeEntitySetNameCmd(v, name)` | `rename_entity {entity, name}` | FAIT (commande mod ; pas encore de bouton) |
| Couleur (livrée) | `makeEntitySetColorCmd(e, Vec3f)` | `set_color {entity, r,g,b}` | FACILE (fonctionne au moins pour lignes ; véhicules à tester) |

### 4.3 Lignes

Le composant `Engine.Component.Line` contient : `stops : {Stop}` (stationGroup, station, terminal,
alternativeTerminals, loadMode, minWaitingTime, maxWaitingTime, maxAdditionalWaitingTime, waypoints,
stopConfig{load{bool}, maxLoad{0..1}, forceUnload, destroyForConfigChange, destroyForRefresh}),
`vehicleInfo.transportModes`, `customFilters`, `reservationPriority`. Toute modification =
`makeLineUpdateCmd(line, lineCopy)`.

| Action | Mise en œuvre | Dashboard | Statut |
|---|---|---|---|
| Renommer | `makeEntitySetNameCmd(line, name)` | `rename_entity` | FAIT (commande mod ; pas encore de bouton) |
| Couleur | `makeEntitySetColorCmd(line, rgb)` | `set_color` | FACILE |
| Mode de chargement d'un arrêt (`LOAD_IF_AVAILABLE`, `FULL_LOAD_ANY`, `FULL_LOAD_ALL` ; `LEGACY_UNLOAD_ONLY` non proposé par le jeu) | copier LINE (`api.type.Line.new(comp)`), `stops[i].loadMode = …`, update — même code que `cargofilter_window.tl` | `line_set_stop {line, stop, load_mode}` | **FAIT** (détail de ligne → Arrêts & départs → crayon) |
| Temps d'attente min / max / additionnel | idem, `minWaitingTime` etc. (0..600 s, max = -1 illimité) | `line_set_stop {…, min_wait, max_wait, max_add_wait}` ; `line_set_all_stops` pour toute la ligne | **FAIT** |
| Filtres cargo par arrêt (charger/ne pas charger) | idem, `stopConfig.load[k]` (dense, index = id+1), `customFilters=true` | `line_set_stop {…, no_load=[ids]}` | **FAIT** (chips cargo cliquables) ; part max (`maxLoad`) : lecture seule pour l'instant |
| Décharger de force / détruire pour reconfig | `stopConfig.forceUnload`, `destroyForConfigChange`, `destroyForRefresh` | `line_set_stop {…, force_unload, destroy_for_config_change, destroy_for_refresh}` | **FAIT** (case « décharger de force » ; les deux « destroy » : commande seulement) |
| Supprimer un arrêt | retirer `stops[i]` puis update | `line_stop_remove` | MOYEN/RISQUÉ (peut couper le chemin) |
| Réordonner les arrêts | permuter dans `stops` | `line_stops_reorder` | MOYEN/RISQUÉ (idem) |
| Changer de terminal / terminaux alternatifs | `stops[i].station/terminal` (préféré) + `alternativeTerminals` ; quais listés via `STATION_GROUP.stations[] -> STATION.terminals[]` (type, classe cargo, longueur, modes via `TpNetData`, `checkLineStopForVehicleOverlength`) | `line_set_terminals {line, stop, main={station,terminal}, alternatives=[…]}` | **FAIT** (bloc « Quais » de l'éditeur d'arrêt : case = utilisable, étoile = préféré ; quais incompatibles affichés mais marqués « lent ») |
| Ajouter un arrêt | construire un `Stop` (stationGroup + station + terminal valides) | `line_stop_add` | RISQUÉ — pas d'aperçu de tracé ; **seulement** sur gares déjà connues, et le jeu peut répondre « pas de chemin » |
| Waypoints | `stops[i].waypoints` (ids d'arêtes/nœuds) | | NON depuis le dashboard (il faut cliquer dans le monde) |
| Priorité de réservation | `reservationPriority` | affichée dans le détail de ligne | lecture FAIT ; écriture FACILE |
| Créer une ligne | `makeLineCreateCmd(name, color, player, Line)` | | RISQUÉ — même limites que l'ajout d'arrêt |
| Supprimer une ligne | `makeLineDestroyCmd(line)` | `line_delete` | RISQUÉ (véhicules orphelins) |
| Envoyer tous les véhicules d'une ligne au dépôt | boucle `makeVehicleSendToDepotCmd` | `line_all_to_depot` | **FAIT** (bouton avec confirmation) |
| Arrêter / redémarrer toute la ligne | boucle `SetStoppedByUser` | `line_stop_all / line_start_all` | **FAIT** |
| « +1 véhicule identique » | cloner le `TransportVehicleConfig` d'un véhicule de la ligne, `findBestDepotForLine`, `makeVehicleBuyCmd`, puis `makeVehicleSetLineCmd` | `line_add_vehicle {line, like=vehicle}` | MOYEN/RISQUÉ (argent) — c'est la plus utile des actions « gestion » |

### 4.4 Gares, dépôts, constructions

| Action | Commande | Statut |
|---|---|---|
| Renommer gare / dépôt | `makeEntitySetNameCmd(e, name, forceSameEntity)` | FACILE |
| Jeter le cargo en attente d'un stock | `makeStockListDiscardCargoCmd` | RISQUÉ |
| Forcer le type de cargo d'un stock | `makeStockListSetStocksCargoTypeCmd` | NON |
| Construire / modifier / démolir (gares, voies, routes, modules) | `makeWorldBuildProposalCmd(proposal, …)` + `util.proposal.*` | NON depuis le dashboard : il faut un `Proposal` géométrique complet ; c'est l'outil de construction du jeu |
| Marquer démolissable / historique | `makeWorldSetBulldozableCmd`, `makeTownBuildingSetBlockedDevelopmentCmd` | NON |

### 4.5 Industries et villes

| Action | Commande | Statut |
|---|---|---|
| Industrie : mode manuel (pas de fermeture, pas de niveau auto) | `makeIndustrySetManualDevelopmentCmd(i, bool)` | FACILE mais c'est de la triche → option « sandbox » dans Réglages |
| Industrie : productivité × | `makeStockListSetModifiersCmd(i, {productivity=n})` | NON (triche) |
| Industrie : annuler la fermeture | `makeIndustrySetDespawnTimeCmd(i, ts)` | NON (triche) |
| Industrie : agrandir | `makeCreateIndustryExtendProposalCmd` | NON |
| Ville : croissance on/off | `makeTownSetDevelopmentActiveCmd(town, bool)` | FACILE (le jeu l'expose dans la fiche ville → légitime) |
| Ville : besoins cargo, taille, capacités, poids de distribution | `makeTownUpdateCargoNeedsCmd`, `makeTownUpdateSizeCmd`, `makeTownSetInitialLandUseCapacitiesCmd`, `makeTownCustomDistributionWeightsCmd` | NON (éditeur de carte) |
| Ville : développer à un point, relier aux industries, créer/détruire | `makeTownDevelopAtCmd`, `makeTownConnectWithIndustriesCmd`, `makeTownCreateCmd`, `makeTownDestroyCmd` | NON |
| Terrain, joueurs, animaux, entités custom, journal, compte | `makeWorldReplaceTerrainCmd`, `makeGameAddPlayerCmd`, `makeAnimal*`, `makeCustomEntity*`, `makeJournal*`, `makeMaintenanceCostUpdateCmd`, `makeEntitySetEmissionsCmd`, `makeEntitySetPlayerCmd` | NON |
| Debug (`makeSimPersonSetStateCmd`, `makeStockSetCargoAmountCmd`, `makeComponentExchangeCmd`, `makeClearLogbooksCmd`) | | NON |

### 4.6 Scripting

| Action | Commande | Statut |
|---|---|---|
| Diffuser un événement à tous les game scripts | `makeScriptingSendEventCmd(src, id, name, param)` | FACILE — permettrait au dashboard de parler à d'autres mods (ex. déclencher une action d'un mod tiers) |
| Événement GUI script interne (`fireGuiScriptEvent`) : `management.line/delete`, `vehicleStore/mission.buyVehicle`, `mainView/select`, `entityWindow/locate`, `calendar/onManualTimeChanged` | | NON (API interne instable ; préférer les `api.cmd` équivalents) |

---

## 5. Feuille de route proposée (par valeur / risque)

1. **Sans risque, gros gain** — ouvrir fiche (`select_entity`), gestionnaire de ligne, marqueur monde (`mark`),
   zone (`zone`), vues caméra enregistrées (`set_camera`), raison « pas de chemin » et problèmes par arrêt dans
   la fiche ligne/véhicule, départ manuel, renommer ligne/véhicule/gare, couleur de ligne, statistiques/finances
   du jeu sur l'onglet voulu, couches (bruit, cargo…).
2. **Gestion de ligne sans toucher au tracé** — mode de chargement, temps d'attente, filtres cargo par arrêt,
   arrêter/démarrer toute la ligne, tout envoyer au dépôt, déplacer un véhicule vers une autre ligne.
3. **Argent (avec confirmation + affichage du prix)** — « +1 véhicule identique », vendre, remplacer par
   le même modèle neuf.
4. **Tracé** — supprimer/réordonner un arrêt (avec garde-fou : refus si `getDetailedLineProblems` signale un
   trou après coup → re-update de l'ancienne ligne = rollback automatique), ajout d'arrêt sur gare connue.
5. **Jamais** — construction, terrain, triche industries/villes, modificateurs.

---

## 6. Pièges connus (vérifiés)

- `getLineCapacityUsages` renvoie en pratique un **tableau dense 1-based** malgré la déclaration `{CargoTypeId : …}` :
  id cargo = clé − 1 (corrigé, `SCHEMA = 2`). Supposer le même piège pour `stopConfig.load/maxLoad`.
- `fireReactEvent` ne renvoie rien : l'ack `ok=true` signifie « envoyé », pas « fenêtre ouverte ».
- `app.loadUserdata` journalise un warning si le fichier manque → toujours lister avec `app.getAllUserdata` avant.
- Les `Engine.Entity` sont réutilisés : vérifier `api.engine.entityExists(e)` avant toute commande (le mod le fait).
- Commandes simulation côté `guiUpdate` : OK ; en revanche `api.gui.*` est **indisponible** côté `update()` moteur.
- `makeVehicleSetLineCmd` avec `stopIndex` hors bornes : comportement non documenté → borner côté mod.
- Les events React dont le nom est faux échouent **silencieusement**.
