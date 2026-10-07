/** Stop waiting on caller cancellation, consuming any late settlement safely. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
