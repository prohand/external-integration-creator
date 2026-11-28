# External Integration Creator pour Gladys Assistant

Petite application web, à héberger chez soi, pour la communauté [Gladys Assistant](https://gladysassistant.com) :

1. trouver une **intégration externe libre** (personne ne travaille dessus) ;
2. **lancer son développement en un clic** : dépôt GitHub, réglages, issue de suivi, annonce sur le forum… ;
3. **suivre le développement en direct**, y compris quand Claude écrit le code ;
4. **publier** l'intégration dans le store Gladys.

Chacun lance sa propre instance, avec son propre jeton GitHub. Il n'y a pas d'instance publique, et aucune donnée n'est partagée.

> **État du projet** : les 5 phases sont faites : tableau de bord, lancement en 1 clic (simulation ou réel), annonces sur le forum, suivi en direct du développement par Claude, publication dans le store. Tout est testé contre de faux serveurs ; le premier vrai lancement servira de test en conditions réelles.

---

## Sommaire

- [Installation avec Docker](#installation-avec-docker)
- [Créer le jeton GitHub](#créer-le-jeton-github)
- [Jeton Claude (abonnement Pro ou Max)](#jeton-claude-abonnement-pro-ou-max)
- [Suivre le développement en direct](#suivre-le-développement-en-direct)
- [Publier dans le store](#publier-dans-le-store)
- [Connecter son compte du forum](#connecter-son-compte-du-forum)
- [Derrière un reverse proxy (exemple Pangolin)](#derrière-un-reverse-proxy-exemple-pangolin)
- [Sauvegarder /data](#sauvegarder-data)
- [Mode simulation](#mode-simulation)
- [D'où viennent les données](#doù-viennent-les-données)
- [Développement et tests](#développement-et-tests)

---

## Installation avec Docker

Prérequis : Docker avec le plugin `docker compose`. L'image est publiée sur `ghcr.io/prohand/external-integration-creator`, pour `amd64` : pas besoin de cloner le dépôt. Sur une autre architecture (Raspberry Pi, par exemple), construisez l'image vous-même (voir plus bas).

```bash
mkdir external-integration-creator && cd external-integration-creator

# les deux seuls fichiers nécessaires
curl -fsSLO https://raw.githubusercontent.com/prohand/external-integration-creator/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/prohand/external-integration-creator/main/.env.example
nano .env                       # au minimum : GITHUB_TOKEN, et APP_PASSWORD ou NO_PASSWORD=true

mkdir -p data
sudo chown 1000:1000 data       # l'appli tourne avec l'utilisateur "node" (uid 1000), pas root

docker compose up -d
```

Ouvrez ensuite `http://localhost:3000` sur le serveur. Pour y accéder depuis un autre poste, passez par un reverse proxy, ou réglez `BIND_ADDRESS=0.0.0.0` avec un mot de passe (voir [Derrière un reverse proxy](#derrière-un-reverse-proxy-exemple-pangolin)).

L'appli agit avec votre jeton GitHub : elle **refuse de démarrer sans protection**. Réglez `APP_PASSWORD` (12 caractères minimum), ou `NO_PASSWORD=true` si un reverse proxy avec authentification la protège déjà.

Quelques chiffres :

- image : environ 62 Mo compressée ;
- mémoire au repos : environ 20 Mo (limitée à 128 Mo dans `docker-compose.yml`) ;
- une seule dépendance npm.

Les réglages se trouvent dans `.env` (chaque ligne est commentée dans `.env.example`). Les plus utiles :

| Variable | Rôle | Par défaut |
| --- | --- | --- |
| `PORT` | port d'écoute dans le conteneur | `3000` |
| `HOST_PORT` | port publié sur l'hôte | `3000` |
| `BASE_PATH` | sous-chemin derrière un proxy, par ex. `/gladys-creator` | vide |
| `APP_PASSWORD` | mot de passe (Basic Auth), 12 caractères minimum | **obligatoire**, sauf `NO_PASSWORD=true` |
| `NO_PASSWORD` | `true` seulement derrière un reverse proxy qui authentifie (Pangolin, Authelia…) | `false` |
| `BIND_ADDRESS` | adresse où docker compose publie le port : `127.0.0.1` = cette machine seulement | `127.0.0.1` |
| `ALLOWED_HOSTS` | noms de domaine acceptés (ex. `creator.mondomaine.fr`) ; les adresses IP et `localhost` marchent toujours | vide |
| `TRUST_PROXY` | `true` seulement derrière un reverse proxy | `false` |
| `GITHUB_TOKEN` | jeton GitHub fine-grained | — |
| `DRY_RUN` | mode simulation : rien n'est créé | `false` |
| `CACHE_TTL_MINUTES` | durée du cache des sources | `15` |

Mise à jour :

```bash
docker compose pull
docker compose up -d
```

Étiquettes de l'image : `latest` (dernière release), `X.Y.Z` et `X.Y` (une version précise, pour ne pas changer de version sans le vouloir).

Construire l'image soi-même (pour modifier le code) : clonez le dépôt, décommentez `build: .` dans `docker-compose.yml`, puis `docker compose up -d --build`.

---

## Créer le jeton GitHub

L'appli utilise un jeton **fine-grained** (plus sûr qu'un jeton classique : les droits sont limités).

1. Sur GitHub, ouvrez **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Cliquez sur **Generate new token**.
3. **Token name** : par exemple `external-integration-creator`.
4. **Expiration** : choisissez une durée (90 jours, par exemple). Vous referez un jeton à l'expiration.
5. **Resource owner** : votre compte, ou l'organisation où les dépôts seront créés.
6. **Repository access** : **All repositories**. C'est obligatoire : l'appli crée de nouveaux dépôts, qui ne peuvent pas être choisis à l'avance.
7. **Repository permissions** :

   | Droit | Niveau | À quoi il sert |
   | --- | --- | --- |
   | Administration | Read and write | créer le dépôt, appliquer ses réglages, topics, alertes de sécurité |
   | Contents | Read and write | personnaliser les fichiers (un seul commit), lire le code |
   | Workflows | Read and write | ajouter `.github/workflows/claude.yml` |
   | Secrets | Read and write | enregistrer le secret `CLAUDE_CODE_OAUTH_TOKEN` |
   | Issues | Read and write | issue de suivi, étiquettes, messages à Claude |
   | Actions | Read and write | lancer la release, la CI, suivre les exécutions |
   | Metadata | Read-only | obligatoire (coché d'office) |

8. **Account permissions** :

   | Droit | Niveau | À quoi il sert |
   | --- | --- | --- |
   | Watching | Read and write | suivre (« Watch ») le nouveau dépôt |

9. Cliquez sur **Generate token**, copiez le jeton (`github_pat_…`) et collez-le dans `.env` (`GITHUB_TOKEN=`).
10. Redémarrez : `docker compose up -d`.

Ensuite, dans l'appli, page **Réglages → Tester le jeton GitHub** :

- elle affiche le compte du jeton et sa date d'expiration ;
- elle essaie chaque droit sur un de vos dépôts existants, avec des requêtes volontairement invalides : **rien n'est modifié**. Un droit présent donne ✓, un droit manquant ✗, avec à quoi il sert ;
- l'écriture des droits Workflows et Secrets ne peut pas se tester sans rien écrire : elle est vérifiée au premier lancement (?) ;
- si votre compte n'a encore aucun dépôt, les droits seront vérifiés au premier lancement.

Pendant un lancement, si un droit manque, l'étape concernée dit lequel et à quoi il sert. Ajoutez le droit au jeton sur GitHub, puis cliquez sur **Relancer** sur cette étape.

---

## Jeton Claude (abonnement Pro ou Max)

Claude peut écrire le code de l'intégration directement dans le dépôt, via GitHub Actions. L'appli utilise **uniquement votre abonnement Claude** (Pro ou Max), jamais une clé d'API payante.

1. Sur votre ordinateur, installez Claude Code : <https://docs.claude.com/fr/docs/claude-code>.
2. Lancez :

   ```bash
   claude setup-token
   ```

3. Connectez-vous avec votre compte Claude. La commande affiche un jeton longue durée.
4. Dans l'appli, page **Réglages → Jeton Claude**, collez ce jeton. Il est gardé dans `/data` et n'est **jamais réaffiché**.

À chaque lancement, l'appli enregistre ce jeton comme secret `CLAUDE_CODE_OAUTH_TOKEN` dans le nouveau dépôt (chiffré avec la clé publique du dépôt). Sans jeton, les étapes liées à Claude sont simplement sautées.

Pour ménager les limites de l'abonnement, chaque exécution de Claude est limitée à 40 tours (réglable dans `config/repo-settings.json`, clé `claude.max_turns`).

---

## Suivre le développement en direct

L'onglet **Développement** d'une intégration montre ce qui se passe dans le dépôt :

- **le plan de Claude** : son commentaire de suivi dans l'issue, avec ses cases à cocher en check-list et une barre d'avancement ;
- **l'exécution de Claude** (workflow `claude.yml`) : état, durée, étapes et lien vers la page de l'exécution ;
- **les commits** de la branche de Claude et les fichiers modifiés (+/−) ;
- **la pull request** : état, résultat de la CI et lien vers le diff. Le bouton **Ouvrir la PR** la crée avec votre jeton ;
- **le fil d'activité** : démarrages, commits, résultats de la CI, messages envoyés.

Les problèmes sont affichés en haut, avec un bouton **Relancer Claude** :

- **limite d'abonnement atteinte** (lue dans le journal de l'exécution), avec l'heure de fin de la limite quand elle est connue ;
- **tests en échec** dans la CI, avec le job et l'étape en cause. « Relancer Claude » lui envoie alors le lien de la CI et lui demande de corriger.

Le champ **Écrire à Claude** poste un commentaire « @claude … » dans l'issue, avec des boutons rapides : « Explique ce que tu fais », « Ajoute des tests », « Fais plus simple », « Arrête-toi là et ouvre la PR ».

Bon à savoir :

- GitHub est relu **toutes les 20 secondes, seulement quand la page est ouverte** (`DEV_POLL_SECONDS`). Il n'y a pas de webhook : rien à ouvrir sur Internet. Les relectures sans changement ne comptent pas dans la limite d'appels GitHub (réponses 304) ;
- les commits poussés par Claude (avec le jeton du workflow) ne déclenchent pas la CI tout seuls : l'appli lance la CI (`ci.yml`) sur chaque nouveau commit de la branche de Claude.

## Publier dans le store

Quand le travail de Claude est fusionné sur la branche principale, un clic sur **Publier** (écran de suivi, onglet Lancement) enchaîne :

1. **Vérifier que tout est prêt** : aucune pull request ouverte, et du code développé sur la branche principale. Sinon, l'appli refuse : elle ne publie jamais le code de démonstration du modèle.
2. **Contrôle du store** : le workflow `store-check.yml` lance `npx github:GladysAssistant/integration-store . --skip-image-check` sur GitHub. Les erreurs trouvées sont affichées telles quelles.
3. **Release** : le workflow `release.yml` du modèle, en `minor` (réglable dans `config/repo-settings.json`, `publish.release_type`). L'appli suit l'exécution jusqu'au bout (construction de l'image comprise).
4. **Image téléchargeable sans compte** : l'appli vérifie que `ghcr.io/<compte>/<dépôt>:<version>` se télécharge sans identifiant. Si le paquet est privé, elle affiche le lien vers ses réglages : **Danger Zone → Change visibility → Public**, puis **Relancer**.
5. **Topic officiel** : `gladys-integration-wip` est remplacé par `gladys-assistant-integration`. L'indexeur du store peut alors trouver l'intégration.
6. **Indexeur du store** : l'appli lit `rejected.json` et affiche la raison si l'indexeur refuse l'intégration. Si elle n'est pas encore indexée, **Relancer** vérifie à nouveau plus tard.
7. **Annonce de la sortie** : l'intégration rejoint le prochain message de sortie du forum (« … sont sorties en v1.1.0 »), à poster depuis **Mes intégrations**, comme le message « Je prends : ».

Si une étape échoue, corrigez le problème puis cliquez sur **Relancer** sur cette étape : la publication reprend là où elle s'est arrêtée. Une release en échec est relancée sur la même version (« re-run failed jobs ») : jamais deux montées de version pour une seule publication.

## Connecter son compte du forum

Sur le forum Gladys, on n'ouvre **pas un sujet par intégration**. Les lancements s'annoncent **par lot**, dans [le sujet des intégrations candidates](https://community.gladysassistant.com/t/integrations-home-assistant-les-plus-populaires-candidates-pour-des-integrations-externes-gladys/10385), avec un message « Je prends : » qui liste les intégrations.

L'appli fait pareil :

- au lancement, l'intégration est mise de côté pour le **prochain lot** ;
- dans **Mes intégrations**, le bloc « Annonces sur le forum » prépare le message « Je prends : » avec toutes les intégrations en attente. Vous choisissez lesquelles annoncer, vous relisez et modifiez le texte, puis vous cliquez sur **Poster sur le forum** (avec une confirmation) ;
- avant chaque lancement, l'appli cherche aussi le nom dans ce sujet. S'il y est cité (un « Je prends » récent, par exemple), elle affiche les messages concernés pour que vous les lisiez.

Pour poster, l'appli utilise **votre propre compte** du forum, avec une clé personnelle (Discourse « User API Key »). Pas besoin d'une clé d'administrateur :

1. Page **Réglages → Forum Gladys** : cliquez sur **Connecter mon compte du forum**.
2. Cliquez sur **Ouvrir le forum et autoriser**. Connectez-vous au forum si besoin, puis cliquez sur **Autoriser**.
3. Le forum affiche un code. Copiez-le en entier.
4. Revenez dans l'appli, collez le code et cliquez sur **Valider le code**. L'appli affiche « Connecté en tant que … ».

Bon à savoir :

- la clé donne les droits de lecture et d'écriture sur le forum, avec votre compte. Elle reste dans `/data` et n'est jamais réaffichée ;
- il n'y a pas d'adresse de retour : le code passe par copier-coller, rien n'a besoin d'être joignable depuis Internet ;
- le code est chiffré : seule votre instance peut le lire ;
- **Déconnecter** révoque la clé sur le forum. Vous pouvez aussi la révoquer depuis votre profil du forum (onglet **Applications**) ;
- le numéro du sujet se règle dans `config/repo-settings.json` (`forum.topic_id`).

## Derrière un reverse proxy (exemple Pangolin)

L'appli écoute sur un seul port (`PORT`, 3000 par défaut). Elle gère :

- les en-têtes `X-Forwarded-For`, `X-Forwarded-Proto` et `X-Forwarded-Host` (si `TRUST_PROXY=true`) ;
- un sous-chemin avec `BASE_PATH` (par exemple `https://exemple.fr/gladys-creator/`) ;
- le suivi en direct (SSE) : réponses non mises en tampon (`X-Accel-Buffering: no`, `Cache-Control: no-cache`) et un ping toutes les 25 secondes, pour que le proxy ne coupe pas la connexion.

### Pangolin

1. Dans Pangolin, créez une **ressource HTTP** (par exemple `creator.mondomaine.fr`).
2. Cible : `http://<ip-du-serveur>:3000` (ou `http://external-integration-creator:3000` si Pangolin/Newt est sur le même réseau Docker).
3. Laissez l'**authentification Pangolin** activée. Dans `.env` :
   - `NO_PASSWORD=true` (Pangolin authentifie déjà) ;
   - `ALLOWED_HOSTS=creator.mondomaine.fr` (sinon l'appli refuse ce nom de domaine) ;
   - `TRUST_PROXY=true` ;
   - gardez `BIND_ADDRESS=127.0.0.1` : le port n'est alors joignable que depuis le serveur lui-même (et le réseau Docker), jamais en direct depuis le réseau, ce qui contournerait l'authentification de Pangolin.
4. Pour servir l'appli dans un sous-chemin plutôt qu'un sous-domaine, réglez `BASE_PATH=/gladys-creator` et utilisez ce même chemin dans Pangolin.

### Nginx (pour info)

```nginx
location /gladys-creator/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # suivi en direct (SSE)
    proxy_read_timeout 1h;
}
```

### Sans reverse proxy

Réglez `APP_PASSWORD` (12 caractères minimum, et éventuellement `APP_USER`) et `BIND_ADDRESS=0.0.0.0` pour ouvrir le port au réseau. Laissez `TRUST_PROXY=false`. Le navigateur demande un identifiant et un mot de passe. Contre les essais en rafale :

- après 10 essais ratés depuis une même adresse, cette adresse est bloquée 15 minutes ;
- après 100 essais ratés au total, toutes les adresses sont ralenties jusqu'à la fin des 15 minutes (redémarrer le conteneur lève le blocage).

Pour l'ouvrir via un nom de domaine, ajoutez-le à `ALLOWED_HOSTS`.

---

## Sauvegarder /data

Tout l'état de l'appli tient dans **un seul fichier** : `data/state.json` (intégrations lancées, réservations, réglages, clés du forum et de Claude).

```bash
# sauvegarde (le fichier est écrit de façon atomique : pas besoin d'arrêter l'appli)
cp data/state.json "sauvegarde-state-$(date +%F).json"
chmod 600 sauvegarde-state-*.json     # il contient des clés : à protéger

# restauration
docker compose stop
cp sauvegarde-state-2026-01-01.json data/state.json
sudo chown 1000:1000 data/state.json
docker compose start
```

Le jeton GitHub, lui, est dans `.env` : sauvegardez ce fichier à part, en lieu sûr.

---

## Utilisation

1. **Tableau de bord** : choisissez une idée dans la colonne « Libre », puis cliquez sur **Lancer**. Après une confirmation, tout part :
   - le nom, le dépôt et les catégories viennent du tracker ;
   - la description anglaise reprend celle de Home Assistant, les descriptions fr, de et es sont génériques. Claude est chargé d'en écrire de vraies (c'est dans l'issue et dans `CLAUDE.md`) ;
   - le cahier des charges demande de reproduire l'intégration Home Assistant, avec le lien vers sa documentation ;
   - pas de mots-clés par défaut : l'intégration reste compatible avec Gladys 5.1.0.
2. **Personnaliser…** (lien sous le bouton Lancer) ouvre le formulaire : nom, dépôt et vérification du nom en direct. Le reste (descriptions, catégories, mots-clés, cahier des charges, actions automatiques, simulation) est dans le bloc **Avancé**, replié.
3. **Suivi** : les 14 étapes s'affichent en direct, avec leur état (fait, en cours, attention, erreur, à faire). Chaque étape a un bouton **Relancer** et un journal. En simulation, l'étape « Personnaliser » montre le contenu exact des fichiers qui seraient écrits.
4. **Suivi, onglet Développement** : voir [Suivre le développement en direct](#suivre-le-développement-en-direct).
   Le bouton **Publier**, sous les étapes du lancement : voir [Publier dans le store](#publier-dans-le-store).
5. **Mes intégrations** : toutes vos intégrations lancées et leur état, et le message « Je prends : » à poster sur le forum pour celles pas encore annoncées. Une simulation peut être oubliée.
6. **Réglages** : compte GitHub cible, topics en plus, jeton Claude, compte du forum. Les clés ne sont jamais réaffichées.

## Mode simulation

Avec `DRY_RUN=true`, toutes les étapes du lancement se déroulent et sont journalisées, mais **rien n'est créé** : ni sur GitHub, ni sur le forum. Les lectures (vérification du nom, sources) restent réelles. Pratique pour découvrir l'appli sans risque.

---

## D'où viennent les données

- **Source principale** : le [tracker communautaire](https://william-de71.github.io/gladys-integrations-tracker/), mis à jour toutes les 30 minutes. Ses statuts sont repris tels quels :
  - **Existe** : Publiée (store), Native Gladys, Topic store posé pas encore indexée, Hors store inactive, Archivée/dépréciée ;
  - **En cours** : En cours (dépôt GitHub), Annoncée sur le forum, et les intégrations lancées depuis votre instance (en attendant la prochaine mise à jour du tracker) ;
  - **Libre** : Libre.
  
  Un statut inconnu est rangé dans « Existe » (avec un badge), pour ne jamais proposer de lancer quelque chose de douteux. Une idée « Libre » dont le nom correspond à une intégration déjà connue n'est pas proposée non plus.
- Les colonnes des CSV sont repérées par leur **nom**, pas leur position. Si une colonne indispensable disparaît, l'appli affiche une erreur claire.
- **Au moment du lancement**, le nom est revérifié (le tracker peut avoir 30 minutes de retard) : catalogue du store, forum, et GitHub.

---

## Développement et tests

```bash
npm test          # node:test, avec un faux GitHub, un faux forum et un faux tracker : aucun appel réseau réel
npm run dev       # mode simulation, données dans ./data, redémarre à chaque modification
```

Node.js 22 ou plus. Pas de framework, pas d'étape de build : `src/` (serveur `node:http`) et `public/` (HTML, CSS et JavaScript natifs).

## Publier une version de l'appli (mainteneurs)

Deux workflows GitHub Actions :

- **CI** (`.github/workflows/ci.yml`), à chaque push sur `main` et sur chaque pull request : syntaxe JavaScript, tests sur Node 22 et 24, construction de l'image Docker (sans la publier) ;
- **Release** (`.github/workflows/release.yml`), lancé à la main : **Actions → Release → Run workflow**, sur `main`, puis le choix de version :
  - `patch` (0.5.0 → 0.5.1), `minor` (→ 0.6.0) ou `major` (→ 1.0.0) ;
  - `current` publie la version actuelle de `package.json` sans la changer (utile pour la toute première release).

  Il lance les tests, commite la nouvelle version sur `main`, pose le tag `vX.Y.Z`, publie l'image `ghcr.io/…:X.Y.Z`, `:X.Y` et `:latest`, puis crée la release GitHub avec des notes générées automatiquement.

Après la première release, rendez le paquet public une fois pour toutes : page du paquet → **Package settings → Danger Zone → Change visibility → Public**.

## Licence

[Apache-2.0](LICENSE), comme le template d'intégration Gladys.
