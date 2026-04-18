#!/usr/bin/env node
/**
 * freebox-mcp — MCP Server pour piloter une Freebox via Claude
 *
 * Usage (stdio, pour Claude Desktop) :
 *   node dist/index.js
 *
 * Variables d'environnement :
 *   FREEBOX_HOST       (défaut: mafreebox.freebox.fr)
 *   FREEBOX_APP_ID     (défaut: fr.freebox.mcp)
 *   FREEBOX_TOKEN_FILE (optionnel: chemin du fichier token à réutiliser)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FreeboxClient } from "./freeboxClient.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const FREEBOX_HOST = process.env.FREEBOX_HOST ?? "mafreebox.freebox.fr";
const APP_ID = process.env.FREEBOX_APP_ID ?? "fr.freebox.mcp";
const DEBUG = process.env.DEBUG === "1";

function debug(msg: string) {
  if (DEBUG) process.stderr.write(`[DEBUG] ${msg}\n`);
}

const client = new FreeboxClient({
  host: FREEBOX_HOST,
  appId: APP_ID,
  appName: "Freebox MCP",
  appVersion: "1.0.0",
  deviceName: "Claude AI",
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function ok(content: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(content, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `❌ Erreur : ${message}` }],
    isError: true,
  };
}

async function safe(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return ok(result);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── Définition des outils ─────────────────────────────────────────────────

const TOOLS = [
  // AUTH
  {
    name: "freebox_authorize",
    description:
      "Démarre la procédure d'autorisation. Si un token valide est déjà stocké, retourne { alreadyAuthorized: true } SANS écraser le token ni redemander d'appui LCD. Sinon, demande l'autorisation (appui sur '>' sur l'écran LCD Freebox).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_check_authorization",
    description: "Vérifie si l'autorisation en attente a été accordée par l'utilisateur sur la Freebox.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "number", description: "L'identifiant de suivi retourné par freebox_authorize" },
      },
      required: ["track_id"],
    },
  },

  // CONNEXION & SYSTÈME
  {
    name: "freebox_get_connection",
    description: "Retourne l'état de la connexion internet : type (fibre/ADSL), débit montant/descendant, IP publique, état de la ligne.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_get_system",
    description: "Retourne les informations système de la Freebox : température CPU, uptime, modèle, version du firmware, utilisation mémoire.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_reboot",
    description: "Redémarre la Freebox. Action irréversible, demander confirmation à l'utilisateur avant d'appeler cet outil.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // RÉSEAU LOCAL
  {
    name: "freebox_get_lan_hosts",
    description: "Liste les appareils LAN+Wi-Fi. Retourne par défaut une vue compacte paginée (50 max) pour éviter les réponses volumineuses. Utiliser search/active_only/limit/offset/count_only pour affiner.",
    inputSchema: {
      type: "object",
      properties: {
        active_only: { type: "boolean", description: "Ne retourner que les appareils actuellement connectés (active=true). Défaut false." },
        search: { type: "string", description: "Filtre insensible à la casse sur nom, MAC, IP ou vendor." },
        limit: { type: "number", description: "Nombre max d'appareils retournés. Défaut 50. Mettre 0 pour désactiver." },
        offset: { type: "number", description: "Décalage de pagination. Défaut 0." },
        compact: { type: "boolean", description: "Vue compacte (name, mac, ip, type, active, vendor). Défaut true. false = payload brut complet." },
        count_only: { type: "boolean", description: "Retourner uniquement { total, filtered }." },
      },
      required: [],
    },
  },
  {
    name: "freebox_wake_on_lan",
    description: "Envoie un paquet Wake-on-LAN pour réveiller un appareil sur le réseau local.",
    inputSchema: {
      type: "object",
      properties: {
        mac: { type: "string", description: "Adresse MAC de l'appareil (ex: AA:BB:CC:DD:EE:FF)" },
        password: { type: "string", description: "Mot de passe WoL optionnel (6 octets en hexa)" },
      },
      required: ["mac"],
    },
  },

  // WI-FI
  {
    name: "freebox_get_wifi",
    description: "Retourne la configuration Wi-Fi globale de la Freebox (activé/désactivé, puissance).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_toggle_wifi",
    description: "Active ou désactive le Wi-Fi de la Freebox.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true pour activer, false pour désactiver" },
      },
      required: ["enabled"],
    },
  },
  {
    name: "freebox_get_wifi_networks",
    description: "Liste les réseaux Wi-Fi (BSS) configurés : SSID, bande (2.4/5/6 GHz), sécurité, statut.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // TÉLÉCHARGEMENTS
  {
    name: "freebox_get_downloads",
    description: "Liste les téléchargements en cours et terminés avec leur progression, vitesse, taille et statut.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_add_download",
    description: "Ajoute un téléchargement à partir d'une URL (HTTP, magnet, torrent).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL ou lien magnet à télécharger" },
      },
      required: ["url"],
    },
  },
  {
    name: "freebox_pause_download",
    description: "Met en pause un téléchargement en cours.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant du téléchargement" },
      },
      required: ["id"],
    },
  },
  {
    name: "freebox_resume_download",
    description: "Reprend un téléchargement mis en pause.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant du téléchargement" },
      },
      required: ["id"],
    },
  },
  {
    name: "freebox_delete_download",
    description: "Supprime un téléchargement de la liste.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant du téléchargement" },
      },
      required: ["id"],
    },
  },

  // APPELS
  {
    name: "freebox_get_calls",
    description: "Retourne le journal des appels téléphoniques (entrants, sortants, manqués) avec date, durée, numéro et statut.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_mark_call_read",
    description: "Marque un appel manqué comme lu.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant de l'entrée du journal d'appels" },
      },
      required: ["id"],
    },
  },

  // CONTACTS
  {
    name: "freebox_get_contacts",
    description: "Retourne le répertoire téléphonique enregistré sur la Freebox.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // FICHIERS
  {
    name: "freebox_list_files",
    description: "Liste les fichiers et dossiers d'un répertoire du disque de la Freebox.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Chemin absolu (ex: /Disque dur/Films)" },
      },
      required: ["path"],
    },
  },

  // DHCP
  {
    name: "freebox_get_dhcp",
    description: "Retourne la configuration DHCP (plage d'adresses, DNS, gateway) et la liste des baux DHCP actifs.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // REDIRECTION DE PORTS
  {
    name: "freebox_get_port_forwarding",
    description: "Liste les règles de redirection de ports (NAT) configurées sur la Freebox.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_add_port_forwarding",
    description: "Ajoute une règle de redirection de port.",
    inputSchema: {
      type: "object",
      properties: {
        lan_ip: { type: "string", description: "Adresse IP locale de destination" },
        lan_port: { type: "number", description: "Port local de destination" },
        wan_port_start: { type: "number", description: "Port WAN de début" },
        wan_port_end: { type: "number", description: "Port WAN de fin" },
        ip_proto: { type: "string", enum: ["tcp", "udp"], description: "Protocole" },
        comment: { type: "string", description: "Commentaire descriptif" },
        enabled: { type: "boolean", description: "Activer la règle immédiatement" },
      },
      required: ["lan_ip", "lan_port", "wan_port_start", "wan_port_end", "ip_proto", "comment"],
    },
  },
  {
    name: "freebox_delete_port_forwarding",
    description: "Supprime une règle de redirection de port.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant de la règle" },
      },
      required: ["id"],
    },
  },

  // CONTRÔLE PARENTAL
  {
    name: "freebox_get_parental",
    description: "Retourne la configuration du contrôle parental et les filtres actifs par profil.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // MACHINES VIRTUELLES (Ultra/Delta uniquement)
  {
    name: "freebox_get_vms",
    description: "Liste les machines virtuelles configurées (Ultra/Delta uniquement) avec leur état, ressources allouées et configuration réseau.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "freebox_start_vm",
    description: "Démarre une machine virtuelle (Ultra/Delta uniquement).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant de la VM" },
      },
      required: ["id"],
    },
  },
  {
    name: "freebox_stop_vm",
    description: "Arrête une machine virtuelle (Ultra/Delta uniquement).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Identifiant de la VM" },
      },
      required: ["id"],
    },
  },

  // STOCKAGE
  {
    name: "freebox_get_storage",
    description: "Retourne l'état des disques connectés à la Freebox : capacité, espace libre, état SMART, partitions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // FREEPLUG (CPL)
  {
    name: "freebox_get_freeplug",
    description: "Retourne l'état des adaptateurs CPL Freeplug connectés (débit, qualité du lien, voisins).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // STATISTIQUES RRD
  {
    name: "freebox_get_stats",
    description: "Retourne des statistiques historiques (débit, températures, CPU) sur une période donnée.",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          enum: ["net", "temp", "dsl", "switch"],
          description: "Base de données : net (débit), temp (températures), dsl (ADSL/fibre), switch (ports ethernet)",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Champs à récupérer. Pour net: [bw_up, bw_down]. Pour temp: [cpum, cpub, sw, hdd]. Pour dsl: [rate_up, rate_down, snr_up, snr_down].",
        },
        date_start: { type: "number", description: "Timestamp Unix de début (optionnel, défaut: 1h avant)" },
        date_end: { type: "number", description: "Timestamp Unix de fin (optionnel, défaut: maintenant)" },
        precision: { type: "number", description: "Précision en secondes (optionnel)" },
      },
      required: ["db", "fields"],
    },
  },
];

// ─── Serveur MCP ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "freebox-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Liste des outils
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Exécution des outils
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  debug(`tool call: ${name} ${JSON.stringify(a)}`);

  switch (name) {
    // AUTH
    case "freebox_authorize":
      return safe(() => client.startAuthorization());

    case "freebox_check_authorization":
      return safe(() => client.checkAuthorizationStatus(a.track_id as number));

    // CONNEXION & SYSTÈME
    case "freebox_get_connection":
      return safe(() => client.getConnectionStatus());

    case "freebox_get_system":
      return safe(() => client.getSystemInfo());

    case "freebox_reboot":
      return safe(() => client.reboot());

    // RÉSEAU LOCAL
    case "freebox_get_lan_hosts":
      return safe(() => client.getLanHosts({
        active_only: a.active_only as boolean | undefined,
        search: a.search as string | undefined,
        limit: a.limit as number | undefined,
        offset: a.offset as number | undefined,
        compact: a.compact as boolean | undefined,
        count_only: a.count_only as boolean | undefined,
      }));

    case "freebox_wake_on_lan":
      return safe(() => client.wakeOnLan(a.mac as string, a.password as string | undefined));

    // WI-FI
    case "freebox_get_wifi":
      return safe(() => client.getWifiConfig());

    case "freebox_toggle_wifi":
      return safe(() => client.setWifiEnabled(a.enabled as boolean));

    case "freebox_get_wifi_networks":
      return safe(() => client.getWifiBSS());

    // TÉLÉCHARGEMENTS
    case "freebox_get_downloads":
      return safe(() => client.getDownloads());

    case "freebox_add_download":
      return safe(() => client.addDownload(a.url as string));

    case "freebox_pause_download":
      return safe(() => client.updateDownload(a.id as number, "stopped"));

    case "freebox_resume_download":
      return safe(() => client.updateDownload(a.id as number, "downloading"));

    case "freebox_delete_download":
      return safe(() => client.deleteDownload(a.id as number));

    // APPELS
    case "freebox_get_calls":
      return safe(() => client.getCallLog());

    case "freebox_mark_call_read":
      return safe(() => client.markCallRead(a.id as number));

    // CONTACTS
    case "freebox_get_contacts":
      return safe(() => client.getContacts());

    // FICHIERS
    case "freebox_list_files":
      return safe(() => client.listFiles(a.path as string));

    // DHCP
    case "freebox_get_dhcp":
      return safe(async () => ({
        config: await client.getDHCPConfig(),
        leases: await client.getDHCPLeases(),
      }));

    // REDIRECTION DE PORTS
    case "freebox_get_port_forwarding":
      return safe(() => client.getPortForwarding());

    case "freebox_add_port_forwarding":
      return safe(() =>
        client.addPortForwarding({
          lan_ip: a.lan_ip as string,
          lan_port: a.lan_port as number,
          wan_port_start: a.wan_port_start as number,
          wan_port_end: a.wan_port_end as number,
          ip_proto: a.ip_proto as "tcp" | "udp",
          comment: a.comment as string,
          enabled: (a.enabled as boolean) ?? true,
        })
      );

    case "freebox_delete_port_forwarding":
      return safe(() => client.deletePortForwarding(a.id as number));

    // CONTRÔLE PARENTAL
    case "freebox_get_parental":
      return safe(async () => ({
        config: await client.getParentalConfig(),
        filters: await client.getParentalFilters(),
      }));

    // VMs
    case "freebox_get_vms":
      return safe(() => client.getVMs());

    case "freebox_start_vm":
      return safe(() => client.startVM(a.id as number));

    case "freebox_stop_vm":
      return safe(() => client.stopVM(a.id as number));

    // STOCKAGE
    case "freebox_get_storage":
      return safe(() => client.getStorageDisks());

    // FREEPLUG
    case "freebox_get_freeplug":
      return safe(() => client.getFreeplug());

    // STATS RRD
    case "freebox_get_stats":
      return safe(() =>
        client.getRRDStats(
          a.db as string,
          a.fields as string[],
          a.date_start as number | undefined,
          a.date_end as number | undefined,
          a.precision as number | undefined
        )
      );

    default:
      return err(`Outil inconnu: ${name}`);
  }
});

// ─── Démarrage ─────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write("✅ Freebox MCP server démarré (stdio)\n");
  debug(`FREEBOX_HOST=${FREEBOX_HOST}`);
  debug(`FREEBOX_APP_ID=${APP_ID}`);
  debug(`FREEBOX_TOKEN_FILE=${process.env.FREEBOX_TOKEN_FILE ?? "(défaut)"}`);
  debug(`token chargé: ${client.isAuthorized()}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e}\n`);
  process.exit(1);
});
