// Parts of the File System Access API that TypeScript's DOM types don't include yet (Chrome and Edge have them).

type FsPermission = "granted" | "denied" | "prompt";

interface FileSystemHandle {
  queryPermission?(o: { mode: "read" | "readwrite" }): Promise<FsPermission>;
  requestPermission?(o: { mode: "read" | "readwrite" }): Promise<FsPermission>;
}

interface Window {
  showDirectoryPicker?(o?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }): Promise<FileSystemDirectoryHandle>;
}
