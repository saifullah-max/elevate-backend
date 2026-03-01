type JobHandler<T> = (job: T) => Promise<void>;

export class SimpleQueue<T> {
    private queue: T[] = [];
    private running = 0;

    constructor(
        private concurrency: number,
        private handler: JobHandler<T>
    ) { }

    add(job: T) {
        this.queue.push(job);
        this.runNext();
    }

    private async runNext() {
        if (this.running >= this.concurrency) return;
        const job = this.queue.shift();
        if (!job) return;

        this.running++;
        try {
            await this.handler(job);
        } catch (err) {
            console.error("Queue job failed:", err);
        } finally {
            this.running--;
            this.runNext();
        }
    }
}
