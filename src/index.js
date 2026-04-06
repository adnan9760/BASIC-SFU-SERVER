import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { WebSocketConnection } from './ws.js';

function main() {
    const app = express();
    const server = http.createServer(app);

    const wss = new WebSocketServer({ 
        server,
        path: '/ws'
    });

    WebSocketConnection(wss);

    const port = 8080;
    app.get('/',()=>{
        console.log("Default ");
    })
    server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
});
}

main();
