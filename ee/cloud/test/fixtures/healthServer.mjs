// A stand-in for the OwnBase server in the supervisor's tests: answers
// /api/health on the port after --port, and nothing else.
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => {
  res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", pid: process.pid }));
}).listen(port, "127.0.0.1");
