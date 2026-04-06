// Conservative default for Render free tier while improving throughput.
// Can be overridden via IMAGE_QUEUE_CONCURRENCY.
const parsedConcurrency = Number(process.env.IMAGE_QUEUE_CONCURRENCY || "3");
export const QUEUE_CONCURRENCY = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
	? parsedConcurrency
	: 3;
export const BATCH_PROCESSING_ENABLED = process.env.ENABLE_BATCH_PROCESSING !== 'false'; // Split large uploads into 2 batches
