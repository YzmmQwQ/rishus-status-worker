/**
 * Cloudflare Worker API - D1 Version
 * MC 服务器状态用原生协议（TCP 直连）查询，由 Cron 定时刷新写入 D1，端点纯只读。
 */

import { pingMC } from './mcping.js';

const CACHE_TTL = 60; // 缓存 60 秒
const FRESH_TTL = 3600; // Cron 刷新的数据兜底保留 1 小时，正常情况下每分钟被覆盖

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
        coresText: rawCpu.hasHybrid && rawCpu.performanceCores && rawCpu.efficiencyCores
            ? `${rawCpu.performanceCores}P+${rawCpu.efficiencyCores}E`
            : `${physicalCores}C${threads}H`,
        gridLayout: calculateCpuGridLayout(threads),
        coresLoad: rawCpu.coresLoad || [],
        performanceCores: rawCpu.performanceCores || 0,
        efficiencyCores: rawCpu.efficiencyCores || 0,
        hasHybrid: rawCpu.hasHybrid || false
    };
}

// 查询单个 MC 服务器（原生 Server List Ping，TCP 直连，无外部 API）
async function queryMCServer(host, port) {
    try {
        return await pingMC(host, port);
    } catch {
        return { online: false, players: null, version: null, motd: null, playerList: [] };
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

// 只读取缓存，不触发上游查询；即使过期也返回（stale），供端点兜底
async function readCache(db, key) {
    const result = await db.prepare("SELECT value FROM cache WHERE key = ?")
        .bind(key)
        .first();
    return result ? JSON.parse(result.value) : null;
}

// 查询所有 MC 服务器并写入缓存（由 Cron 调用）
async function refreshMinecraft(db, env) {
    const config = await getConfig(db);
    const servers = config.mcServers || [];
    const fetchedAt = Date.now();
    await Promise.all(servers.map(async (server) => {
        const cacheKey = `mc:${server.host}:${server.port}`;
        const data = await queryMCServer(server.host, server.port);
        await setCache(db, cacheKey, { ...data, _fetchedAt: fetchedAt }, FRESH_TTL);
    }));
}

// 检测所有网站并写入缓存（由 Cron 调用）
async function refreshWebsites(db, env) {
    const config = await getConfig(db);
    const websites = config.websites || [];
    const fetchedAt = Date.now();
    await Promise.all(websites.map(async (site, i) => {
        const cacheKey = `website:${i}`;
        const data = await checkWebsite(site.url);
        await setCache(db, cacheKey, { ...data, _fetchedAt: fetchedAt }, FRESH_TTL);
    }));
}

export default {
    // Cron Trigger：每分钟主动刷新一次，上游查询次数与访问量解耦
    async scheduled(event, env, ctx) {
        try {
            await initDb(env.DB);
        } catch (e) {
            // 表可能已存在
        }
        ctx.waitUntil(Promise.all([
            refreshMinecraft(env.DB, env),
            refreshWebsites(env.DB, env)
        ]));
    },

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
            // 获取网站状态（纯只读，数据由 Cron 刷新）
            if (path === '/api/websites') {
                const config = await getConfig(env.DB);
                const websites = config.websites || [];
                let updatedAt = null;
                const results = await Promise.all(websites.map(async (site, i) => {
                    const cached = await readCache(env.DB, `website:${i}`);
                    if (cached?._fetchedAt) {
                        updatedAt = updatedAt === null ? cached._fetchedAt : Math.min(updatedAt, cached._fetchedAt);
                    }
                    return {
                        name: site.name,
                        url: site.url,
                        online: cached?.online ?? false,
                        latency: cached?.latency ?? null
                    };
                }));

                return jsonResponse({ success: true, websites: results, updatedAt });
            }

            // 获取 MC 服务器状态（纯只读，数据由 Cron 刷新）
            if (path === '/api/minecraft') {
                const config = await getConfig(env.DB);
                const servers = config.mcServers || [];
                let updatedAt = null;
                const results = [];

                for (const server of servers) {
                    const cached = await readCache(env.DB, `mc:${server.host}:${server.port}`);
                    if (cached?._fetchedAt) {
                        updatedAt = updatedAt === null ? cached._fetchedAt : Math.min(updatedAt, cached._fetchedAt);
                    }

                    results.push({
                        name: server.name,
                        host: server.host,
                        port: server.port,
                        infoUrl: server.infoUrl,
                        online: cached?.online ?? false,
                        players: cached?.players ?? null,
                        version: cached?.version ?? null,
                        motd: cached?.motd ?? null,
                        playerList: cached?.playerList ?? []
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
