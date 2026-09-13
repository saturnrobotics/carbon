import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);
createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404);
    return response.end();
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ status: "healthy", synthetic: true }));
}).listen(port);
