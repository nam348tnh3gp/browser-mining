// ----- Khởi tạo biến toàn cục -----
let ws = null;
let cpuWorkers = [];
let gpuWorker = null;
let isRunning = false;
let enableGPU = false;

let totalHashrate = 0;
let cpuHashrate = 0;
let gpuHashrate = 0;
let sharesAccepted = 0;
let sharesRejected = 0;

const cpuThreadsInput = document.getElementById('cpuThreads');
const enableGPUCheckbox = document.getElementById('enableGPU');
const gpuStatusSpan = document.getElementById('gpuStatus');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const logEl = document.getElementById('log');

// ----- Kiểm tra hỗ trợ WebGPU -----
async function checkWebGPU() {
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                enableGPUCheckbox.disabled = false;
                gpuStatusSpan.textContent = '✅ Có hỗ trợ WebGPU';
                gpuStatusSpan.style.color = '#4caf50';
                return true;
            }
        } catch (e) {}
    }
    gpuStatusSpan.textContent = '❌ Không hỗ trợ WebGPU';
    gpuStatusSpan.style.color = '#f44336';
    return false;
}
checkWebGPU();

enableGPUCheckbox.onchange = () => {
    if (!isRunning) enableGPU = enableGPUCheckbox.checked;
    else alert('Không thể thay đổi khi đang đào');
};

// ----- Log helper -----
function log(msg, color) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (color) line.style.color = color;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function updateStats() {
    document.getElementById('totalHashrate').textContent = (totalHashrate / 1000).toFixed(2) + ' kH/s';
    document.getElementById('cpuHashrate').textContent = (cpuHashrate / 1000).toFixed(2) + ' kH/s';
    document.getElementById('gpuHashrate').textContent = (gpuHashrate / 1000).toFixed(2) + ' kH/s';
    document.getElementById('shares').textContent = sharesAccepted;
    document.getElementById('rejected').textContent = sharesRejected;
}

// ----- Kết nối WebSocket -----
function connect(host, port, worker, password) {
    ws = new WebSocket(`ws://${location.host}`);

    ws.onopen = () => {
        log('WebSocket connected to bridge', '#4caf50');
        document.getElementById('status').textContent = 'Đang kết nối pool...';
        ws.send(JSON.stringify({ type: 'connect', host, port, worker, password }));
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'pool') {
                // Chuyển dữ liệu stratum cho tất cả worker
                broadcastToWorkers(msg.data);
            } else if (msg.type === 'status') {
                log(msg.message, '#ff9800');
                document.getElementById('status').textContent = msg.message;
            } else if (msg.type === 'error') {
                log('Lỗi: ' + msg.message, '#f44336');
            }
        } catch (ex) {}
    };

    ws.onerror = (err) => log('WebSocket error', '#f44336');
    ws.onclose = () => log('WebSocket disconnected', '#f44336');
}

// ----- Gửi dữ liệu stratum đến tất cả worker -----
function broadcastToWorkers(stratumLine) {
    cpuWorkers.forEach(w => w.postMessage({ type: 'stratum', data: stratumLine }));
    if (gpuWorker) gpuWorker.postMessage({ type: 'stratum', data: stratumLine });
}

// ----- Gửi share lên pool -----
window.sendShare = function(shareData) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mining', data: shareData }));
        log('Share submitted: ' + JSON.stringify(shareData.params).substring(0, 60), '#2196f3');
    }
};

// ----- Bắt đầu đào -----
startBtn.onclick = () => {
    const host = document.getElementById('poolHost').value;
    const port = parseInt(document.getElementById('poolPort').value);
    const worker = document.getElementById('worker').value;
    const password = document.getElementById('password').value;
    const cpuThreads = parseInt(cpuThreadsInput.value) || 2;

    if (!host || !port || !worker) return alert('Thiếu thông tin pool');

    enableGPU = enableGPUCheckbox.checked && !enableGPUCheckbox.disabled;
    
    // Kết nối pool
    connect(host, port, worker, password);
    
    // Tạo CPU workers
    cpuWorkers = [];
    for (let i = 0; i < cpuThreads; i++) {
        const w = new Worker('miner-cpu.js');
        w.onmessage = handleWorkerMessage;
        cpuWorkers.push(w);
    }
    
    // Tạo GPU worker nếu bật
    if (enableGPU) {
        gpuWorker = new Worker('miner-gpu.js');
        gpuWorker.onmessage = handleWorkerMessage;
    }

    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    enableGPUCheckbox.disabled = true;
    cpuThreadsInput.disabled = true;
    document.getElementById('status').textContent = 'Đang đào...';
    log('Bắt đầu đào với ' + cpuThreads + ' threads CPU' + (enableGPU ? ' + GPU' : ''), '#ff9800');
};

// ----- Xử lý message từ worker -----
function handleWorkerMessage(e) {
    const msg = e.data;
    
    if (msg.type === 'hashrate') {
        if (msg.source === 'cpu') {
            cpuHashrate = msg.value;
        } else if (msg.source === 'gpu') {
            gpuHashrate = msg.value;
        }
        totalHashrate = cpuHashrate + gpuHashrate;
        updateStats();
    }
    else if (msg.type === 'share') {
        sendShare(msg.data);
    }
    else if (msg.type === 'share_accepted') {
        sharesAccepted++;
        updateStats();
        log('✅ Share accepted', '#4caf50');
    }
    else if (msg.type === 'share_rejected') {
        sharesRejected++;
        updateStats();
        log('❌ Share rejected: ' + (msg.reason || ''), '#f44336');
    }
}

// ----- Dừng đào -----
stopBtn.onclick = () => {
    if (ws) ws.close();
    cpuWorkers.forEach(w => w.terminate());
    if (gpuWorker) gpuWorker.terminate();
    cpuWorkers = [];
    gpuWorker = null;
    ws = null;
    isRunning = false;
    totalHashrate = cpuHashrate = gpuHashrate = 0;
    updateStats();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    enableGPUCheckbox.disabled = false;
    cpuThreadsInput.disabled = false;
    document.getElementById('status').textContent = 'Đã dừng';
    log('Mining stopped', '#ff9800');
};
