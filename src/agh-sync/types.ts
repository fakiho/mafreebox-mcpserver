export interface AghClient {
  name: string;
  ids: string[];
  tags?: string[];
  blocked_services?: string[];
  filtering_enabled?: boolean;
  parental_enabled?: boolean;
  safebrowsing_enabled?: boolean;
  use_global_settings?: boolean;
  use_global_blocked_services?: boolean;
  upstreams?: string[];
  ignore_querylog?: boolean;
  ignore_statistics?: boolean;
}

export interface AghClientAuto {
  ip: string;
  name?: string;
  source?: string;
  whois_info?: Record<string, unknown>;
}

export interface AghClientsResponse {
  clients: AghClient[];
  auto_clients: AghClientAuto[];
  supported_tags?: string[];
}

export interface AghClientUpdate {
  name: string;
  data: AghClient;
}

export interface AghClientDelete {
  name: string;
}

export interface FreeboxL3Connectivity {
  af: "ipv4" | "ipv6";
  addr: string;
  active: boolean;
}

export interface FreeboxRawHost {
  primary_name?: string | null;
  default_name?: string | null;
  host_type?: string;
  vendor_name?: string | null;
  active?: boolean;
  reachable?: boolean;
  first_activity?: number;
  last_activity?: number;
  l2ident?: { id?: string; type?: string };
  l3connectivities?: FreeboxL3Connectivity[];
}

export interface FreeboxLanHostsResponse {
  total: number;
  filtered: number;
  returned: number;
  offset: number;
  limit: number;
  hosts: FreeboxRawHost[];
}

export interface SyncStateEntry {
  mac: string;
  aghName: string;
  lastSeen: number;
}

export type SyncState = Record<string, SyncStateEntry>;

export interface AghFilterList {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  rules_count: number;
  last_updated?: string;
}

export interface AghFilteringStatus {
  enabled: boolean;
  interval: number;
  filters: AghFilterList[] | null;
  whitelist_filters: AghFilterList[] | null;
  user_rules: string[];
}

export interface AghStats {
  time_units?: string;
  num_dns_queries?: number;
  num_blocked_filtering?: number;
  top_clients?: Array<Record<string, number>>;
}

export interface SuspectedBypasser {
  mac: string;
  aghName: string | null;
  lastActiveFreebox: number;
  ips: string[];
}
