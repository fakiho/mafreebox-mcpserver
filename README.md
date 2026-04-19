# freebox-mcp 🏠

Developpé à partir du travail de [@HGHugo](https://github.com/HGHugo) — [FreeboxOS-Ultra-Dashboard](https://github.com/HGHugo/FreeboxOS-Ultra-Dashboard), le tableau de bord web pour piloter votre Freebox depuis un navigateur.

**MCP Server pour piloter votre Freebox via Claude AI**

Connecte Claude à l'API officielle Freebox OS pour piloter votre box directement en langage naturel.

> **Intégration** : ce serveur MCP est conçu pour fonctionner aux côtés de [FreeboxOS-Ultra-Dashboard](https://github.com/HGHugo/FreeboxOS-Ultra-Dashboard) (tableau de bord React/Express) via un profil Docker Compose optionnel (`--profile mcp`). Il peut aussi être utilisé seul avec Claude Desktop.

---

## Ce que vous pouvez faire

Une fois connecté, vous pouvez demander à Claude :

- *"Quels appareils sont connectés sur mon réseau ?"*
- *"Montre-moi les téléchargements en cours et leur progression"*
- *"Ajoute ce lien magnet à la liste des téléchargements"*
- *"Quelle est la température de ma Freebox ?"*
- *"Liste mes appels manqués du jour"*
- *"Ouvre le port 8080 vers mon serveur local 192.168.1.10"*
- *"Démarre la VM Ubuntu"*
- *"Active le Wi-Fi"*
- *"Montre-moi les stats de débit des dernières 24h"*

---

## Prérequis

- **Node.js ≥ 22** (ou Docker)
- **Claude Desktop** (avec support MCP)
- Être sur le **même réseau local** que votre Freebox *(l'API Freebox n'est pas accessible depuis internet)*

---

## Installation

### Option 1 — Node.js (recommandé pour Claude Desktop)

```bash
git clone https://github.com/leto1210/mafreebox-mcpserver.git
cd mafreebox-mcpserver
npm install
npm run build
```

### Option 2 — Docker (image pré-compilée)

```bash
docker pull ghcr.io/leto1210/mafreebox-mcpserver:latest
```

Ou construire depuis les sources :

```bash
docker build -t freebox-mcp .
```

### Option 3 — Docker Compose (avec FreeboxOS-Ultra-Dashboard)

Si vous utilisez le [tableau de bord FreeboxOS-Ultra-Dashboard](https://github.com/HGHugo/FreeboxOS-Ultra-Dashboard), le serveur MCP est disponible en tant que profil Compose optionnel :

```bash
docker compose --profile mcp up -d
```

Le service utilise l'image `ghcr.io/leto1210/mafreebox-mcpserver:latest` et partage le volume `freebox_mcp_data` pour la persistance du token.

---

## Lancer le serveur MCP

### Node.js

```bash
node dist/index.js
```

Ou avec des variables d'environnement personnalisées :

```bash
FREEBOX_HOST=192.168.1.254 FREEBOX_TOKEN_FILE=/chemin/token.json node dist/index.js
```

### Docker

```bash
# Image pré-compilée (recommandé)
docker run --rm -it \
  -v freebox-data:/app/data \
  -e FREEBOX_HOST=mafreebox.freebox.fr \
  ghcr.io/leto1210/mafreebox-mcpserver:latest

# Ou depuis une image construite localement
docker build -t freebox-mcp .
docker run --rm -it \
  -v freebox-data:/app/data \
  -e FREEBOX_HOST=mafreebox.freebox.fr \
  freebox-mcp
```

### Dépannage — mode verbose

```bash
docker run --rm -i \
  -v freebox-data:/app/data \
  -e FREEBOX_HOST=mafreebox.freebox.fr \
  -e DEBUG=1 \
  freebox-mcp
```

Les logs `[DEBUG]` apparaissent sur `stderr` : config au démarrage, chargement/sauvegarde du token, chaque appel d'outil et chaque requête HTTP vers l'API Freebox.

> **Note** : le serveur communique via **stdio** — il est conçu pour être lancé par Claude Desktop comme processus enfant, pas comme un service en arrière-plan. Lancez-le manuellement uniquement pour tester ou déboguer.

---

## Configuration Claude Desktop

Editez `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Option 1 — Node.js

```json
{
  "mcpServers": {
    "freebox": {
      "command": "node",
      "args": ["/chemin/absolu/vers/freebox-mcp/dist/index.js"],
      "env": {
        "FREEBOX_HOST": "mafreebox.freebox.fr"
      }
    }
  }
}
```

### Option 2 — Docker (image pré-compilée)

```json
{
  "mcpServers": {
    "freebox": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "freebox-data:/app/data",
        "-e", "FREEBOX_HOST=mafreebox.freebox.fr",
        "ghcr.io/leto1210/mafreebox-mcpserver:latest"
      ]
    }
  }
}
```

> **`-i` et non `-it`** : Claude Desktop communique via stdio sans TTY — `-t` provoque une erreur. `--rm` supprime le conteneur à chaque arrêt ; le volume `freebox-data` assure la persistance du token.

Redémarrez Claude Desktop.

---

## Première connexion (à faire une seule fois)

1. Dans Claude Desktop, demandez : **"Connecte-toi à ma Freebox"**
2. Claude appellera `freebox_authorize`
3. **Sur votre Freebox** : un message s'affiche sur l'écran LCD
4. **Appuyez sur `>`** pour autoriser l'application
5. Demandez à Claude : **"Vérifie si l'autorisation est accordée"** avec le `track_id` retourné
6. ✅ C'est fait ! Le token est sauvegardé pour les prochaines sessions.

---

## Variables d'environnement

| Variable             | Défaut                          | Description                                          |
|----------------------|---------------------------------|------------------------------------------------------|
| `FREEBOX_HOST`       | `mafreebox.freebox.fr`          | Hostname ou IP de la Freebox                         |
| `FREEBOX_APP_ID`     | `fr.freebox.mcp`                | Identifiant de l'application                         |
| `FREEBOX_TOKEN_FILE` | `<dist>/../freebox_token.json`  | Chemin absolu du fichier token. En Docker : `/app/data/freebox_token.json` (défini dans l'image) |
| `DEBUG`              | _(désactivé)_                   | Mettre à `1` pour activer les logs détaillés sur stderr (config, appels d'outils, requêtes API) |

---

## Outils MCP disponibles (29 outils)

### 🔐 Authentification
| Outil | Description |
|-------|-------------|
| `freebox_authorize` | Lance la demande d'autorisation (LCD Freebox) |
| `freebox_check_authorization` | Vérifie si l'autorisation a été accordée |

### 🌐 Connexion & Système
| Outil | Description |
|-------|-------------|
| `freebox_get_connection` | État de la connexion internet, IP publique, débits |
| `freebox_get_system` | Températures, uptime, firmware, mémoire |
| `freebox_reboot` | Redémarre la Freebox |

### 🖥️ Réseau local
| Outil | Description |
|-------|-------------|
| `freebox_get_lan_hosts` | Liste des appareils connectés |
| `freebox_wake_on_lan` | Réveille un appareil par son adresse MAC |

### 📶 Wi-Fi
| Outil | Description |
|-------|-------------|
| `freebox_get_wifi` | Configuration Wi-Fi globale |
| `freebox_toggle_wifi` | Active / désactive le Wi-Fi |
| `freebox_get_wifi_networks` | Liste des réseaux (SSID, bandes, sécurité) |

### ⬇️ Téléchargements
| Outil | Description |
|-------|-------------|
| `freebox_get_downloads` | Liste et progression des téléchargements |
| `freebox_add_download` | Ajoute une URL ou lien magnet |
| `freebox_pause_download` | Met en pause |
| `freebox_resume_download` | Reprend |
| `freebox_delete_download` | Supprime |

### 📞 Téléphonie
| Outil | Description |
|-------|-------------|
| `freebox_get_calls` | Journal d'appels (entrants, sortants, manqués) |
| `freebox_mark_call_read` | Marque un appel manqué comme lu |
| `freebox_get_contacts` | Répertoire téléphonique |

### 📁 Fichiers
| Outil | Description |
|-------|-------------|
| `freebox_list_files` | Explore les fichiers du disque Freebox |

### 🔧 Réseau avancé
| Outil | Description |
|-------|-------------|
| `freebox_get_dhcp` | Config DHCP + baux actifs |
| `freebox_get_port_forwarding` | Règles de redirection de ports |
| `freebox_add_port_forwarding` | Ajoute une règle NAT |
| `freebox_delete_port_forwarding` | Supprime une règle NAT |

### 👨‍👧 Contrôle parental
| Outil | Description |
|-------|-------------|
| `freebox_get_parental` | Profils et filtres de contrôle parental |

### 💻 Machines virtuelles (Ultra/Delta)
| Outil | Description |
|-------|-------------|
| `freebox_get_vms` | Liste des VMs et leur état |
| `freebox_start_vm` | Démarre une VM |
| `freebox_stop_vm` | Arrête une VM |

### 💾 Infrastructure
| Outil | Description |
|-------|-------------|
| `freebox_get_storage` | Disques connectés, espace, état SMART |
| `freebox_get_freeplug` | État des adaptateurs CPL |
| `freebox_get_stats` | Statistiques RRD (débit, températures, DSL) |

---

## agh-sync — pont Freebox ↔ AdGuard Home

Service sidecar qui pousse automatiquement le nom et les métadonnées des appareils depuis la Freebox vers AdGuard Home, sans renoncer au DHCP Freebox.

**Problème résolu** : quand AdGuard Home n'est pas le serveur DHCP, il voit les appareils comme de simples IP — noms absents, filtrage par appareil impraticable, journal de requêtes illisible.

**Comment ça marche** :
- **Voie « live » (3 s)** : surveille `auto_clients` dans AGH, détecte une IP nouvelle, interroge la Freebox, crée le client persistant AGH en < 5 s
- **Voie « reconcile » (5 min)** : balayage complet des hôtes Freebox, met à jour les renommages, supprime les appareils disparus depuis N jours
- **Politique d'autorité** : la Freebox est la source de vérité. Sur collision (nom, IP, MAC), le client AGH existant est adopté/réécrit avec les données Freebox ; les clients AGH sans lien avec la Freebox restent intacts. Les doublons de noms côté Freebox (4 iPhones, etc.) sont désambiguïsés avec un suffixe MAC (ex. `iPhone (A5:18:D4)`)
- **Fichier d'état** : `sync_state.json` mémorise les MAC gérées par le sync pour l'historique et la rétention (suppression après `RETENTION_DAYS` d'inactivité Freebox)

**Bonus inclus d'office** :
- Mapping Freebox `host_type` → tags AGH conventionnels (`device_phone`, `device_laptop`, `device_tv`, `device_printer`, `device_camera`…) → les **règles AGH par tag natives** s'appliquent directement. Seule la liste officielle AGH (21 tags) est autorisée côté serveur, donc les types Freebox sans correspondance directe n'ajoutent aucun tag
- Nom de repli « vendor + 3 derniers octets MAC » quand la Freebox n'a pas de nom (ex. `Apple-AABBCC`)

### Déploiement Docker

> **Note pour une AGH en `--network host`** (cas typique quand AGH gère aussi le DHCP ou utilise `unbound` local) : le sidecar doit utiliser le même mode pour joindre AGH via `127.0.0.1`. C'est la recette par défaut ci-dessous.

```bash
# 1. Construire l'image sidecar (depuis le repo mafreebox-mcpserver cloné sur le host)
docker build --target agh-sync -t mafreebox-agh-sync .
```

#### Recette — AGH en host networking (recommandé)

```yaml
# docker-compose.yml (ou ajouter le service au compose existant d'AGH)
services:
  agh-sync:
    image: mafreebox-agh-sync:latest
    container_name: agh-sync
    restart: unless-stopped
    network_mode: host
    environment:
      FREEBOX_HOST: mafreebox.freebox.fr
      FREEBOX_APP_ID: fr.freebox.agh-sync
      AGH_URL: http://127.0.0.1:8081        # port réel — AGH a peut-être un port non-défaut si nginx-proxy-manager occupe déjà 80/81
      AGH_USER: ${AGH_USER}                 # depuis .env (le nom d'utilisateur admin AGH)
      AGH_PASS: ${AGH_PASS}                 # depuis .env
      POLL_LIVE_MS: "3000"
      POLL_RECONCILE_MS: "300000"
      RETENTION_DAYS: "30"
      EXCLUDE_MACS: ""                      # ex : "aa:bb:cc:dd:ee:ff" — la MAC primaire de la VM AGH (évite de se syncer soi-même)
      LOG_LEVEL: info
    volumes:
      - /home/freebox/agh-sync-data:/app/data   # ajustez le chemin selon votre convention
```

`EXCLUDE_MACS` : récupérez la MAC primaire de la VM AGH avec `ip -br link show | awk '$1!="lo"'` et mettez-la ici.

#### Recette — AGH sur bridge (déploiement fresh)

Si vous installez AGH from-scratch sur un réseau bridge dédié, créez un réseau partagé et utilisez `AGH_URL: http://adguardhome:3000` — voir l'historique git pour l'ancienne recette bridge.

### Première exécution (une seule fois)

Le sidecar a besoin de son propre jeton Freebox (distinct de celui du serveur MCP) :

```bash
# 1. Autoriser (appuyez sur ">" sur l'écran LCD de la Freebox quand invité)
docker compose run --rm agh-sync node dist/agh-sync/authorize.js

# 2. Démarrer le sync
docker compose up -d agh-sync
docker compose logs -f agh-sync
```

### Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `FREEBOX_HOST` | `mafreebox.freebox.fr` | Hostname Freebox |
| `FREEBOX_APP_ID` | `fr.freebox.agh-sync` | App ID dédié — ne partagez pas celui du MCP |
| `FREEBOX_TOKEN_FILE` | `/app/data/agh_sync_token.json` | Token isolé du serveur MCP |
| `AGH_URL` | _(requis)_ | URL interne d'AdGuard Home (ex. `http://adguardhome:3000`) |
| `AGH_USER` / `AGH_PASS` | _(requis)_ | Credentials admin AGH (Basic auth) |
| `POLL_LIVE_MS` | `3000` | Intervalle de la voie live (diff `auto_clients`) |
| `POLL_RECONCILE_MS` | `300000` | Intervalle du balayage complet (5 min) |
| `RETENTION_DAYS` | `30` | Délai avant suppression d'un appareil disparu |
| `EXCLUDE_MACS` | _(vide)_ | Liste de MAC à ignorer (ex. la VM AGH elle-même) |
| `SYNC_STATE_FILE` | `/app/data/sync_state.json` | Cache MAC → nom AGH pour détection des renommages |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Anti-bypass blocklists (optionnel, recommandé)

Ajoute les listes Hagezi de blocage DoH/VPN/Proxy à AGH en une commande :

```bash
docker compose run --rm agh-sync node dist/agh-sync/setup-blocklists.js
```

Idempotent : n'ajoute que les listes absentes. Bloque la **résolution DNS** des serveurs DoH publics (Cloudflare, Google, Quad9…). Ne bloque pas les IP hardcodées — pour ça il faut des règles de pare-feu en amont de la Freebox (Pi en bridge avec iptables, etc.).

### Détection de bypass

Chaque cycle de réconciliation, le sync compare les hôtes actifs sur la Freebox aux clients qui ont effectivement interrogé AGH dans les 24 dernières heures. Les appareils qui ont de l'activité réseau mais zéro requête DNS via AGH sont considérés suspects et exposés dans `/healthz` sous `suspectedBypassers`. Un log d'avertissement est émis au maximum une fois par jour.

### Vérification

1. Après démarrage, ouvrir AGH → **Paramètres → Clients** → vos appareils apparaissent avec le tag AGH conventionnel (`device_phone`, `device_laptop`…) quand le mapping s'applique
2. Déconnecter puis reconnecter un téléphone au Wi-Fi : dans `docker logs -f agh-sync`, vous verrez `[live] + iPhone Ali ip=… mac=…` en quelques secondes
3. Renommer un appareil dans Freebox OS : au prochain tick reconcile, le nom est mis à jour dans AGH
4. Un client créé manuellement dans AGH n'est jamais modifié ni supprimé par le sync (son MAC n'est pas dans `sync_state.json`)

