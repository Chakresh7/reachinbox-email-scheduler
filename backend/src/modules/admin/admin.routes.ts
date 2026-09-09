import { Router } from "express";
import { reconcileEmailJobs } from "../../bootstrap/reconcile";
import { requireAdmin } from "../../middleware/requireAuth";
import { reindexAllEmailJobs } from "../search/reindex";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.post("/reconcile", (_req, res, next) => {
  void reconcileEmailJobs()
    .then((data) => res.json({ data }))
    .catch(next);
});

adminRouter.post("/reindex", (_req, res, next) => {
  void reindexAllEmailJobs()
    .then((data) => res.json({ data }))
    .catch(next);
});
