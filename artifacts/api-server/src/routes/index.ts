import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mulapayRouter from "./mulapay";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mulapayRouter);

export default router;
