import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { env } from "../../config/env";
import { requireIdentity } from "../../middleware/requireAuth";
import * as controller from "./campaigns.controller";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_CSV_BYTES, files: 1 },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

export const campaignsRouter = Router();

campaignsRouter.use(requireIdentity);

campaignsRouter.post("/preview-csv", writeLimiter, upload.single("file"), (req, res, next) => {
  void controller.previewCsv(req, res).catch(next);
});
campaignsRouter.post("/", writeLimiter, upload.single("file"), (req, res, next) => {
  void controller.create(req, res).catch(next);
});
campaignsRouter.get("/", (req, res, next) => {
  void controller.list(req, res).catch(next);
});
campaignsRouter.get("/:id", (req, res, next) => {
  void controller.getById(req, res).catch(next);
});
campaignsRouter.post("/:id/cancel", (req, res, next) => {
  void controller.cancel(req, res).catch(next);
});
