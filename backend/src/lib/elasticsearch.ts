import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env";
import { childLogger } from "./logger";

/**
 * Elasticsearch client.
 *
 * Search is an accelerator, never a source of truth (DESIGN.md §12). The client
 * is therefore nullable by design: if `SEARCH_ENABLED=false` or no URL is
 * configured, the app runs and `/api/search` falls back to a Postgres query.
 * Nothing on the sending path may ever depend on this being reachable.
 *
 * Auth supports either an API key (Elastic Cloud) or basic credentials (a local
 * container with security enabled).
 */

const log = childLogger("elasticsearch");

function createClient(): Client | null {
  if (!env.SEARCH_ENABLED) {
    log.info("search disabled (SEARCH_ENABLED=false); Postgres fallback will be used");
    return null;
  }
  if (!env.ELASTICSEARCH_URL) {
    log.warn("SEARCH_ENABLED=true but ELASTICSEARCH_URL is unset; Postgres fallback will be used");
    return null;
  }

  const auth = env.ELASTICSEARCH_API_KEY
    ? { apiKey: env.ELASTICSEARCH_API_KEY }
    : env.ELASTICSEARCH_USERNAME && env.ELASTICSEARCH_PASSWORD
      ? { username: env.ELASTICSEARCH_USERNAME, password: env.ELASTICSEARCH_PASSWORD }
      : undefined;

  return new Client({
    node: env.ELASTICSEARCH_URL,
    ...(auth ? { auth } : {}),
    // Bounded so a slow cluster degrades search instead of stalling requests.
    requestTimeout: 10_000,
    pingTimeout: 3000,
    maxRetries: 2,
  });
}

export const esClient: Client | null = createClient();

/** True when a client exists. Says nothing about the cluster being reachable. */
export const isSearchConfigured = esClient !== null;

/** Round-trip ping used by /readyz. Returns latency in milliseconds. */
export async function pingElasticsearch(): Promise<number> {
  if (!esClient) throw new Error("Elasticsearch is not configured");
  const startedAt = process.hrtime.bigint();
  await esClient.ping();
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export interface ElasticsearchInfo {
  clusterName: string;
  version: string;
}

export async function getElasticsearchInfo(): Promise<ElasticsearchInfo> {
  if (!esClient) throw new Error("Elasticsearch is not configured");
  const info = await esClient.info();
  return {
    clusterName: info.cluster_name,
    version: info.version.number,
  };
}

export async function disconnectElasticsearch(): Promise<void> {
  if (!esClient) return;
  await esClient.close();
  log.info("elasticsearch client closed");
}
