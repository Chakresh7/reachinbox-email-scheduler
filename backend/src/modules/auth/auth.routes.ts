import { Router } from "express";
import { requireIdentity } from "../../middleware/requireAuth";
import * as controller from "./auth.controller";

export const authRouter = Router();

authRouter.get("/features", (req, res, next) => {
  try {
    controller.features(req, res);
  } catch (err) {
    next(err);
  }
});

authRouter.get("/google", (req, res, next) => {
  try {
    controller.startGoogle(req, res);
  } catch (err) {
    next(err);
  }
});

authRouter.get("/google/callback", (req, res, next) => {
  void controller.googleCallback(req, res).catch(next);
});

authRouter.post("/logout", (req, res, next) => {
  try {
    controller.logout(req, res);
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireIdentity, (req, res, next) => {
  void controller.me(req, res).catch(next);
});
