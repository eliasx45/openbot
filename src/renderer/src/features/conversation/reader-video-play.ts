/**
 * Fork (docs/fork/FEATURES.md #120, #121). A video or audio file that the reader starts in the chat means
 * the reader is watching or listening there: the chat stops following the latest message, so new output
 * from a working agent no longer scrolls it away (and the virtual list no longer drops its row, which
 * stopped the playback). `play` does not bubble, so the chat listens in the capture phase.
 */
export function watchReaderMediaPlay(element: HTMLElement, onPlay: (media: HTMLMediaElement) => void): () => void {
  const listener = (event: Event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement && element.contains(media) && readerStartedMedia(media)) onPlay(media);
  };
  element.addEventListener("play", listener, true);
  return () => element.removeEventListener("play", listener, true);
}

/**
 * Fork #121: a play that the reader started. A click or key just before it (the page's user activation)
 * counts, and so does media with sound: the chat starts sound only when the reader asks for it, also
 * when a video plays once its file has loaded after the reader's click. A muted video that plays with no
 * reader input (a looping, autoplaying clip like a GIF, or a script's `play()`) does not hold the chat.
 */
export function readerStartedMedia(media: HTMLMediaElement): boolean {
  if (navigator.userActivation?.isActive) return true;
  return !media.muted && media.volume > 0;
}
