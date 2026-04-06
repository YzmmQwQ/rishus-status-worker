/**
 * Cloudflare Worker API
 * 缓存 MC 服务器状态，避免频繁请求 UAPI
 */

const MC_API = 'https://uapis.cn/api/v1/game/minecraft/serverstatus';
const MC_CACHE_TTL = 20; // MC 服务器缓存 20 秒
const WEBSITE_CACHE_TTL = 10; // 网站状态缓存 10 秒

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

// 计算 CPU 核心网格布局（尽量两行显示）
function calculateCpuGridLayout(threads) {
    const perRow = Math.ceil(threads / 2);  // 每行格子数 = 总数 / 2 向上取整
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
        coresText: `${physicalCores}C${threads}H`,  // 如 8C16H
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

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // 获取网站状态
            if (path === '/api/websites') {
                const websites = env.WEBSITES || [];
                const updatedAt = Date.now();
                const results = await Promise.all(websites.map(async (site, i) => {
                    const cacheKey = `website:${i}`;
                    let data = await env.SERVER_STATUS.get(cacheKey, { type: 'json' });

                    if (!data) {
                        data = await checkWebsite(site.url);
                        await env.SERVER_STATUS.put(cacheKey, JSON.stringify(data), {
                            expirationTtl: WEBSITE_CACHE_TTL
                        });
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
                const servers = env.MC_SERVERS || [];
                const updatedAt = Date.now();
                const results = [];

                for (const server of servers) {
                    const cacheKey = `mc:${server.host}:${server.port}`;

                    let data = await env.SERVER_STATUS.get(cacheKey, { type: 'json' });

                    if (!data) {
                        data = await queryMCServer(server.host, server.port, env.UAPI_KEY);
                        await env.SERVER_STATUS.put(cacheKey, JSON.stringify(data), {
                            expirationTtl: MC_CACHE_TTL
                        });
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
                const rawData = await env.SERVER_STATUS.get('server', { type: 'json' });
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
                await env.SERVER_STATUS.put('server', JSON.stringify(body), { expirationTtl: 60 });
                return jsonResponse({ success: true });
            }

            return jsonResponse({ success: false, error: 'Not Found' }, 404);

        } catch (error) {
            return jsonResponse({ success: false, error: error.message }, 500);
        }
    }
};
