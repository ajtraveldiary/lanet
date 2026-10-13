// Turning what the person picked or dropped into a list of files with their place inside a folder.
import { isIOS } from "./files";

export type Picked = { file: File; path: string };

// A file picked on its own has just its name; one from a picked folder keeps "Folder/inner/name".
export function fromInput(list: FileList | null): Picked[] {
  return [...(list ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

// iPhones and iPads can't pick a folder; elsewhere the folder picker comes with the file input.
export const canPickFolder = () => !isIOS() && "webkitdirectory" in HTMLInputElement.prototype;

// Must be called inside the drop event: the dropped items are only readable until it returns.
// The folders inside are walked afterwards.
export function fromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Promise.resolve(fromInput(dt.files));
  return (async () => {
    const out: Picked[] = [];
    for (const e of entries) await walk(e, "", out);
    return out;
  })();
}

async function walk(entry: FileSystemEntry, prefix: string, out: Picked[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands out a folder's contents a batch at a time, until an empty batch.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const e of batch) await walk(e, prefix + entry.name + "/", out);
    }
  }
}
