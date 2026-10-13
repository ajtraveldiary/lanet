// The name other devices in the room see, like "Android phone · Chrome". A guess from the browser.
export function deviceName(): string {
  const ua = navigator.userAgent;
  // iPads ask for the desktop site and say "Macintosh"; touch gives them away.
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os =
    /iPhone/.test(ua) ? "iPhone" :
    /iPad/.test(ua) || touchMac ? "iPad" :
    /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet") :
    /Windows/.test(ua) ? "Windows PC" :
    /Macintosh/.test(ua) ? "Mac" :
    /CrOS/.test(ua) ? "Chromebook" :
    /Linux/.test(ua) ? "Linux PC" : "Device";
  const browser =
    /Edg(A|iOS)?\//.test(ua) ? "Edge" :
    /SamsungBrowser/.test(ua) ? "Samsung Internet" :
    /OPR\//.test(ua) ? "Opera" :
    /Firefox|FxiOS/.test(ua) ? "Firefox" :
    /Chrome|CriOS/.test(ua) ? "Chrome" :
    /Safari/.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}
