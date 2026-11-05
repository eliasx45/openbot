import { open } from "node:fs/promises";
import { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";

const CHUNK_BYTES = 64 * 1_024;

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Reads one `bytes=` range from a Range header. Returns null for no header, a multi-range or a
 * malformed value (the caller then sends the whole file), and "unsatisfiable" for a range past the end.
 */
function parseByteRange(header: string | null | undefined, size: number): ByteRange {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (!first && !last) return null;
  if (!first) {
    // A suffix range: the last N bytes.
    const length = Number(last);
    if (length === 0) return "unsatisfiable";
    return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Streams a file without keeping its whole contents in memory. Open failures still let the caller answer 404.
 * With a Range header it answers 206 with that part: a media element needs this to read an MP4 index that
 * is at the end of the file, and to seek.
 */
export const fileResponse = Effect.fn("FileResponse.open")(function* (
  path: string,
  headers: Record<string, string>,
  rangeHeader?: string | null,
) {
  // The response stream owns the handle after construction. Before that, the operation owns it.
  let transferred = false;
  return yield* Effect.acquireUseRelease(
    remoteCall(() => open(path, "r")),
    (file) =>
      Effect.gen(function* () {
        const close = Effect.fn("FileResponse.close")(() => remoteCall(() => file.close()));
        const stats = yield* remoteCall(() => file.stat());
        if (!stats.isFile()) return yield* new RemoteWorkflowError({ cause: new Error("Not a regular file.") });
        const range = parseByteRange(rangeHeader, stats.size);
        // The release below closes the file, since no stream takes it.
        if (range === "unsatisfiable") {
          return new Response(null, {
            status: 416,
            headers: { ...headers, "Accept-Ranges": "bytes", "Content-Range": `bytes */${stats.size}` },
          });
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? stats.size - 1;
        let position = start;
        const pull = Effect.fn("FileResponse.read")(function* (
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) {
          const wanted = Math.min(CHUNK_BYTES, end - position + 1);
          const chunk = new Uint8Array(Math.max(wanted, 0));
          const { bytesRead } =
            wanted > 0 ? yield* remoteCall(() => file.read(chunk, 0, wanted, position)) : { bytesRead: 0 };
          position += bytesRead;
          if (bytesRead === 0) {
            controller.close();
            yield* close();
            return;
          }
          controller.enqueue(chunk.subarray(0, bytesRead));
        });
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            runCauseEffect(
              pull(controller).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    controller.error(error.cause);
                    yield* close().pipe(Effect.catch(() => Effect.void));
                  }),
                ),
              ),
            ),
          cancel: () => runCauseEffect(close()),
        });
        // Media elements need the length to show a duration.
        const response = range
          ? new Response(body, {
              status: 206,
              headers: {
                ...headers,
                "Accept-Ranges": "bytes",
                "Content-Length": String(end - start + 1),
                "Content-Range": `bytes ${start}-${end}/${stats.size}`,
              },
            })
          : new Response(body, {
              headers: { ...headers, "Accept-Ranges": "bytes", "Content-Length": String(stats.size) },
            });
        transferred = true;
        return response;
      }),
    (file) => (transferred ? Effect.void : remoteCall(() => file.close()).pipe(Effect.catch(() => Effect.void))),
  );
});