---

## Architecture

```
Claude Desktop
     │
     │ MCP (stdio)
     ▼
freebox-mcp (Node.js)
  ├── src/index.ts           # Serveur MCP + définition des 29 outils
  ├── src/freeboxClient.ts   # Client API Freebox (auth HMAC-SHA1 + endpoints)
  └── Dockerfile             # Image Docker du serveur
     │
     │ HTTP (réseau local uniquement)
     ▼
Freebox OS API v8+
(mafreebox.freebox.fr)
```

Le serveur tourne en **stdio** : Claude Desktop l'exécute comme un processus enfant et communique via stdin/stdout selon le protocole MCP.

---

## Compatibilité Freebox

| Modèle | Support | VMs |
|--------|---------|-----|
| Freebox Ultra | ✅ Complet | ✅ |
| Freebox Delta | ✅ Complet | ✅ |
| Freebox Pop | ✅ Complet | ❌ |
| Freebox Mini 4K | ⚠️ Partiel | ❌ |
| Freebox Revolution | ⚠️ Partiel | ❌ |

---

## Sécurité

- Le token d'authentification est stocké dans `freebox_token.json` (à côté du binaire), ou dans le chemin défini par `FREEBOX_TOKEN_FILE`
- L'API Freebox n'est accessible que depuis le réseau local : aucune donnée ne transite par internet
- Le serveur MCP tourne en local sur votre machine

---

## Licence

MIT
