/**
 * Fork (docs/fork/FEATURES.md #120). A video that the reader starts in the chat means the reader is
 * watching that spot: the chat stops following the latest message, so new output from a working agent
 * no longer scrolls the video away (and the virtual list no longer drops its row, which stopped it).
 * `play` does not bubble, so the chat listens in the capture phase.
 */
export function watchReaderVideoPlay(element: HTMLElement, onPlay: (video: HTMLVideoElement) => void): () => void {
  const listener = (event: Event) => {
    if (event.target instanceof HTMLVideoElement && element.contains(event.target)) onPlay(event.target);
  };
  element.addEventListener("play", listener, true);
  return () => element.removeEventListener("play", listener, true);
}
