/**
 * Minecraft Java status query through mcstatus.io.
 * The API performs the TCP ping from its own infrastructure and handles SRV records.
 */

const API_BASE = 'https://api.mcstatus.io/v2/status/java/';

export async function pingMC(host, port, timeoutMs = 10000) {
    const numericPort = Number(port);
    const address = `${host}:${numericPort}`;
    const endpoint = `${API_BASE}${encodeURIComponent(host)}:${numericPort}`;

    const response = await Promise.race([
        fetch(endpoint, { headers: { accept: 'application/json' } }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('mcstatus.io request timeout')), timeoutMs)
        )
    ]);

    if (!response.ok) {
        throw new Error(`mcstatus.io returned HTTP ${response.status} for ${address}`);
    }

    const data = await response.json();
    if (!data.online) {
        return { online: false, players: null, version: null, motd: null, playerList: [] };
    }

    return {
        online: true,
        players: {
            online: data.players?.online ?? 0,
            max: data.players?.max ?? 0
        },
        version: data.version?.name_clean || data.version?.name_raw || null,
        motd: data.motd?.clean || data.motd?.raw || null,
        playerList: (data.players?.list || [])
            .map((player) => player.name_clean || player.name_raw || player.name)
            .filter(Boolean)
    };
}
