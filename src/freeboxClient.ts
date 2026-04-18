/**
 * freebox-mcp — client d'authentification et d'accès à l'API Freebox OS
 *
 * Flow d'authentification :
 *  1. GET /api_version                → découverte
 *  2. POST /api/vX/login/authorize/   → demande d'app_token (affichage LCD Freebox)
 *  3. GET  /api/vX/login/             → obtenir le challenge
 *  4. POST /api/vX/login/session/     → ouvrir la session avec HMAC-SHA1(app_token, challenge)
 *  5. Toutes les requêtes → header X-Fbx-App-Auth: <session_token>
 */

import { createHmac } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";

function debug(msg: string) {
  if (process.env.DEBUG === "1") process.stderr.write(`[DEBUG] ${msg}\n`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveTokenFilePath(): string {
  const configured = process.env.FREEBOX_TOKEN_FILE;
  if (!configured) {
    return join(__dirname, "..", "freebox_token.json");
  }
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

export interface FreeboxConfig {
  host: string;       // ex: "mafreebox.freebox.fr"
  appId: string;      // ex: "fr.freebox.mcp"
  appName: string;    // ex: "Freebox MCP"
  appVersion: string; // ex: "1.0.0"
  deviceName: string; // ex: "Claude MCP"
}

interface StoredToken {
  appToken: string;
  trackId: number;
  apiVersion: number;
}

interface SessionInfo {
  sessionToken: string;
  permissions: Record<string, boolean>;
}

export class FreeboxClient {
  private config: FreeboxConfig;
  private tokenFilePath: string;
  private apiVersion = 8;
  private sessionToken: string | null = null;
  private appToken: string | null = null;

  constructor(config: FreeboxConfig) {
    this.config = config;
    this.tokenFilePath = resolveTokenFilePath();
    this.loadStoredToken();
  }

  // ─── Persistance du token ───────────────────────────────────────────────────

  private loadStoredToken(): void {
    debug(`chargement token depuis: ${this.tokenFilePath}`);
    if (existsSync(this.tokenFilePath)) {
      try {
        const data: StoredToken = JSON.parse(readFileSync(this.tokenFilePath, "utf8"));
        this.appToken = data.appToken;
        this.apiVersion = data.apiVersion ?? 8;
        debug(`token chargé (apiVersion=${this.apiVersion})`);
      } catch (e) {
        debug(`échec lecture token: ${e}`);
      }
    } else {
      debug("aucun token existant");
    }
  }

  private saveToken(appToken: string, trackId: number): void {
    const data: StoredToken = { appToken, trackId, apiVersion: this.apiVersion };
    const tokenDir = dirname(this.tokenFilePath);
    debug(`sauvegarde token dans: ${this.tokenFilePath}`);
    if (!existsSync(tokenDir)) {
      mkdirSync(tokenDir, { recursive: true });
    }
    writeFileSync(this.tokenFilePath, JSON.stringify(data, null, 2));
    debug("token sauvegardé");
  }

  // ─── URL builder ────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `http://${this.config.host}/api/v${this.apiVersion}${path}`;
  }

  // ─── Low-level fetch ────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
    _retried = false
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authenticated && this.sessionToken) {
      headers["X-Fbx-App-Auth"] = this.sessionToken;
    }

    debug(`→ ${method} ${this.url(path)}`);
    const res = await fetch(this.url(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as { success: boolean; result: T; msg?: string; error_code?: string };
    debug(`← ${res.status} success=${json.success}${json.error_code ? ` error=${json.error_code}` : ""}`);

    if (!json.success) {
      // Session périmée ou permissions mises à jour côté Freebox : on la jette et on rejoue une fois.
      if (
        authenticated &&
        !_retried &&
        json.error_code === "auth_required" &&
        this.appToken
      ) {
        debug("auth_required : réouverture de session + retry");
        this.sessionToken = null;
        await this.openSession();
        return this.request<T>(method, path, body, authenticated, true);
      }
      throw new Error(`Freebox API error [${json.error_code ?? "unknown"}]: ${json.msg ?? "no message"}`);
    }

    return json.result;
  }

  // ─── Découverte ─────────────────────────────────────────────────────────────

  async discover(): Promise<void> {
    const res = await fetch(`http://${this.config.host}/api_version`);
    const info = (await res.json()) as { api_version: string };
    const major = parseInt(info.api_version.split(".")[0]);
    if (major > 0) this.apiVersion = major;
  }

  // ─── Authentification ───────────────────────────────────────────────────────

  /**
   * Lance la procédure d'autorisation initiale.
   * L'utilisateur doit appuyer sur ">" sur la Freebox.
   * Retourne le track_id pour pouvoir poller le statut.
   *
   * Si un app_token est déjà stocké ET fonctionnel, retourne
   * { alreadyAuthorized: true } sans écraser le token.
   */
  async startAuthorization(): Promise<{
    trackId: number;
    message: string;
    alreadyAuthorized?: boolean;
    permissions?: Record<string, boolean>;
  }> {
    await this.discover();

    // Guard-rail : si le token stocké ouvre déjà une session, ne pas en redemander un.
    if (this.appToken) {
      try {
        this.sessionToken = null;
        const info = await this.openSession();
        return {
          trackId: 0,
          message:
            "Déjà authentifié — le token stocké est valide. Aucune nouvelle autorisation requise.",
          alreadyAuthorized: true,
          permissions: info.permissions,
        };
      } catch (e) {
        debug(
          `token stocké invalide (${e instanceof Error ? e.message : String(e)}), lancement d'une nouvelle autorisation`
        );
        this.sessionToken = null;
        this.appToken = null;
      }
    }

    const result = await this.request<{ app_token: string; track_id: number }>(
      "POST",
      "/login/authorize/",
      {
        app_id: this.config.appId,
        app_name: this.config.appName,
        app_version: this.config.appVersion,
        device_name: this.config.deviceName,
      },
      false
    );

    this.appToken = result.app_token;
    this.saveToken(result.app_token, result.track_id);

    return {
      trackId: result.track_id,
      message: `Autorisation en attente (track_id: ${result.track_id}). Veuillez appuyer sur ">" sur votre Freebox.`,
    };
  }

  /**
   * Vérifie l'état de la demande d'autorisation.
   */
  async checkAuthorizationStatus(trackId: number): Promise<{ status: string; challenge?: string }> {
    const result = await this.request<{ status: string; challenge: string }>(
      "GET",
      `/login/authorize/${trackId}`,
      undefined,
      false
    );
    return result;
  }

  /**
   * Ouvre une session à partir de l'app_token stocké.
   * Calcule le password = HMAC-SHA1(app_token, challenge)
   */
  async openSession(): Promise<SessionInfo> {
    if (!this.appToken) {
      throw new Error("Aucun app_token. Lancez d'abord startAuthorization().");
    }

    // 1. Obtenir le challenge
    const loginResult = await this.request<{ logged_in: boolean; challenge: string }>(
      "GET",
      "/login/",
      undefined,
      false
    );

    // 2. Calculer le password
    const password = createHmac("sha1", this.appToken)
      .update(loginResult.challenge)
      .digest("hex");

    // 3. Ouvrir la session
    const session = await this.request<{ session_token: string; permissions: Record<string, boolean> }>(
      "POST",
      "/login/session/",
      {
        app_id: this.config.appId,
        password,
      },
      false
    );

    this.sessionToken = session.session_token;
    return { sessionToken: session.session_token, permissions: session.permissions };
  }

  /**
   * S'assure qu'une session est ouverte, sinon en ouvre une.
   */
  async ensureSession(): Promise<void> {
    if (!this.sessionToken) {
      await this.openSession();
    }
  }

  async closeSession(): Promise<void> {
    if (!this.sessionToken) return;
    try {
      await this.request("POST", "/login/logout/", {});
    } finally {
      this.sessionToken = null;
    }
  }

  // ─── APIs métier ────────────────────────────────────────────────────────────

  async getConnectionStatus() {
    await this.ensureSession();
    return this.request("GET", "/connection/");
  }

  async getSystemInfo() {
    await this.ensureSession();
    return this.request("GET", "/system/");
  }

  async reboot() {
    await this.ensureSession();
    return this.request("POST", "/system/reboot/", {});
  }

  async getLanHosts(opts?: {
    active_only?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
    compact?: boolean;
    count_only?: boolean;
  }) {
    await this.ensureSession();
    const raw = await this.request("GET", "/lan/browser/pub/");
    const hosts: any[] = Array.isArray(raw) ? raw : [];
    const o = opts ?? {};
    const compact = o.compact !== false;
    const limit = typeof o.limit === "number" ? o.limit : 50;
    const offset = typeof o.offset === "number" && o.offset > 0 ? o.offset : 0;
    const needle = typeof o.search === "string" && o.search.length > 0 ? o.search.toLowerCase() : null;

    const pickIp = (h: any): string | null => {
      const conns: any[] = Array.isArray(h?.l3connectivities) ? h.l3connectivities : [];
      const v4 = conns.find((c) => c?.af === "ipv4" && c.active) ?? conns.find((c) => c?.af === "ipv4");
      return v4 ? v4.addr : null;
    };
    const macOf = (h: any): string | null => h?.l2ident?.id ?? null;
    const nameOf = (h: any): string | null => h?.primary_name ?? h?.default_name ?? null;
    const vendorOf = (h: any): string | null => h?.vendor_name ?? null;

    const matches = (h: any): boolean => {
      if (o.active_only && !h.active) return false;
      if (!needle) return true;
      const hay = [nameOf(h), macOf(h), pickIp(h), vendorOf(h), h?.host_type]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.indexOf(needle) !== -1;
    };

    const filtered = hosts.filter(matches);

    if (o.count_only) {
      return { total: hosts.length, filtered: filtered.length };
    }

    const paged = limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
    const result = compact
      ? paged.map((h) => ({
          name: nameOf(h),
          mac: macOf(h),
          ip: pickIp(h),
          type: h?.host_type,
          active: !!h?.active,
          reachable: !!h?.reachable,
          vendor: vendorOf(h),
          last_activity: h?.last_activity,
        }))
      : paged;

    return {
      total: hosts.length,
      filtered: filtered.length,
      returned: result.length,
      offset,
      limit,
      hosts: result,
    };
  }

  async getWifiConfig() {
    await this.ensureSession();
    return this.request("GET", "/wifi/config/");
  }

  async setWifiEnabled(enabled: boolean) {
    await this.ensureSession();
    return this.request("PUT", "/wifi/config/", { enabled });
  }

  async getWifiBSS() {
    await this.ensureSession();
    return this.request("GET", "/wifi/bss/");
  }

  async getDownloads() {
    await this.ensureSession();
    return this.request("GET", "/downloads/");
  }

  async addDownload(downloadUrl: string) {
    await this.ensureSession();
    // encode en base64 (format attendu par l'API)
    const download_url_list = Buffer.from(downloadUrl).toString("base64");
    return this.request("POST", "/downloads/add/", { download_url_list });
  }

  async deleteDownload(id: number) {
    await this.ensureSession();
    return this.request("DELETE", `/downloads/${id}/`);
  }

  async updateDownload(id: number, status: "stopped" | "downloading") {
    await this.ensureSession();
    return this.request("PUT", `/downloads/${id}/`, { status });
  }

  async getCallLog() {
    await this.ensureSession();
    return this.request("GET", "/call/log/");
  }

  async markCallRead(id: number) {
    await this.ensureSession();
    return this.request("PUT", `/call/log/${id}/`, { is_new: false });
  }

  async getContacts() {
    await this.ensureSession();
    return this.request("GET", "/contact/");
  }

  async listFiles(path: string) {
    await this.ensureSession();
    const encoded = encodeURIComponent(Buffer.from(path).toString("base64"));
    return this.request("GET", `/fs/ls/${encoded}`);
  }

  async getDHCPConfig() {
    await this.ensureSession();
    return this.request("GET", "/dhcp/config/");
  }

  async getDHCPLeases() {
    await this.ensureSession();
    return this.request("GET", "/dhcp/leases/");
  }

  async getPortForwarding() {
    await this.ensureSession();
    return this.request("GET", "/fw/redir/");
  }

  async addPortForwarding(rule: {
    lan_port: number;
    wan_port_start: number;
    wan_port_end: number;
    lan_ip: string;
    ip_proto: "tcp" | "udp";
    enabled: boolean;
    comment: string;
  }) {
    await this.ensureSession();
    return this.request("POST", "/fw/redir/", rule);
  }

  async deletePortForwarding(id: number) {
    await this.ensureSession();
    return this.request("DELETE", `/fw/redir/${id}/`);
  }

  async getParentalConfig() {
    await this.ensureSession();
    return this.request("GET", "/parental/config/");
  }

  async getParentalFilters() {
    await this.ensureSession();
    return this.request("GET", "/parental/filter/");
  }

  async getVMs() {
    await this.ensureSession();
    return this.request("GET", "/vm/");
  }

  async startVM(id: number) {
    await this.ensureSession();
    return this.request("POST", `/vm/${id}/start/`, {});
  }

  async stopVM(id: number) {
    await this.ensureSession();
    return this.request("POST", `/vm/${id}/stop/`, {});
  }

  async getStorageDisks() {
    await this.ensureSession();
    return this.request("GET", "/storage/disk/");
  }

  async getFreeplug() {
    await this.ensureSession();
    return this.request("GET", "/freeplug/");
  }

  async wakeOnLan(mac: string, password?: string) {
    await this.ensureSession();
    const body: Record<string, string> = { mac };
    if (password) body.password = password;
    return this.request("POST", "/lan/wol/pub/", body);
  }

  async getRRDStats(db: string, fields: string[], date_start?: number, date_end?: number, precision?: number) {
    await this.ensureSession();
    return this.request("POST", "/rrd/", {
      db,
      fields,
      ...(date_start && { date_start }),
      ...(date_end && { date_end }),
      ...(precision && { precision }),
    });
  }

  isAuthorized(): boolean {
    return !!this.appToken;
  }
}
