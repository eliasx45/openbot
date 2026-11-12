/**
 * Fork (docs/fork/FEATURES.md #75, "Hidden video pause"). A playing video pauses once no part of
 * it is on screen: its chat was left or closed, its card collapsed, or it was scrolled away.
 * Before, a card clip that loops with sound went on playing in a chat that was no longer shown
 * (Elias, 12 Nov 2026: "when we go outside the chat, a video that's playing needs to stop").
 *
 * One listener for the whole document: a `play` event starts watching that video, `pause` and
 * `ended` stop it. A video in picture in picture or full screen keeps playing.
 */
export function installHiddenVideoPause(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view || typeof view.IntersectionObserver !== "function") return () => undefined;

  const shownElsewhere = (video: HTMLVideoElement) =>
    doc.pictureInPictureElement === video || doc.fullscreenElement === video;

  const observer = new view.IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (!(video instanceof view.HTMLVideoElement)) continue;
      if (entry.isIntersecting || video.paused || shownElsewhere(video)) continue;
      video.pause();
    }
  });

  const onPlay = (event: Event) => {
    if (event.target instanceof view.HTMLVideoElement) observer.observe(event.target);
  };
  const onStop = (event: Event) => {
    if (event.target instanceof view.HTMLVideoElement) observer.unobserve(event.target);
  };

  // Media events do not bubble, so the listeners capture.
  doc.addEventListener("play", onPlay, true);
  doc.addEventListener("pause", onStop, true);
  doc.addEventListener("ended", onStop, true);
  return () => {
    doc.removeEventListener("play", onPlay, true);
    doc.removeEventListener("pause", onStop, true);
    doc.removeEventListener("ended", onStop, true);
    observer.disconnect();
  };
}
