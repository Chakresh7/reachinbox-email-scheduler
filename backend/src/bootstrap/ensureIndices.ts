import { env } from "../config/env";
import { esClient, isSearchConfigured } from "../lib/elasticsearch";
import { errorMessage } from "../lib/errors";
import { childLogger } from "../lib/logger";
import {
  EMAILS_PHYSICAL_INDEX_SUFFIX,
  emailsIndexMappings,
  emailsIndexSettings,
} from "../modules/search/index.mapping";

const log = childLogger("ensure-indices");

async function existsIndex(name: string): Promise<boolean> {
  if (!esClient) return false;
  try {
    return Boolean(await esClient.indices.exists({ index: name }));
  } catch {
    return false;
  }
}

async function existsAlias(name: string): Promise<boolean> {
  if (!esClient) return false;
  try {
    return Boolean(await esClient.indices.existsAlias({ name }));
  } catch {
    return false;
  }
}

async function createPhysicalIndex(index: string): Promise<void> {
  if (!esClient) return;
  try {
    await esClient.indices.create({
      index,
      settings: emailsIndexSettings,
      mappings: emailsIndexMappings,
    });
  } catch (err) {
    const message = errorMessage(err);
    // Elastic Cloud serverless rejects shard/replica settings.
    if (!/serverless|number_of_shards|number_of_replicas/i.test(message)) {
      throw err;
    }
    await esClient.indices.create({
      index,
      mappings: emailsIndexMappings,
    });
    log.info({ index }, "created emails index without shard settings (serverless)");
  }
}

/**
 * Creates the emails mapping. Writes go to alias `emails` (or a pre-existing
 * concrete index of that name on Elastic Cloud). Never deletes an index.
 */
export async function ensureIndices(): Promise<void> {
  if (!isSearchConfigured || !esClient) return;

  const alias = env.ELASTICSEARCH_INDEX;
  const physical = `${alias}${EMAILS_PHYSICAL_INDEX_SUFFIX}`;
  const aliasPresent = await existsAlias(alias);
  const concretePresent = await existsIndex(alias);

  if (concretePresent && !aliasPresent) {
    log.info({ index: alias }, "emails exists as a concrete index; leaving it in place");
    return;
  }

  if (!(await existsIndex(physical))) {
    await createPhysicalIndex(physical);
    log.info({ index: physical }, "created emails physical index");
  }

  if (!aliasPresent) {
    await esClient.indices.putAlias({ index: physical, name: alias });
    log.info({ alias, index: physical }, "pointed emails alias at physical index");
  }
}
