const parsedConcurrency = Number(process.env.IMAGE_QUEUE_CONCURRENCY || "6");
export const QUEUE_CONCURRENCY = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
	? parsedConcurrency
	: 6;
