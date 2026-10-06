# TF3 Dashboard - export + base de donnees + tableau de bord (documentation detaillee, FR)

Version courte en anglais : [../README.md](../README.md). Depot : https://github.com/M1r077/tf3-dashboard

Demarrage rapide (jeu lance, mod « Dashboard Export » actif dans la partie) : `run_dashboard.cmd`
-> ouvre une fenetre Windows Terminal (profil « TF3 Dashboard », 2 volets : collecteur | serveur) puis
http://127.0.0.1:8765/. Sur un second ecran : navigateur en plein ecran (F11). Fermer la fenetre arrete tout.
Le profil « TF3 Dashboard » est aussi dans le menu « + » de Windows Terminal (icone TF3, meme style que BTG Server) ;
il lance `run_dashboard.cmd` dans l'onglet courant. Sans Windows Terminal : repli sur deux consoles classiques.
Demo sans le jeu : `run_dashboard_demo.cmd` (donnees simulees, port 8766).
Lancer le jeu **sans les logos d'intro** : `launch_tf3.cmd` (raccourcis bureau « Transport Fever 3 (sans intro) » et
« Transport Fever 3 + Dashboard »). Le jeu n'a pas d'option de ligne de commande pour ca ; le script met
`showSplashScreen = false` et `splashMusicEnabled = false` dans `userdata\...\local\settings.lua` juste avant de
lancer Steam (le jeu reecrit ce fichier a chaque demarrage, d'ou le patch systematique). Reglages caches, absents du menu.
Helpers de volet : `_collector.cmd`, `_server.cmd [--port N] [--db PATH]` (restent ouverts en cas d'erreur, touche = relance ;
`_server.cmd` refuse de demarrer si le port est deja pris, pour ne pas laisser tourner une vieille instance).

Trois morceaux independants :

1. **Mod `tf3_dashboard_export`** (staging `...\staging_area\tf3_dashboard_export`) : game script en lecture seule qui ecrit
   `<Steam>\userdata\<id>\3493540\local\dashboard_export\live.lua` via `app.saveUserdata` (dossier detecte automatiquement par `collector\tf3paths.py` : registre Steam, ou `config.json`).
   - sections rapides (defaut 2 s) : `time`, `finance`, `alerts`, `vehicles`
   - sections lentes (defaut 30 s) : `company`, `lines`, `stations`, `towns`, `industries`, `depots`, `cargo_types`
   - chaque section est dans un `pcall` ; une section qui echoue apparait dans `errors` sans bloquer le reste
   - parametres du mod (menu Mods de la partie) : intervalle rapide / lent, export des vehicules on/off,
     **accepter les commandes du dashboard** on/off, log debug
   - a activer dans la partie (menu Mods), comme tout mod de script
   - exporte aussi la langue du jeu (`time.lang`), le type d'icone de chaque vehicule (icon_type : Bus, Truck,
     TrainSteam/Electric/Diesel, Tram, Aircraft, Helicopter, Ship), le nom du modele (model, localise), la cle neutre
     du modele (`model_key`, ex. `train/re_44i`) et la composition complete (`parts`, ex. `train/re_44i,waggon/ew_ii,
     -waggon/ew_ii` ; `-` = element retourne) pour afficher les vraies icones
   - les types de cargo sont exportes avec leur nom localise ET une cle neutre (`key`, nom du fichier `.cargo`) ;
     la langue et les noms de cargo sont relus a chaque cycle lent, donc **changer la langue dans le jeu est pris en
     compte sans redemarrer** (le dashboard suit la langue du jeu tant que le selecteur est sur « auto »)
   - **canal retour (dashboard -> jeu)** : le mod lit dashboard_export\cmd.lua 4x/s (`app.loadUserdata`), execute
     la commande si elle est dans la liste blanche, supprime le fichier et renvoie cmd_ack dans le snapshot suivant.
     Commandes : set_speed (0 = pause, 1, 2, 4), pause, toggle_pause, focus_entity, focus_position,
     follow_entity, select_entity (ouvre la fiche de l'entite dans le jeu, comme un clic), open_line_manager
     (gestionnaire lignes/vehicules sur une ligne), close_windows, vehicle_stop, vehicle_start, vehicle_reverse,
     vehicle_depart, vehicle_to_depot, ping. Rien d'irreversible (pas d'achat, vente, destruction).
     **Gestion de ligne** : line_set_stop (mode de chargement, arret min/max, attente suppl., cargos non charges,
     dechargement force d'un arret ; le mod copie le composant Line, modifie les champs donnes et renvoie
     makeLineUpdateCmd, exactement comme la fenetre filtres du jeu ; le trace n'est jamais touche), line_set_all_stops,
     line_stop_all / line_start_all / line_all_to_depot (une commande par vehicule), rename_entity,
     line_set_terminals (quai prefere + quais alternatifs d'un arret ; la gare ne change pas, le jeu recalcule le chemin
     et peut refuser s'il n'y en a pas, comme dans sa propre fenetre).
     Le mod exporte la configuration de chaque arret (stop_list : load_mode, min_wait, max_wait, max_add_wait,
     waypoints, force_unload, no_load, max_load, terminals = quais de la gare avec type / classe / longueur /
     speed_mod / compatible / overlength, alternatives = quais alternatifs) + custom_filters / reservation_priority.
     Catalogue complet de ce que l'API permet (fait / faisable / risque / impossible) : docs/API_CATALOGUE.md.

2. **Collecteur `collector\collector.py`** (Python 3.12, stdlib uniquement) : surveille `live.lua`, le parse
   (`luatable.py`, parser Lua maison) et remplit `db\tf3_dashboard.db` (SQLite, schema `collector\schema.sql`).
   - `run_collector.cmd` : lance la surveillance (Ctrl+C pour arreter)
   - `python collector.py --once` : importe le fichier courant une fois
   - `python collector.py --status` : resume de la base
   - `python collector.py --list-games` / `--forget-game <id>` : une « partie » = un joueur (entite player) ; le dashboard
     n'affiche que la derniere partie vue. `--forget-game` supprime tout ce qui a ete enregistre pour une autre sauvegarde.
   - un snapshot qui fait planter l'import est journalise dans `db\collector_errors.log` (trace complete) et saute ;
     le collecteur continue.
   - les sections lentes ne sont stockees que lorsqu'elles ont ete re-collectees (`slow_seq` change)

3. **Dashboard `dashboard\server.py`** (stdlib, lecture seule sur la base) : API JSON (`/api/overview`, `finance`, `alerts`,
   `lines`, `line_history?id=`, `vehicles`, `fleet`, `vehicle_history?id=`, `towns`, `town_history?id=`, `industries`,
   `stations`, `depots`, `map`) + `POST /api/cmd` (`{cmd, args}` -> ecrit `cmd.lua` pour le mod ; local uniquement ;
   `--no-cmd` pour desactiver, `--cmd-dir` pour changer le dossier) et page `static\index.html` (rafraichissement 3 s,
   `?tab=lines` pour ouvrir un onglet, `?lang=de` pour forcer la langue).
   - **Multilingue** : `static\i18n.js` (fr / en / de). Langue = `?lang=` > choix dans le selecteur (localStorage) > langue
     du jeu (exportee par le mod) > navigateur. Pour ajouter une langue : copier le bloc `en` et traduire.
   - **Icones du jeu** : `dashboard\extract_icons.py` extrait les TGA de `base\content\gui.zip`, `game_mechanics.zip` et
     `cargos\*.zip` en PNG blanc-sur-alpha (recolores en CSS via mask) dans `static\icons\` (+ `icons\cargo\` en couleur,
     nommees par cle neutre `grain.png`...). Extrait aussi les **icones de tous les vehicules** (vue de cote en couleur,
     base + DLC : bus, camions, trams, locos, wagons, avions, helicos, zeppelins, bateaux) dans `icons\vehicles\<cat>\<modele>.png`
     + `_manifest.json` ; le dashboard affiche le modele reel dans les tableaux et la **composition entiere du train** dans la
     fiche vehicule (modele inconnu, ex. mod -> pictogramme generique). Stdlib uniquement (decodeur TGA + ecriture PNG
     maison, pas de Pillow) ; lance automatiquement par `_server.cmd` au premier demarrage si `static\icons\_manifest.json`
     manque ; le jeu est trouve via les bibliotheques Steam (`libraryfolders.vdf`) ou `game_dir` dans `config.json`.
     Les icones ne sont pas redistribuees. A relancer apres une mise a jour du jeu (supprimer `static\icons`).
   - **Controle du jeu** : barre pause / x1 / x2 / x4 dans le bandeau (raccourcis Espace, 1, 2, 3), boutons camera sur les
     vehicules / lignes / villes / industries / gares / depots / alertes, fiche vehicule : suivre, arreter / demarrer,
     inverser, partir, envoyer au depot ; clic sur la carte = camera sur l'objet (Maj+clic sur un vehicule = suivre).
     Grise si le param « accepter les commandes » du mod est off.
   - **Arrets & departs** (detail d'une ligne) : tableau des arrets avec mode de depart, arret min / max, attente
     supplementaire, cargos autorises ; crayon = edition d'un arret (liste mode, champs secondes, chips cargo a cocher,
     « decharger de force »), « Appliquer » n'envoie que les champs modifies, « Appliquer a tous les arrets » copie
     mode + attentes sur toute la ligne. Boutons ligne : arreter / demarrer tous les vehicules, tous au depot (confirmation).
     Cargo : les chips montrent les cargos que les vehicules peuvent charger a l'arret ; clic -> fenetre avec tous les
     types de cargo (passagers en premier), selection puis OK / Echap / clic dehors = envoi immediat de line_set_stop
     no_load (Annuler = rien). Quais (dans l'editeur) : une ligne par quai de la gare avec son type (passagers / tous
     cargos / classe specialisee), le bonus ou malus de chargement pour le cargo de la ligne (+100 % / -75 %), la
     longueur, un avertissement « trop court », la mention « incompatible (lent) » pour les quais d'un autre mode de
     transport ; case = les vehicules peuvent s'y arreter, etoile = quai prefere (au moins un quai doit rester coche).
     Onglets Lignes et Vehicules : icone du type de vehicule devant le nom et barre de filtres par type (plusieurs
     types cumulables, croix pour effacer).
     Lien direct : `?tab=lines&line=<id>` ; `?tab=vehicles&veh=<id>`.
   - **Reglages** (engrenage en haut a droite, memorises dans le navigateur) : langue, taille des icones (S/M/L/XL),
     taille du texte, densite des tableaux, intervalle de rafraichissement, longueur d'historique des courbes, masquer
     Finances, raccourcis clavier on/off, onglet au demarrage.
   - **Graphiques** (uPlot) : glisser = zoom, double-clic = retour, clic sur la legende = masquer une serie, curseur
     synchronise entre les graphiques d'un meme onglet. Plage de temps (15 min ... 7 j, tout) a droite des onglets ;
     la partie ancienne (moyennes par minute, voir retention) est hachuree et marquee « moyenne 1 min » dans l'infobulle.
   - **Disposition des panneaux** (crayon en haut a droite, ou Reglages > Panneaux) : dans chaque onglet, glisser un
     panneau par sa poignee pour le reordonner, tirer le bord droit (largeur, en 12e de la grille) ou le bord bas
     (hauteur fixe : les graphiques et listes remplissent la carte), boutons -/+ et hauteur auto, masquer un panneau
     (il reapparait via la barre « Panneaux masques »). Echap ou Termine pour quitter. Memorise par onglet dans le
     navigateur (localStorage `tf3.layout`) ; « Reinitialiser cet onglet » / « tous les onglets ».
   - **Exploitation** (page d'accueil) : bandeau vital (date/vitesse, vehicules par etat, remplissage global, etat
     technique moyen, alertes, transporte, tresorerie en retrait), flotte en service dans le temps (empile en route /
     terminal / depot), tableau par transporteur (remplissage, etat, vitesse moyenne, immobiles), alertes avec anciennete,
     remplissage & vitesse moyenne dans le temps, vehicules immobilises / sans ligne, usure (a reviser en premier),
     vehicules bloques en route (vitesse nulle sur plusieurs releves), lignes les plus mecontentes / les plus chargees
   - **Lignes** : tableau triable/filtrable (arrets, vehicules, frequence, charge, a bord, % pax mecontents, % cargo en
     retard, cargos) ; clic -> itineraire, capacites par cargo, historique (vehicules/a bord, qualite)
   - **Vehicules** : filtre texte/transporteur/etat/usure/problemes ; ligne, etat (sans chemin, arrete), vitesse, charge,
     etat technique, jours immobile, cout/an, valeur, ville la plus proche ; clic -> fiche + historique vitesse/charge/etat
   - **Villes** : capacites res/com/ind (occupe/total), mecontents, part des transports publics, trafic, bruit,
     pollution, croissance ; clic -> detail bonheur par mode, accessibilite, besoins cargo, lignes les plus utilisees,
     historique
   - **Industries** : niveau/progression, statut (produit, fermeture, boost, manuel, jete), rendement, entrees/sorties
     par an avec max et expedie/livre ; filtre « non desservies / en fermeture »
   - **Gares & depots** : attente, occupation, debordement, lignes ; vehicules gares, en approche, pool maintenance
   - **Carte** : villes (taille), gares (pax/cargo), industries, traces des lignes, vehicules en direct (couleur de
     ligne, contour rouge = a l'arret en route), alertes geolocalisees ; filtre par ligne, noms des vehicules, zoom,
     deplacement, survol, recentrer
   - **Finances** (dernier onglet) : tresorerie/dette, resultat de l'annee, transport cumule, fiche entreprise, couts
     d'exploitation par transporteur

## Schema (resume)

- `game` : une ligne par partie (cle = entite joueur)
- `snapshot` : une ligne par export (seq, heure reelle, date jeu, vitesse, nb erreurs) ; toutes les tables de faits y pointent
- faits par snapshot : `finance`, `company`, `alert`, `vehicle_state`, `line_state`, `line_capacity`, `station_state`,
  `town_state`, `town_cargo`, `town_top_line`, `industry_state`, `industry_cargo`, `depot_state`
- dimensions (attributs courants, upsert) : `vehicle`, `line`, `line_stop`, `station`, `town`, `industry`, `depot`, `cargo_type`
- vues : `v_latest_snapshot`, `v_finance_series`, `v_line_latest`, `v_vehicle_latest`, `v_alert_latest`
- versions : `snapshot.schema` cote mod (1 = initial ; 2 = ids cargo des capacites de ligne corriges) ;
  `PRAGMA user_version` cote base (1 = correction appliquee aux `line_capacity` deja stockees). Le collecteur
  corrige a la volee les exports d'un mod encore en schema 1 (decalage +1 : un bus « transportait des vehicules »).

## Exemples SQL

```sql
-- courbe de tresorerie
SELECT real_time, year, month, balance, loan FROM v_finance_series ORDER BY snapshot_id;

-- lignes les plus mecontentes (dernier snapshot lent)
SELECT name, vehicles, pax_bad, pax_total, ROUND(100.0*pax_bad/NULLIF(pax_total,0),1) AS pct_bad
FROM v_line_latest ORDER BY pct_bad DESC;

-- alertes en cours
SELECT kind, entity_id, type_code, amount FROM v_alert_latest;

-- vehicules a l'arret depuis longtemps
SELECT name, carrier, state, days_in_depot, days_at_terminal FROM v_vehicle_latest
WHERE state IN ('IN_DEPOT','AT_TERMINAL') ORDER BY days_in_depot + days_at_terminal DESC;
```

## Codes des alertes (type_code)

- `line_problem` : ZERO_OR_ONE_STATION / DOUBLE_STATIONS / INCOMPATIBLE_STATIONS / NO_PATH / BAD_ALTERNATIVE_TERMINAL (enum du jeu, type.d.tl ~L2140)
- `vehicle_problem` : NoPathElectric / NoPathShip / NoPathAircraft / NoPathGeneric / Blocked (~L2158)
- `line_issue` : NowhereToLoad / NowhereToUnload / NoVehicleToLoadCargo / VehicleUseless / LineCargoConfig (~L5716)
- `town_problem` : Disconnected / Overlength

Les valeurs numeriques exactes seront relevees au premier export reel et notees ici.
