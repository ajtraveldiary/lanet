import { useMemo } from "react";
import { encode } from "uqr";

// Always black on white, also in dark mode: some phone cameras can't read a light-on-dark code.
export function Qr({ text, label }: { text: string; label: string }) {
  const { path, size } = useMemo(() => {
    const { data, size } = encode(text, { ecc: "M", border: 2 });
    let path = "";
    data.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x} ${y}h1v1h-1z`; }));
    return { path, size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className="block h-auto w-full rounded-xl bg-white">
      <path d={path} fill="#000" />
    </svg>
  );
}
