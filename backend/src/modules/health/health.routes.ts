import { Router } from "express";
import { getLiveness, getReadiness } from "./health.service";

export const healthRouter: Router = Router();

/**
 * Liveness. "Is this process alive?" — no dependency calls, so a database
 * outage never causes an orchestrator to kill an otherwise healthy container.
 */
healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json(getLiveness());
});

/**
 * Readiness. "Can this process serve traffic?" — probes every dependency and
 * returns 503 when a critical one is down, so it can be used as a load-balancer
 * check. Elasticsearch being down yields 200 with `status: "degraded"`, because
 * search degrades to Postgres rather than breaking the app.
 */
healthRouter.get("/readyz", async (_req, res) => {
  const report = await getReadiness();
  res.status(report.status === "unavailable" ? 503 : 200).json(report);
});
