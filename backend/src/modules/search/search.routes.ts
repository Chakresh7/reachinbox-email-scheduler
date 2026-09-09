import { Router } from "express";
import { requireIdentity } from "../../middleware/requireAuth";
import * as controller from "./search.controller";

export const searchRouter = Router();
searchRouter.use(requireIdentity);

searchRouter.get("/", (req, res, next) => {
  void controller.search(req, res).catch(next);
});
