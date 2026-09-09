import { campaignExpandQueue } from "./campaignExpand.queue";
import { emailSendQueue } from "./emailSend.queue";

/** Close producer Queue instances before disconnecting the shared Redis client. */
export async function closeProducerQueues(): Promise<void> {
  await Promise.allSettled([emailSendQueue.close(), campaignExpandQueue.close()]);
}
