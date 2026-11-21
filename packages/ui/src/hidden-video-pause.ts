/**
 * Fork (docs/fork/FEATURES.md #75, "Hidden video pause"). A playing video pauses once its chat is no
 * longer shown: the chat was left, closed or covered, or its card collapsed. Before, a card clip that
 * loops with sound went on playing in a chat that was no longer shown (Elias, 12 Nov 2026: "when we
 * go outside the chat, a video that's playing needs to stop").
 *
 * A video that is only scrolled out of its chat keeps playing (Elias, 21 Nov 2026: "why does playing
 * on the mac pause automatically"). A chat follows its latest message, so a new reply scrolled a large
 * player away and stopped it while he watched.
 *
 * One listener for the whole document: a `play` event starts watching that video, `pause` and
 * `ended` stop it. A video in picture in picture or full screen keeps playing.
 */

/** How often a video that is scrolled away is checked, in case its chat is then left or covered. */
const AWAY_CHECK_MS = 500;

export function installHiddenVideoPause(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view || typeof view.IntersectionObserver !== "function") return () => undefined;

  const shownElsewhere = (video: HTMLVideoElement) =>
    doc.pictureInPictureElement === video || doc.fullscreenElement === video;
  // False when the chat is hidden (display none), covered (visibility hidden, content-visibility
  // hidden) or removed. A video that is rendered but outside the scroll area stays true.
  const rendered = (video: HTMLVideoElement) =>
    video.isConnected &&
    (typeof video.checkVisibility !== "function" || video.checkVisibility({ visibilityProperty: true }));

  // Playing videos that are scrolled away. The observer reports no new change when their chat is then
  // left or covered, so a timer checks them while there are any.
  const away = new Set<HTMLVideoElement>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer === undefined || away.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
  const checkAway = () => {
    for (const video of [...away]) {
      if (video.paused) away.delete(video);
      else if (!shownElsewhere(video) && !rendered(video)) {
        away.delete(video);
        video.pause();
      }
    }
    stopTimer();
  };

  const observer = new view.IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (!(video instanceof view.HTMLVideoElement)) continue;
      if (entry.isIntersecting) {
        away.delete(video);
        continue;
      }
      if (video.paused || shownElsewhere(video)) continue;
      if (!rendered(video)) {
        video.pause();
        continue;
      }
      away.add(video);
      timer ??= setInterval(checkAway, AWAY_CHECK_MS);
    }
    stopTimer();
  });

  const onPlay = (event: Event) => {
    if (event.target instanceof view.HTMLVideoElement) observer.observe(event.target);
  };
  const onStop = (event: Event) => {
    if (!(event.target instanceof view.HTMLVideoElement)) return;
    observer.unobserve(event.target);
    away.delete(event.target);
    stopTimer();
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
    away.clear();
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
}
