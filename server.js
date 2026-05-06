const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Hàm parse pool URL: hỗ trợ stratum+tcp://, ws://, wss://, hoặc host:port thuần
function parsePoolUrl(url) {
    if (!url) throw new Error('Pool URL is required');
    
    // Nếu có scheme stratum+tcp://
    if (url.startsWith('stratum+tcp://')) {
        const cleaned = url.replace('stratum+tcp://', '');
        const [host, portStr] = cleaned.split(':');
        return {
            host: host,
            port: parseInt(portStr) || 3333
        };
    }
    
    // Nếu là ws:// hoặc wss:// (có thể forward qua bridge khác)
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
        const parsed = new URL(url);
        return {
            host: parsed.hostname,
            port: parseInt(parsed.port) || (url.startsWith('wss://') ? 443 : 80)
        };
    }
    
    // Fallback: hostname:port không scheme
    if (url.includes(':')) {
        const [host, portStr] = url.split(':');
        return {
            host: host,
            port: parseInt(portStr) || 3333
        };
    }
    
    // Mặc định host:port 3333
    return {
        host: url,
        port: 3333
    };
}

wss.on('connection', (ws) => {
    let poolSocket = null;
    let isConnected = false;
    let reconnectTimer = null;
    let pingInterval = null;
    let currentConfig = null;
    let buffer = ''; // Buffer cho TCP data chunks

    // Cleanup function
    const cleanup = () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        if (poolSocket) {
            poolSocket.destroy();
            poolSocket = null;
        }
        isConnected = false;
    };

    // Kết nối đến pool
    const connectToPool = (config) => {
        cleanup();
        currentConfig = config;

        const { host, port, worker, password } = config;
        console.log(`[Pool] Connecting to ${host}:${port} | Worker: ${worker}`);

        poolSocket = new net.Socket();
        poolSocket.setKeepAlive(true, 60000); // TCP keep-alive

        poolSocket.connect(port, host, () => {
            console.log(`[Pool] TCP connected to ${host}:${port}`);
            isConnected = true;
            buffer = '';

            // Gửi mining.subscribe
            const subMsg = JSON.stringify({ 
                id: 1, 
                method: "mining.subscribe", 
                params: ["browser-miner/2.0.0", "github.com/nam348tnh3gp/browser-mining"] 
            }) + '\n';
            poolSocket.write(subMsg);
            console.log('[Pool] Sent: mining.subscribe');

            // Gửi mining.authorize
            const authMsg = JSON.stringify({ 
                id: 2, 
                method: "mining.authorize", 
                params: [worker, password || 'x'] 
            }) + '\n';
            poolSocket.write(authMsg);
            console.log('[Pool] Sent: mining.authorize');

            ws.send(JSON.stringify({ 
                type: 'status', 
                message: `Connected to ${host}:${port}` 
            }));

            // Gửi mining.ping mỗi 30 giây để giữ kết nối
            pingInterval = setInterval(() => {
                if (isConnected && poolSocket && !poolSocket.destroyed) {
                    const pingMsg = JSON.stringify({ 
                        id: 0, 
                        method: "mining.ping" 
                    }) + '\n';
                    poolSocket.write(pingMsg);
                }
            }, 30000);
        });

        // Nhận dữ liệu từ pool (có xử lý buffer cho chunked data)
        poolSocket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            // Giữ lại phần chưa hoàn chỉnh
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    // Forward raw stratum message đến browser
                    ws.send(JSON.stringify({ 
                        type: 'pool', 
                        data: line.trim() 
                    }));
                    
                    // Log parsed message (debug)
                    const parsed = JSON.parse(line.trim());
                    if (parsed.method === 'mining.set_difficulty') {
                        console.log(`[Pool] Difficulty set: ${parsed.params[0]}`);
                    } else if (parsed.method === 'mining.notify') {
                        console.log(`[Pool] New job #${parsed.params[0]} received`);
                    }
                } catch (e) {
                    // Forward raw line nếu không parse được JSON
                    ws.send(JSON.stringify({ 
                        type: 'pool', 
                        data: line.trim() 
                    }));
                }
            }
        });

        poolSocket.on('close', () => {
            console.log('[Pool] Connection closed');
            isConnected = false;
            if (pingInterval) clearInterval(pingInterval);
            ws.send(JSON.stringify({ type: 'status', message: 'Pool disconnected' }));
            
            // Auto reconnect sau 10 giây
            if (currentConfig) {
                reconnectTimer = setTimeout(() => {
                    console.log('[Pool] Attempting reconnect...');
                    connectToPool(currentConfig);
                }, 10000);
            }
        });

        poolSocket.on('error', (err) => {
            console.error(`[Pool] Error: ${err.message}`);
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: `Pool error: ${err.message}` 
            }));
        });

        poolSocket.on('timeout', () => {
            console.log('[Pool] Socket timeout');
            if (poolSocket) poolSocket.destroy();
        });
    };

    // Xử lý message từ browser
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'connect') {
                // Parse pool URL và thông tin kết nối
                let poolInfo;
                
                // Hỗ trợ format mới: { pool, wallet } hoặc cũ: { host, port, worker, password }
                if (msg.pool) {
                    poolInfo = parsePoolUrl(msg.pool);
                    poolInfo.worker = msg.wallet || msg.worker || '';
                    poolInfo.password = msg.password || 'x';
                } else {
                    // Backward compatible với format cũ
                    poolInfo = {
                        host: msg.host,
                        port: msg.port || 3333,
                        worker: msg.worker || msg.wallet || '',
                        password: msg.password || 'x'
                    };
                }

                console.log(`[Bridge] Client connecting to pool: ${poolInfo.host}:${poolInfo.port}`);
                connectToPool(poolInfo);
            }
            else if (msg.type === 'share' && isConnected && poolSocket && !poolSocket.destroyed) {
                // Forward share từ browser đến pool
                const shareMsg = JSON.stringify(msg.data) + '\n';
                poolSocket.write(shareMsg);
                console.log(`[Share] Submitted: ${JSON.stringify(msg.data.params)}`);
            }
            else if (msg.type === 'disconnect') {
                cleanup();
                currentConfig = null;
                ws.send(JSON.stringify({ type: 'status', message: 'Disconnected' }));
            }

        } catch (e) {
            console.error(`[Bridge] Error processing message: ${e.message}`);
            ws.send(JSON.stringify({ type: 'error', message: `Bridge error: ${e.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('[Bridge] Client disconnected');
        cleanup();
        currentConfig = null;
    });

    ws.on('error', (err) => {
        console.error(`[Bridge] WebSocket error: ${err.message}`);
        cleanup();
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Bridge] Server running on port ${PORT}`);
    console.log(`[Bridge] Open http://localhost:${PORT} in browser`);
});
