type JobHandler<T> = (job: T) => Promise<void>;

export class SimpleQueue<T> {
    private queue: T[] = [];
    private running = 0;
    private completed = 0;
    private failed = 0;

    constructor(
        private concurrency: number,
        private handler: JobHandler<T>
    ) { }

    add(job: T) {
        this.queue.push(job);
        this.runNext();
    }

    getStatus() {
        return {
            queued: this.queue.length,
            running: this.running,
            completed: this.completed,
            failed: this.failed,
            isIdle: this.queue.length === 0 && this.running === 0,
        };
    }

    reset() {
        this.completed = 0;
        this.failed = 0;
    }

    private async runNext() {
        if (this.running >= this.concurrency) return;
        const job = this.queue.shift();
        if (!job) return;

        this.running++;
        try {
            await this.handler(job);
            this.completed++;
        } catch (err) {
            console.error("Queue job failed:", err);
            this.failed++;
        } finally {
            this.running--;
            this.runNext();
        }
    }
}
