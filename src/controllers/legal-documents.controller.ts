import { Request, Response } from "express";
import {
  getLegalDocumentBySlug,
  listLegalDocuments,
  updateLegalDocument,
} from "../services/legal-documents.service";

function isAdmin(req: Request) {
  const roles = Array.isArray(req.user?.role)
    ? req.user?.role
    : req.user?.role
      ? [req.user.role]
      : [];

  return roles.includes("ADMIN");
}

export async function listLegalDocumentsHandler(_req: Request, res: Response) {
  try {
    const documents = await listLegalDocuments();
    return res.status(200).json({ success: true, data: documents });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to load legal documents" });
  }
}

export async function getLegalDocumentHandler(req: Request, res: Response) {
  try {
    const { slug } = req.params;
    const document = await getLegalDocumentBySlug(slug);

    if (!document) {
      return res.status(404).json({ success: false, message: "Legal document not found" });
    }

    return res.status(200).json({ success: true, data: document });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || "Failed to load legal document" });
  }
}

export async function updateLegalDocumentHandler(req: Request, res: Response) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }

    const { slug } = req.params;
    const { title, description, contentHtml } = req.body as {
      title?: string;
      description?: string;
      contentHtml?: string;
    };

    const updatedDocument = await updateLegalDocument(slug, { title, description, contentHtml }, req.user?.email || null);
    return res.status(200).json({ success: true, data: updatedDocument });
  } catch (error: any) {
    const statusCode = error.message === "Legal document not found" ? 404 : 400;
    return res.status(statusCode).json({ success: false, message: error.message || "Failed to update legal document" });
  }
}
