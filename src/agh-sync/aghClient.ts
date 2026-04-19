import type {
  AghClient,
  AghClientDelete,
  AghClientUpdate,
  AghClientsResponse,
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
}
