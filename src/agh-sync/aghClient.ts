import type {
  AghClient,
  AghClientDelete,
  AghClientUpdate,
  AghClientsResponse,
  AghFilteringStatus,
  AghQueryLogResponse,
  AghStats,
} from "./types.js";

export interface AghClientConfig {
  baseUrl: string;
  user: string;
  pass: string;
}

export class AdGuardHomeClient {
  private authHeader: string;
  private baseUrl: string;

  constructor(cfg: AghClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.authHeader = "Basic " + Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AGH ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      return (await res.json()) as T;
    }
    return undefined as T;
  }

  listClients(): Promise<AghClientsResponse> {
    return this.call<AghClientsResponse>("GET", "/control/clients");
  }

  addClient(client: AghClient): Promise<void> {
    return this.call<void>("POST", "/control/clients/add", client);
  }

  updateClient(update: AghClientUpdate): Promise<void> {
    return this.call<void>("POST", "/control/clients/update", update);
  }

  deleteClient(del: AghClientDelete): Promise<void> {
    return this.call<void>("POST", "/control/clients/delete", del);
  }

  async ping(): Promise<boolean> {
    try {
      await this.listClients();
      return true;
    } catch {
      return false;
    }
  }

  getStats(): Promise<AghStats> {
    return this.call<AghStats>("GET", "/control/stats");
  }

  getFilteringStatus(): Promise<AghFilteringStatus> {
    return this.call<AghFilteringStatus>("GET", "/control/filtering/status");
  }

  addFilterUrl(payload: { name: string; url: string; whitelist?: boolean }): Promise<void> {
    return this.call<void>("POST", "/control/filtering/add_url", {
      name: payload.name,
      url: payload.url,
      whitelist: payload.whitelist ?? false,
    });
  }

  refreshFilters(whitelist = false): Promise<void> {
    return this.call<void>("POST", "/control/filtering/refresh", { whitelist });
  }

  getQueryLog(opts?: { older_than?: string; limit?: number }): Promise<AghQueryLogResponse> {
    const params = new URLSearchParams();
    if (opts?.older_than) params.set("older_than", opts.older_than);
    params.set("limit", String(opts?.limit ?? 500));
    return this.call<AghQueryLogResponse>("GET", `/control/querylog?${params.toString()}`);
  }
}
