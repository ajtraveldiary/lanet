import { test, expect } from "@playwright/test";
import { device, join, pair, sendText, startRoom, typePin } from "./helpers";

test("a device joins with the PIN; a wrong PIN counts down", async ({ browser }) => {
  const host = await device(browser);
  const guest = await device(browser);
  const room = await startRoom(host);
  await expect(host.getByLabel(/^PIN /)).toBeVisible();

  await guest.goto(`/#${room.id}`);
  await typePin(guest, room.pin === "000000" ? "111111" : "000000");
  await expect(guest.getByText("That PIN is wrong. 9 tries left.")).toBeVisible();
  await expect(host.getByText(/typed a wrong PIN/)).toBeVisible();

  await typePin(guest, room.pin);
  await expect(guest.getByText("Connected directly").first()).toBeVisible();
  await expect(host.getByText("Devices (1)")).toBeVisible();
});

test("a device that reloads comes back as itself, with its messages", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await sendText(host, "hello before the reload");
  await expect(guest.getByText("hello before the reload")).toBeVisible();

  await guest.reload();
  await expect(guest.getByText("Connected directly").first()).toBeVisible();
  await expect(host.getByText("Devices (1)")).toBeVisible();
  await expect(host.getByText("hello before the reload")).toBeVisible();
  await expect(host.getByText(/\(2\)/)).toHaveCount(0);
});

test("closing the room tells the other device", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await host.getByRole("button", { name: "Close room" }).click();
  await expect(guest.getByRole("heading", { name: "Room closed" })).toBeVisible();
  await expect(guest.getByText("The main device closed the room.")).toBeVisible();
  await expect(host.getByRole("button", { name: "Start sharing" })).toBeVisible();
});

test("an unknown room and a cut-off link get plain messages", async ({ browser }) => {
  const page = await device(browser);
  await page.goto("/#AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByText("This room has closed. Ask for a new link.")).toBeVisible();
  await page.goto("/#tooShort");
  await expect(page.getByRole("heading", { name: "This link isn't complete" })).toBeVisible();
});

test("the room server: a fake main device is refused; 10 wrong PINs lock it; a device let in can still return", async ({ browser }) => {
  const host = await device(browser);
  const room = await startRoom(host);
  const result = await host.evaluate(async ({ id, pin }) => {
    const open = () => new WebSocket(`ws://${location.host}/api/room/${id}/ws`);
    const talk = (msgs: object[], wait = 1500) => new Promise<{ code?: number; got: Record<string, unknown>[] }>((done) => {
      const ws = open();
      const got: Record<string, unknown>[] = [];
      ws.onopen = () => msgs.forEach((m, i) => setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(m)), i * 150));
      ws.onmessage = (e) => got.push(JSON.parse(e.data));
      ws.onclose = (e) => done({ code: e.code, got });
      setTimeout(() => { done({ got }); ws.close(); }, wait + msgs.length * 150);
    });
    const fake = await talk([{ type: "host", token: "not-the-token" }]);
    const ok = await talk([{ type: "join", pin, name: "Test", key: "testkey123" }]);
    const pass = ok.got.find((m) => m.type === "admitted")?.pass as string;
    const wrong = pin === "000000" ? "111111" : "000000";
    const tries = await talk(Array.from({ length: 10 }, () => ({ type: "join", pin: wrong, name: "Guesser" })), 2500);
    const newcomer = await talk([{ type: "join", pin, name: "New" }]);
    const back = await talk([{ type: "join", pin, pass, name: "Test", key: "testkey123" }]);
    return { fake: fake.code, admitted: !!pass, triesCode: tries.code, left: tries.got.map((m) => m.left), newcomer: newcomer.code, back: back.got.map((m) => m.type) };
  }, room);
  expect(result.fake).toBe(4401);
  expect(result.admitted).toBe(true);
  expect(result.left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(result.triesCode).toBe(4429);
  expect(result.newcomer).toBe(4429);
  expect(result.back).toContain("admitted");
  await expect(host.getByText(/10 wrong PINs were typed/)).toBeVisible();
});
