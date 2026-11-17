// The dispatcher records bounded metadata once per call; never duplicate raw arguments to disk.
export async function trackToolCall(_toolName: string, _args?: unknown): Promise<void> {}
