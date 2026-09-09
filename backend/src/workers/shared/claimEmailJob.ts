import { prisma } from "../../lib/prisma";

/**
 * Atomic claim: only one worker can move a row out of a pending state.
 * Returns true when this worker owns the send.
 */
export async function claimEmailJob(emailJobId: string): Promise<boolean> {
  const result = await prisma.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: { in: ["scheduled", "rate_limited", "failed"] },
    },
    data: {
      status: "claimed",
      claimedAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });
  return result.count === 1;
}
