import { campaignExpandQueue } from "./campaignExpand.queue";
import { emailSendQueue } from "./emailSend.queue";
import { notificationsQueue } from "./notifications.queue";
import { searchIndexQueue } from "./searchIndex.queue";

/** Close producer Queue instances before disconnecting the shared Redis client. */
export async function closeProducerQueues(): Promise<void> {
  await Promise.allSettled([
    emailSendQueue.close(),
    campaignExpandQueue.close(),
    searchIndexQueue.close(),
    notificationsQueue.close(),
  ]);
}
