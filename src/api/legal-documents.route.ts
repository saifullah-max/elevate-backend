import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  getLegalDocumentHandler,
  listLegalDocumentsHandler,
  updateLegalDocumentHandler,
} from "../controllers/legal-documents.controller";

const router = Router();

router.get("/", listLegalDocumentsHandler);
router.get("/:slug", getLegalDocumentHandler);
router.put("/:slug", requireAuth, updateLegalDocumentHandler);

export default router;
