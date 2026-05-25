import { Router, type IRouter, type Request, type Response } from "express";
import healthRouter from "./health";
import castleTvRouter from "./castle-tv";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/castle-tv", castleTvRouter);

router.get("/", (_req: Request, res: Response) => {
  res.redirect("/api/castle-tv/manifest.json");
});

export default router;
