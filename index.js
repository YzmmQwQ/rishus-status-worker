/**
 * Cloudflare Worker API - D1 Version
 * 缓存 MC 服务器状态，避免频繁请求 UAPI
 */

const MC_API = 'https://uapis.cn/api/v1/game/minecraft/serverstatus';
const CACHE_TTL = 60; // 缓存 60 秒

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'public, max-age=60',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

// 计算 CPU 核心网格布局
function calculateCpuGridLayout(threads) {
    const perRow = Math.ceil(threads / 2);
    return { perRow };
}

// 处理 CPU 数据
function processCpuData(rawCpu) {
    if (!rawCpu) return null;

    const threads = rawCpu.threads || rawCpu.coresLoad?.length || 4;
    const physicalCores = rawCpu.physicalCores || Math.ceil(threads / 2);

    return {
        percent: rawCpu.percent || 0,
        model: rawCpu.model || 'Unknown',
        speed: rawCpu.speed || 0,
        physicalCores: physicalCores,
        threads: threads,
        coresText: `${physicalCores}C${threads}H`,
        gridLayout: calculateCpuGridLayout(threads),
        coresLoad: rawCpu.coresLoad || []
    };
}

// 查询单个 MC 服务器
async function queryMCServer(host, port, apiKey) {
    const address = port === 25565 ? host : `${host}:${port}`;
    const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

    try {
        const response = await fetch(`${MC_API}?server=${address}`, { headers });
        if (!response.ok) return { online: false };

        const data = await response.json();
        return {
            online: data.online,
            players: data.online ? { online: data.players, max: data.max_players } : null,
            version: data.version,
            motd: data.motd_clean,
            playerList: data.online_players?.map(p => p.name) || []
        };
    } catch {
        return { online: false };
    }
}

// 检测网站状态
async function checkWebsite(url) {
    const start = Date.now();
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow'
        });
        const latency = Date.now() - start;
        return { online: response.ok, latency, status: response.status };
    } catch {
        return { online: false, latency: null, status: null };
    }
}

// D1 操作
async function getConfig(db) {
    const result = await db.prepare("SELECT value FROM config WHERE key = 'main'").first();
    return result ? JSON.parse(result.value) : {};
}

async function setConfig(db, config) {
    await db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('main', ?)")
        .bind(JSON.stringify(config))
        .run();
}

async function getCache(db, key) {
    const result = await db.prepare("SELECT value, expires_at FROM cache WHERE key = ?")
        .bind(key)
        .first();

    if (!result) return null;

    // 检查是否过期
    if (Date.now() > result.expires_at) {
        await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
        return null;
    }

    return JSON.parse(result.value);
}

async function setCache(db, key, value, ttl) {
    const expiresAt = Date.now() + ttl * 1000;
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
        .bind(key, JSON.stringify(value), expiresAt)
        .run();
}

async function getServerData(db) {
    const result = await db.prepare("SELECT value, expires_at FROM cache WHERE key = 'server'").first();

    if (!result) return null;

    if (Date.now() > result.expires_at) {
        return null;
    }

    return JSON.parse(result.value);
}

async function setServerData(db, data) {
    const expiresAt = Date.now() + 60 * 1000;
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES ('server', ?, ?)")
        .bind(JSON.stringify(data), expiresAt)
        .run();
}

// 初始化数据库表
async function initDb(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT,
            expires_at INTEGER
        );
    `);
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // 初始化数据库
        try {
            await initDb(env.DB);
        } catch (e) {
            // 表可能已存在
        }

        try {
            // 获取网站状态
            if (path === '/api/websites') {
                const config = await getConfig(env.DB);
                const websites = config.websites || [];
                const updatedAt = Date.now();
                const results = await Promise.all(websites.map(async (site, i) => {
                    const cacheKey = `website:${i}`;
                    let data = await getCache(env.DB, cacheKey);

                    if (!data) {
                        data = await checkWebsite(site.url);
                        await setCache(env.DB, cacheKey, data, CACHE_TTL);
                    }

                    return {
                        name: site.name,
                        url: site.url,
                        online: data.online,
                        latency: data.latency
                    };
                }));

                return jsonResponse({ success: true, websites: results, updatedAt });
            }

            // 获取 MC 服务器状态（带缓存）
            if (path === '/api/minecraft') {
                const config = await getConfig(env.DB);
                const servers = config.mcServers || [];
                const updatedAt = Date.now();
                const results = [];

                for (const server of servers) {
                    const cacheKey = `mc:${server.host}:${server.port}`;

                    let data = await getCache(env.DB, cacheKey);

                    if (!data) {
                        data = await queryMCServer(server.host, server.port, env.UAPI_KEY);
                        await setCache(env.DB, cacheKey, data, CACHE_TTL);
                    }

                    results.push({
                        name: server.name,
                        host: server.host,
                        port: server.port,
                        infoUrl: server.infoUrl,
                        online: data.online,
                        players: data.players,
                        version: data.version,
                        motd: data.motd,
                        playerList: data.playerList
                    });
                }

                return jsonResponse({ success: true, servers: results, updatedAt });
            }

            // 获取服务器资源（从 Agent 推送的数据）
            if (path === '/api/server') {
                const rawData = await getServerData(env.DB);
                if (!rawData?.data) {
                    return jsonResponse({ success: true, data: null, updatedAt: null });
                }

                const data = rawData.data;
                if (data.cpu) {
                    data.cpu = processCpuData(data.cpu);
                }

                return jsonResponse({
                    success: true,
                    data,
                    updatedAt: rawData.data.timestamp || null
                });
            }

            // Agent 推送数据
            if (path === '/api/update' && request.method === 'POST') {
                const auth = request.headers.get('Authorization');
                if (auth !== `Bearer ${env.UPDATE_TOKEN}`) {
                    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
                }

                const body = await request.json();
                if (body.data) {
                    body.data.timestamp = Date.now();
                }
                await setServerData(env.DB, body);
                return jsonResponse({ success: true });
            }

            // 配置管理 API
            if (path === '/api/config' && request.method === 'GET') {
                const config = await getConfig(env.DB);
                return jsonResponse({ success: true, config });
            }

            if (path === '/api/config' && request.method === 'POST') {
                const auth = request.headers.get('Authorization');
                if (auth !== `Bearer ${env.UPDATE_TOKEN}`) {
                    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
                }

                const body = await request.json();
                await setConfig(env.DB, body);
                return jsonResponse({ success: true });
            }

            return jsonResponse({ success: false, error: 'Not Found' }, 404);

        } catch (error) {
            return jsonResponse({ success: false, error: error.message }, 500);
        }
    }
};
