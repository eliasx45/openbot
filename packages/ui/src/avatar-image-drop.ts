import { createSignal } from "solid-js";

/**
 * Lets a person drop an image file on an avatar editor: the face in settings or the image button of
 * its editor. The handlers stop the drop there, so the window listener of the desktop preload does
 * not take the file as a chat attachment, and the chat's drop overlay does not open.
 */
export function createAvatarImageDrop(onFile: (file: File) => void) {
  const [active, setActive] = createSignal(false);

  function hasFiles(event: DragEvent): boolean {
    return Boolean(event.dataTransfer?.types.includes("Files"));
  }

  function hold(event: DragEvent): boolean {
    if (!hasFiles(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setActive(true);
    return true;
  }

  return {
    active,
    onDragEnter: (event: DragEvent) => void hold(event),
    onDragOver: (event: DragEvent) => void hold(event),
    onDragLeave: (event: DragEvent & { currentTarget: Element }) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setActive(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setActive(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      const file = files.find((candidate) => candidate.type.startsWith("image/")) ?? files[0];
      if (file) onFile(file);
    },
  };
}
