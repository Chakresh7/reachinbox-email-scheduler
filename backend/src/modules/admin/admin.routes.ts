import { Router } from "express";
import { reconcileEmailJobs } from "../../bootstrap/reconcile";
import { requireAdmin } from "../../middleware/requireAuth";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.post("/reconcile", (_req, res, next) => {
  void reconcileEmailJobs()
    .then((data) => res.json({ data }))
    .catch(next);
});
