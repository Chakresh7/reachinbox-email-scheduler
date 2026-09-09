import { Router } from "express";
import { requireIdentity } from "../../middleware/requireAuth";
import * as controller from "./slack.controller";

export const slackRouter = Router();

slackRouter.get("/callback", (req, res, next) => {
  void controller.callback(req, res).catch(next);
});

slackRouter.use(requireIdentity);

slackRouter.get("/install", (req, res, next) => {
  void controller.install(req, res).catch(next);
});
slackRouter.get("/status", (req, res, next) => {
  void controller.status(req, res).catch(next);
});
slackRouter.post("/disconnect", (req, res, next) => {
  void controller.disconnect(req, res).catch(next);
});
slackRouter.post("/test", (req, res, next) => {
  void controller.test(req, res).catch(next);
});
