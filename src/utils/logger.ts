// Example utility function
export function logger(message: string) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${timestamp}] ${message}`);
}
