import { useEffect, useState } from "react";
import { Shell, Card, Button, IconTile } from "./ui";
import { HostPage } from "./host/HostPage";
import { GuestPage } from "./guest/GuestPage";
import { ROOM_ID } from "./lib/room";

// The room id rides in the #part of the link, which browsers never send to the server.
export default function App() {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const onHash = () => setHash(location.hash.slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <Shell>
      {!hash ? <HostPage /> : ROOM_ID.test(hash) ? <GuestPage key={hash} roomId={hash} /> : (
        <div className="mx-auto w-full max-w-md pt-2 sm:pt-10">
          <Card>
            <div className="flex flex-col items-start gap-3">
              <IconTile name="link" tone="bg-warn-soft text-on-warn" size="size-12" />
              <h1 className="text-xl font-bold">This link isn't complete</h1>
              <p className="text-muted">Part of the room link is missing. Open the whole link again, or scan the QR code on the main device.</p>
              <Button icon="arrow" onClick={() => { location.hash = ""; }}>Go to the start page</Button>
            </div>
          </Card>
        </div>
      )}
    </Shell>
  );
}
