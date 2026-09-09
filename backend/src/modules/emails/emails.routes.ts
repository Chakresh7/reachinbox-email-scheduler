import { Router } from "express";
import { requireIdentity } from "../../middleware/requireAuth";
import * as controller from "./emails.controller";

export const emailsRouter = Router();
emailsRouter.use(requireIdentity);

emailsRouter.get("/scheduled", (req, res, next) => {
  void controller.listScheduled(req, res).catch(next);
});
emailsRouter.get("/sent", (req, res, next) => {
  void controller.listSent(req, res).catch(next);
});
emailsRouter.get("/stats", (req, res, next) => {
  void controller.stats(req, res).catch(next);
});
emailsRouter.get("/:id", (req, res, next) => {
  void controller.getById(req, res).catch(next);
});
