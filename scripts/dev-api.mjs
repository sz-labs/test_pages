import http from "node:http";
import { Readable } from "node:stream";
import { createApp } from "../service/app.js";
const handler = createApp();
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://127.0.0.1:8000${incoming.url}`, {
      method: incoming.method, headers: incoming.headers,
      ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }),
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end("API request failed"); }
});
server.listen(8000, "127.0.0.1", () => console.log("JavaScript API: http://127.0.0.1:8000/api/health"));
