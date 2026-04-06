import { Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return null;
}

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

export async function handleReplicateWebhook(req: Request, res: Response): Promise<void> {
  try {
    const configuredToken = String(process.env.REPLICATE_WEBHOOK_AUTH_TOKEN || "").trim();
    if (configuredToken) {
      const incomingToken = String(req.query.token || "").trim();
      if (!incomingToken || incomingToken !== configuredToken) {
        res.status(401).json({ success: false, error: "Invalid webhook token" });
        return;
      }
    }

    const body = req.body || {};
    const predictionId = asString(body?.id) || "unknown";
    const status = asString(body?.status) || "unknown";
    const model = asString(body?.model) || null;
    const webhookEvent = asString(req.headers["webhook-event"]) || "unknown";

    const logPayload = {
      receivedAt: new Date().toISOString(),
      webhookEvent,
      predictionId,
      status,
      model,
      inputPromptPreview: clip(asString(body?.input?.prompt) || "", 260),
      outputCount: Array.isArray(body?.output) ? body.output.length : body?.output ? 1 : 0,
      logsPreview: clip(asString(body?.logs) || "", 700),
      metrics: body?.metrics || null,
      error: body?.error || null,
    };

    const logsDir = path.join(process.cwd(), "logs", "replicate-webhooks");
    await fs.promises.mkdir(logsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const filePath = path.join(logsDir, `replicate-webhooks-${day}.ndjson`);
    await fs.promises.appendFile(filePath, `${JSON.stringify(logPayload)}\n`, "utf8");

    logger(
      `[REPLICATE_WEBHOOK] event=${webhookEvent} predictionId=${predictionId} status=${status} outputCount=${logPayload.outputCount}`
    );

    res.status(200).json({ success: true, predictionId, status });
  } catch (error) {
    logger(`[REPLICATE_WEBHOOK] handler error: ${String(error)}`);
    res.status(500).json({ success: false, error: "Webhook handler failed" });
  }
}
