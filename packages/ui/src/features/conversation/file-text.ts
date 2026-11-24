function byteOrderEncoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | "utf-8" {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return "utf-8";
}

export function decodedFileText(bytes: Uint8Array): string {
  return new TextDecoder(byteOrderEncoding(bytes)).decode(bytes);
}
