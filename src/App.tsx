import { useEffect, useState } from "react";
import { Shell, Card, Button } from "./ui";
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
        <Card title="This link isn't complete">
          <p className="mb-4 text-muted">Part of the room link is missing. Open the whole link again, or scan the QR code on the main device.</p>
          <Button onClick={() => { location.hash = ""; }}>Go to the start page</Button>
        </Card>
      )}
    </Shell>
  );
}
