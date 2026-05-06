const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
    let poolSocket = null;
    let isConnected = false;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'connect') {
                if (poolSocket) poolSocket.destroy();

                const { host, port, worker, password } = msg;
                console.log(`Kết nối pool: ${host}:${port}`);

                poolSocket = new net.Socket();
                poolSocket.connect(port, host, () => {
                    console.log('TCP connected');
                    isConnected = true;

                    // Stratum subscribe & authorize
                    const sub = { id: 1, method: "mining.subscribe", params: [] };
                    poolSocket.write(JSON.stringify(sub) + '\n');

                    const auth = { id: 2, method: "mining.authorize", params: [worker, password] };
                    poolSocket.write(JSON.stringify(auth) + '\n');

                    ws.send(JSON.stringify({ type: 'status', message: 'Connected to pool' }));
                });

                poolSocket.on('data', (buf) => {
                    const lines = buf.toString().split('\n').filter(Boolean);
                    lines.forEach(line => ws.send(JSON.stringify({ type: 'pool', data: line })));
                });

                poolSocket.on('close', () => {
                    isConnected = false;
                    ws.send(JSON.stringify({ type: 'status', message: 'Pool disconnected' }));
                });

                poolSocket.on('error', (err) => ws.send(JSON.stringify({ type: 'error', message: err.message })));
            }
            else if (msg.type === 'mining' && isConnected && poolSocket) {
                poolSocket.write(JSON.stringify(msg.data) + '\n');
            }

        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
    });

    ws.on('close', () => { if (poolSocket) poolSocket.destroy(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server port ${PORT}`));
