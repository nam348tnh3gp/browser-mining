const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Origin check để tránh abuse
const wss = new WebSocket.Server({
    server,
    verifyClient: (info) => {
        const origin = info.origin;
        // Cho phép localhost, 127.0.0.1, và file:// (origin = 'null')
        return origin === `http://localhost:${PORT}` ||
               origin === `http://127.0.0.1:${PORT}` ||
               origin === `http://[::1]:${PORT}` ||
               origin === 'null';
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// Hàm parse pool URL – hỗ trợ stratum+tcp://, ws://, wss://, host:port
function parsePoolUrl(url) {
    if (!url) throw new Error('Pool URL required');
    if (url.startsWith('stratum+tcp://')) {
        const cleaned = url.replace('stratum+tcp://', '');
        const [host, portStr] = cleaned.split(':');
        return { host, port: parseInt(portStr) || 3333 };
    }
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
        const parsed = new URL(url);
        return { host: parsed.hostname, port: parseInt(parsed.port) || (url.startsWith('wss://') ? 443 : 80) };
    }
    if (url.includes(':')) {
        const [host, portStr] = url.split(':');
        return { host, port: parseInt(portStr) || 3333 };
    }
    return { host: url, port: 3333 };
}

wss.on('connection', (ws) => {
    let poolSocket = null;
    let isConnected = false;
    let reconnectTimer = null;
    let pingInterval = null;
    let currentConfig = null;
    let buffer = '';

    const cleanup = () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (poolSocket) { poolSocket.destroy(); poolSocket = null; }
        isConnected = false;
    };

    const connectToPool = (config) => {
        cleanup();
        currentConfig = config;
        const { host, port, worker, password } = config;
        console.log(`[Pool] Connecting to ${host}:${port} | Worker: ${worker}`);

        poolSocket = new net.Socket();
        poolSocket.setKeepAlive(true, 60000);

        poolSocket.connect(port, host, () => {
            console.log('[Pool] TCP connected');
            isConnected = true;
            buffer = '';

            // Subscribe
            const subMsg = JSON.stringify({
                id: 1,
                method: "mining.subscribe",
                params: ["browser-miner/2.0.0"]
            }) + '\n';
            poolSocket.write(subMsg);
            console.log('[Pool] Sent subscribe');

            // Authorize
            const authMsg = JSON.stringify({
                id: 2,
                method: "mining.authorize",
                params: [worker, password || 'x']
            }) + '\n';
            poolSocket.write(authMsg);
            console.log('[Pool] Sent authorize');

            ws.send(JSON.stringify({ type: 'status', message: `Connected to pool` }));

            // Keep-alive ping mỗi 30s
            pingInterval = setInterval(() => {
                if (isConnected && poolSocket && !poolSocket.destroyed) {
                    poolSocket.write(JSON.stringify({ id: 0, method: "mining.ping" }) + '\n');
                }
            }, 30000);
        });

        poolSocket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                // Forward raw line đến browser
                ws.send(JSON.stringify({ type: 'pool', data: line.trim() }));
                try {
                    const parsed = JSON.parse(line.trim());
                    if (parsed.method === 'mining.set_difficulty') {
                        console.log(`[Pool] Difficulty: ${parsed.params[0]}`);
                    } else if (parsed.method === 'mining.notify') {
                        console.log(`[Pool] New job #${parsed.params[0]}`);
                    } else if (parsed.result !== undefined) {
                        // Kết quả submit share (true/false)
                        ws.send(JSON.stringify({
                            type: 'share_result',
                            accepted: parsed.result === true,
                            error: parsed.error || null
                        }));
                        console.log(`[Pool] Share ${parsed.result ? 'accepted' : 'rejected'}`);
                    }
                } catch (e) { /* ignore parse error */ }
            }
        });

        poolSocket.on('close', () => {
            console.log('[Pool] Connection closed');
            isConnected = false;
            if (pingInterval) clearInterval(pingInterval);
            ws.send(JSON.stringify({ type: 'status', message: 'Pool disconnected' }));
            if (currentConfig) {
                reconnectTimer = setTimeout(() => {
                    console.log('[Pool] Attempting reconnect...');
                    connectToPool(currentConfig);
                }, 10000);
            }
        });

        poolSocket.on('error', (err) => {
            console.error(`[Pool] Error: ${err.message}`);
            ws.send(JSON.stringify({ type: 'error', message: `Pool: ${err.message}` }));
        });
    };

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'connect') {
                let config;
                if (msg.pool) {
                    // Format mới: { pool, wallet, password }
                    const poolInfo = parsePoolUrl(msg.pool);
                    config = {
                        host: poolInfo.host,
                        port: poolInfo.port,
                        worker: msg.wallet || msg.worker || '',
                        password: msg.password || 'x'
                    };
                } else {
                    // Format cũ: { host, port, worker, password }
                    config = {
                        host: msg.host,
                        port: msg.port || 3333,
                        worker: msg.worker || '',
                        password: msg.password || 'x'
                    };
                }
                connectToPool(config);
            }
            // Chấp nhận cả type 'share' lẫn 'mining' để tương thích
            else if ((msg.type === 'share' || msg.type === 'mining') && isConnected && poolSocket && !poolSocket.destroyed) {
                const shareMsg = JSON.stringify(msg.data) + '\n';
                poolSocket.write(shareMsg);
                console.log(`[Share] Forwarded: ${JSON.stringify(msg.data.params)}`);
            }
            else if (msg.type === 'disconnect') {
                cleanup();
                currentConfig = null;
                ws.send(JSON.stringify({ type: 'status', message: 'Disconnected' }));
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: `Bridge error: ${e.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('[Bridge] Client disconnected');
        cleanup();
        currentConfig = null;
    });

    ws.on('error', (err) => {
        console.error(`[Bridge] WS error: ${err.message}`);
        cleanup();
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

server.listen(PORT, () => console.log(`Bridge server running on port ${PORT}`));
