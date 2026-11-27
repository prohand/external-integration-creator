# External Integration Creator pour Gladys Assistant

Petite application web, à héberger chez soi, pour la communauté [Gladys Assistant](https://gladysassistant.com) :

1. trouver une **intégration externe libre** (personne ne travaille dessus) ;
2. **lancer son développement en un clic** : dépôt GitHub, réglages, issue de suivi, annonce sur le forum… ;
3. **suivre le développement en direct**, y compris quand Claude écrit le code ;
4. **publier** l'intégration dans le store Gladys.

Chacun lance sa propre instance, avec son propre jeton GitHub. Il n'y a pas d'instance publique, et aucune donnée n'est partagée.

> **État du projet** : phase 2 sur 5. Le tableau de bord et le lancement **en simulation** marchent. Le lancement réel, le suivi du développement et la publication arrivent dans les phases suivantes.

---

## Sommaire

- [Installation avec Docker](#installation-avec-docker)
- [Créer le jeton GitHub](#créer-le-jeton-github)
- [Jeton Claude (abonnement Pro ou Max)](#jeton-claude-abonnement-pro-ou-max)
- [Connecter son compte du forum](#connecter-son-compte-du-forum)
- [Derrière un reverse proxy (exemple Pangolin)](#derrière-un-reverse-proxy-exemple-pangolin)
- [Sauvegarder /data](#sauvegarder-data)
- [Mode simulation](#mode-simulation)
- [D'où viennent les données](#doù-viennent-les-données)
- [Développement et tests](#développement-et-tests)

---

## Installation avec Docker

Prérequis : Docker avec le plugin `docker compose`.

```bash
git clone https://github.com/prohand/external-integration-creator.git
cd external-integration-creator

cp .env.example .env
nano .env                       # au minimum : GITHUB_TOKEN

mkdir -p data
sudo chown 1000:1000 data       # l'appli tourne avec l'utilisateur "node" (uid 1000), pas root

docker compose up -d --build
```

Ouvrez ensuite `http://<ip-du-serveur>:3000`.

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
| `APP_PASSWORD` | mot de passe (Basic Auth) si vous n'avez pas de proxy avec authentification | vide = pas de mot de passe |
| `GITHUB_TOKEN` | jeton GitHub fine-grained | — |
| `DRY_RUN` | mode simulation : rien n'est créé | `false` |
| `CACHE_TTL_MINUTES` | durée du cache des sources | `15` |

Mise à jour :

```bash
git pull
docker compose up -d --build
```

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

La page **Réglages** de l'appli teste le jeton. Si un droit manque, elle dit lequel et à quoi il sert.

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
3. Laissez l'**authentification Pangolin** activée : seul vous accédez à l'appli. `APP_PASSWORD` peut alors rester vide.
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

Réglez `APP_PASSWORD` (et éventuellement `APP_USER`). Le navigateur demande alors un identifiant et un mot de passe. Après 10 essais ratés depuis une même adresse, l'accès est bloqué 15 minutes.

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

1. **Tableau de bord** : choisissez une idée dans la colonne « Libre », puis cliquez sur **Lancer**.
2. **Lancer** :
   - le nom est vérifié en direct (tracker, store, forum et GitHub) ;
   - remplissez la description en 4 langues (10 à 100 caractères chacune), 1 à 3 catégories, des mots-clés et le cahier des charges ;
   - cochez les actions automatiques voulues.
3. **Suivi** : les 14 étapes s'affichent en direct, avec leur état (fait, en cours, attention, erreur, à faire). Chaque étape a un bouton **Relancer** et un journal. En simulation, l'étape « Personnaliser » montre le contenu exact des fichiers qui seraient écrits.
4. **Mes intégrations** : toutes vos intégrations lancées et leur état, et le message « Je prends : » à poster sur le forum pour celles pas encore annoncées. Une simulation peut être oubliée.
5. **Réglages** : compte GitHub cible, topics en plus, jeton Claude, compte du forum. Les clés ne sont jamais réaffichées.

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

## Licence

[Apache-2.0](LICENSE), comme le template d'intégration Gladys.
