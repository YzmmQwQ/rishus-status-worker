/**
 * Minecraft Server List Ping —— 在 Cloudflare Worker 内用 TCP 直连查询
 * 走原生 MC 协议（VarInt + handshake + status），零外部依赖、不依赖任何第三方 API。
 * 文档：https://wiki.vg/Server_List_Ping
 */

import { connect } from 'cloudflare:sockets';

// ---- VarInt / 字段编码 ----
function writeVarInt(value) {
    const bytes = [];
    let v = value >>> 0; // 按无符号处理（-1 → 5 字节）
    do {
        let temp = v & 0x7f;
        v >>>= 7;
        if (v !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (v !== 0);
    return bytes;
}

function writeString(str) {
    const strBytes = new TextEncoder().encode(str);
    return [...writeVarInt(strBytes.length), ...strBytes];
}

function writeUShort(value) {
    return [(value >> 8) & 0xff, value & 0xff];
}

// 给数据加上 VarInt 长度前缀，组成一个完整包
function framePacket(dataBytes) {
    return new Uint8Array([...writeVarInt(dataBytes.length), ...dataBytes]);
}

// ---- MOTD 文本提取 ----
function stripColorCodes(s) {
    return s.replace(/§[0-9a-fk-or]/gi, '');
}

function extractMotd(desc) {
    if (desc == null) return '';
    if (typeof desc === 'string') return stripColorCodes(desc);
    let out = typeof desc.text === 'string' ? desc.text : '';
    if (Array.isArray(desc.extra)) {
        for (const e of desc.extra) out += extractMotd(e);
    }
    return stripColorCodes(out);
}

// ---- SRV 解析（DoH）----
// MC 域名常只配 _minecraft._tcp.<host> 的 SRV 记录（内网穿透 / 联机平台的随机端口），
// 没有 A 记录。connect() 只解析 A 记录，所以要先查 SRV 拿到真实 target+port。
async function resolveSRV(host) {
    try {
        const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent('_minecraft._tcp.' + host)}&type=SRV`;
        const res = await fetch(url, { headers: { accept: 'application/dns-json' } });
        if (!res.ok) return null;
        const data = await res.json();
        const answers = (data.Answer || []).filter((a) => a.type === 33); // 33 = SRV
        if (!answers.length) return null;
        // 取优先级最高（priority 最小）的一条；data 形如 "0 5 64859 target.example.com."
        answers.sort((a, b) => {
            const pa = Number(a.data.split(' ')[0]);
            const pb = Number(b.data.split(' ')[0]);
            return pa - pb;
        });
        const parts = answers[0].data.trim().split(/\s+/);
        const srvPort = Number(parts[2]);
        let target = parts[3] || '';
        target = target.replace(/\.$/, ''); // 去掉末尾的点
        if (!target || !srvPort) return null;
        return { target, port: srvPort };
    } catch {
        return null;
    }
}

// ---- 主查询 ----
export async function pingMC(host, port, timeoutMs = 5000) {
    // 先查 SRV：查到就用真实 target+port 连，握手仍发原始域名（兼容虚拟主机）
    const srv = await resolveSRV(host).catch(() => null);
    const connectHost = srv ? srv.target : host;
    const connectPort = srv ? srv.port : Number(port);

    const result = await Promise.race([
        doPing(connectHost, connectPort, host, Number(port)),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
        )
    ]).catch(() => null);

    if (!result) return { online: false, players: null, version: null, motd: null, playerList: [] };

    return {
        online: true,
        players: {
            online: result.players?.online ?? 0,
            max: result.players?.max ?? 0
        },
        version: result.version?.name ?? null,
        motd: extractMotd(result.description),
        playerList: (result.players?.sample || []).map((p) => p.name)
    };
}

// connectHost/connectPort：实际 TCP 连接目标；handshakeHost/handshakePort：握手包里声明的地址
async function doPing(connectHost, connectPort, handshakeHost, handshakePort) {
    const socket = connect({ hostname: connectHost, port: Number(connectPort) });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    let buffer = new Uint8Array(0);
    let streamDone = false;

    async function ensure(n) {
        while (buffer.length < n && !streamDone) {
            const { value, done } = await reader.read();
            if (done) { streamDone = true; break; }
            if (value && value.length) {
                const merged = new Uint8Array(buffer.length + value.length);
                merged.set(buffer);
                merged.set(value, buffer.length);
                buffer = merged;
            }
        }
        if (buffer.length < n) throw new Error('connection closed prematurely');
    }

    async function readVarInt() {
        let numRead = 0;
        let resultVal = 0;
        let byte;
        do {
            await ensure(1);
            byte = buffer[0];
            buffer = buffer.subarray(1);
            resultVal |= (byte & 0x7f) << (7 * numRead);
            numRead++;
            if (numRead > 5) throw new Error('VarInt too big');
        } while ((byte & 0x80) !== 0);
        return resultVal >>> 0;
    }

    try {
        // 1) Handshake 包：packetId(0) + protocol(-1) + host + port + nextState(1=status)
        const handshakeData = [
            ...writeVarInt(0x00),
            ...writeVarInt(-1),
            ...writeString(handshakeHost),
            ...writeUShort(Number(handshakePort)),
            ...writeVarInt(1)
        ];
        await writer.write(framePacket(handshakeData));

        // 2) Status Request 包：packetId(0)，无字段
        await writer.write(framePacket([0x00]));

        // 3) 读 Status Response：长度前缀 + packetId(0) + JSON 字符串
        const pktLen = await readVarInt();
        await ensure(pktLen);
        await readVarInt(); // packetId（应为 0，忽略）
        const jsonLen = await readVarInt();
        await ensure(jsonLen);
        const jsonBytes = buffer.subarray(0, jsonLen);
        buffer = buffer.subarray(jsonLen);
        return JSON.parse(new TextDecoder().decode(jsonBytes));
    } finally {
        try { await writer.close(); } catch { /* ignore */ }
        try { reader.releaseLock(); } catch { /* ignore */ }
        try { await socket.close(); } catch { /* ignore */ }
    }
}
