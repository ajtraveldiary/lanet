// Simple line icons drawn for Lanet (24 × 24, coloured by the text colour around them).
import type { SVGProps } from "react";

const PATHS = {
  send: ["M21 3 3 10.5l7.5 2.6L13.2 21 21 3Z", "M10.5 13.1 15 8.6"],
  receive: ["M12 4v11", "m7 10.5 5 5 5-5", "M5 20h14"],
  phone: ["M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z", "M11 18.5h2"],
  tablet: ["M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M11 18h2"],
  laptop: ["M6 5h12a1.5 1.5 0 0 1 1.5 1.5V15h-15V6.5A1.5 1.5 0 0 1 6 5Z", "M2.5 18.5h19"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z", "M14 3v5h5"],
  doc: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z", "M14 3v5h5", "M8.5 13h7", "M8.5 16.5h5"],
  image: ["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M9 11a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 9 11Z", "m21 15.5-5-5L5 20"],
  video: ["M5 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z", "m16 10.5 5-3v9l-5-3"],
  audio: ["M9 18V5.5l11-2V16", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  archive: ["M4 4h16a1 1 0 0 1 1 1v3H3V5a1 1 0 0 1 1-1Z", "M4.5 8v11a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8", "M10 12.5h4"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  chevron: ["m9 6 6 6-6 6"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  copy: ["M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z", "M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"],
  share: ["M12 3v12", "m7 8 5-5 5 5", "M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"],
  chat: ["M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9Z"],
  room: ["M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", "M8.5 8.5a5 5 0 0 0 0 7", "M15.5 8.5a5 5 0 0 1 0 7", "M5.6 5.6a9 9 0 0 0 0 12.8", "M18.4 5.6a9 9 0 0 1 0 12.8"],
  pause: ["M9 6v12", "M15 6v12"],
  arrow: ["M5 12h14", "m13 6 6 6-6 6"],
  install: ["M12 3v10", "m8 9 4 4 4-4", "M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"],
  // The iPhone share button: a box with an arrow out of the top.
  iosShare: ["M12 3v12", "m8 7 4-4 4 4", "M8 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"],
  plusSquare: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M12 8v8", "M8 12h8"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-5", ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} {...rest}>
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

// The kind of device, guessed from the name other devices see ("Android phone · Chrome").
export function deviceIcon(name: string): IconName {
  if (/iPad|tablet/i.test(name)) return "tablet";
  if (/PC|Mac|Chromebook/.test(name)) return "laptop";
  return "phone";
}

// The kind of file, for its icon and colour.
export function fileKind(path: string, type = ""): { icon: IconName; tone: string } {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const is = (re: RegExp) => re.test(ext);
  if (type.startsWith("image/") || is(/^(jpe?g|png|gif|webp|heic|heif|bmp|svg|avif|tiff?)$/)) return { icon: "image", tone: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" };
  if (type.startsWith("video/") || is(/^(mp4|mov|mkv|webm|avi|m4v|3gp)$/)) return { icon: "video", tone: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" };
  if (type.startsWith("audio/") || is(/^(mp3|wav|m4a|flac|aac|ogg|opus)$/)) return { icon: "audio", tone: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300" };
  if (is(/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/)) return { icon: "archive", tone: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" };
  if (is(/^pdf$/)) return { icon: "doc", tone: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" };
  if (is(/^(docx?|txt|rtf|odt|xlsx?|csv|ods|pptx?|odp|md)$/)) return { icon: "doc", tone: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" };
  return { icon: "file", tone: "bg-sunken text-muted" };
}
