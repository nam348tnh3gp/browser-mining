let socket;
let cpuWorkers = [];
let gpuWorker = null;
let cpuHr = 0, gpuHr = 0;

const poolHost = document.getElementById('poolHost');
const poolPort = document.getElementById('poolPort');
const workerField = document.getElementById('worker');
const passwordField = document.getElementById('password');
const cpuThreads = document.getElementById('cpuThreads');
const enableGPU = document.getElementById('enableGPU');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const logDiv = document.getElementById('log');
const statusSpan = document.getElementById('status');
const totalHashrateSpan = document.getElementById('totalHashrate');
const cpuHashrateSpan = document.getElementById('cpuHashrate');
const gpuHashrateSpan = document.getElementById('gpuHashrate');
const sharesSpan = document.getElementById('shares');
const rejectedSpan = document.getElementById('rejected');

// Kiểm tra WebGPU
async function checkWebGPU() {
    if (!navigator.gpu) {
        enableGPU.disabled = true;
        document.getElementById('gpuStatus').textContent = '❌ Không hỗ trợ';
        return false;
    }
    enableGPU.disabled = false;
    document.getElementById('gpuStatus').textContent = '✅ Sẵn sàng';
    return true;
}
checkWebGPU();

startBtn.addEventListener('click', () => {
    if (!workerField.value.trim()) {
        alert('Vui lòng nhập Worker!');
        return;
    }
    connect();
    startBtn.disabled = true;
    stopBtn.disabled = false;
});

stopBtn.addEventListener('click', () => {
    disconnect();
    startBtn.disabled = false;
    stopBtn.disabled = true;
});

function connect() {
    // Dùng hostname và port hiện tại để kết nối bridge (hỗ trợ file://)
    const bridgePort = location.port || '3000';
    const wsUrl = `ws://${location.hostname}:${bridgePort}`;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        log('WebSocket connected to bridge');
        socket.send(JSON.stringify({
            type: 'connect',
            host: poolHost.value.trim(),
            port: parseInt(poolPort.value) || 3333,
            worker: workerField.value.trim(),
            password: passwordField.value.trim() || 'x'
        }));
        updateStatus('Connecting to pool...');
        startWorkers();
    };

    socket.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'pool') {
                // Forward stratum message đến workers
                const stratumMsg = { type: 'stratum', data: msg.data };
                cpuWorkers.forEach(w => w.postMessage(stratumMsg));
                if (gpuWorker) gpuWorker.postMessage(stratumMsg);
            } else if (msg.type === 'status') {
                updateStatus(msg.message);
                log(msg.message);
            } else if (msg.type === 'error') {
                updateStatus('Error: ' + msg.message);
                log('ERROR: ' + msg.message);
            } else if (msg.type === 'share_result') {
                if (msg.accepted) {
                    sharesSpan.textContent = parseInt(sharesSpan.textContent) + 1;
                    log('✅ Share accepted');
                } else {
                    rejectedSpan.textContent = parseInt(rejectedSpan.textContent) + 1;
                    log('❌ Share rejected: ' + (msg.error || 'unknown'));
                }
            }
        } catch (err) {
            console.error('Parse error:', err);
        }
    };

    socket.onclose = () => {
        updateStatus('Disconnected');
        stopAllWorkers();
    };

    socket.onerror = () => {
        updateStatus('Connection error');
        log('WebSocket error');
    };
}

function disconnect() {
    if (socket) {
        socket.send(JSON.stringify({ type: 'disconnect' }));
        socket.close();
    }
    stopAllWorkers();
}

function startWorkers() {
    stopAllWorkers(); // dọn dẹp cũ
    const numThreads = parseInt(cpuThreads.value) || 2;
    for (let i = 0; i < numThreads; i++) {
        const worker = new Worker('miner-cpu.js');
        worker.onmessage = handleWorkerMessage;
        cpuWorkers.push(worker);
    }
    log(`Started ${numThreads} CPU threads`);

    if (enableGPU.checked && !enableGPU.disabled) {
        try {
            gpuWorker = new Worker('miner-gpu.js');
            gpuWorker.onmessage = handleWorkerMessage;
            log('GPU miner started');
        } catch (e) {
            log('GPU worker failed: ' + e.message);
        }
    }
}

function stopAllWorkers() {
    cpuWorkers.forEach(w => w.terminate());
    cpuWorkers = [];
    if (gpuWorker) {
        gpuWorker.terminate();
        gpuWorker = null;
    }
    cpuHr = 0;
    gpuHr = 0;
    updateHashrate();
}

function handleWorkerMessage(e) {
    const data = e.data;
    if (data.type === 'hashrate') {
        if (data.source === 'cpu') cpuHr = data.value;
        else if (data.source === 'gpu') gpuHr = data.value;
        updateHashrate();
    } else if (data.type === 'share') {
        // Gửi share về bridge (dùng type 'share', cũng có thể 'mining' vì server đã chấp nhận cả hai)
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'share',
                data: data.data
            }));
            log('Share submitted');
        }
    }
}

function updateHashrate() {
    const total = cpuHr + gpuHr;
    totalHashrateSpan.textContent = formatHashrate(total);
    cpuHashrateSpan.textContent = formatHashrate(cpuHr);
    gpuHashrateSpan.textContent = formatHashrate(gpuHr);
}

function formatHashrate(h) {
    if (h > 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
    if (h > 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
    if (h > 1e3) return (h / 1e3).toFixed(2) + ' kH/s';
    return h.toFixed(0) + ' H/s';
}

function updateStatus(msg) {
    statusSpan.textContent = msg;
}

function log(msg) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logDiv.appendChild(line);
    logDiv.scrollTop = logDiv.scrollHeight;
}
