import type { CodexTransport } from "./transport";
import { CodexWorkerPool } from "./worker-pool";

export interface PersistentPoolAcquireSettings {
    scope: "provider" | "global";
    key?: string;
    poolSize: number;
    idleTimeoutMs: number;
    transportFactory: () => CodexTransport;
}

export interface PersistentPoolHandle {
    pool: CodexWorkerPool;
    release(): Promise<void>;
}

interface GlobalPoolEntry {
    pool: CodexWorkerPool;
    refCount: number;
    poolSize: number;
    idleTimeoutMs: number;
}

const GLOBAL_PERSISTENT_POOL_DEFAULT_KEY = "default";
const globalPersistentPools = new Map<string, GlobalPoolEntry>();

export function acquirePersistentPool(
    settings: PersistentPoolAcquireSettings,
): PersistentPoolHandle
{
    if (settings.scope === "provider")
    {
        const pool = new CodexWorkerPool({
            poolSize: settings.poolSize,
            transportFactory: settings.transportFactory,
            idleTimeoutMs: settings.idleTimeoutMs,
        });

        let released = false;
        return {
            pool,
            async release(): Promise<void>
            {
                if (released)
                {
                    return;
                }
                released = true;
                await pool.shutdown();
            },
        };
    }

    const key = settings.key ?? GLOBAL_PERSISTENT_POOL_DEFAULT_KEY;
    const existing = globalPersistentPools.get(key);

    if (existing)
    {
        if (
            existing.poolSize !== settings.poolSize
            || existing.idleTimeoutMs !== settings.idleTimeoutMs
        )
        {
            throw new Error(
                `Global persistent pool "${key}" already exists with different settings.`,
            );
        }

        existing.refCount++;
        let released = false;
        return {
            pool: existing.pool,
            async release(): Promise<void>
            {
                if (released)
                {
                    return;
                }
                released = true;

                const entry = globalPersistentPools.get(key);
                if (!entry)
                {
                    return;
                }

                entry.refCount--;
                if (entry.refCount <= 0)
                {
                    globalPersistentPools.delete(key);
                    await entry.pool.shutdown();
                }
            },
        };
    }

    const pool = new CodexWorkerPool({
        poolSize: settings.poolSize,
        transportFactory: settings.transportFactory,
        idleTimeoutMs: settings.idleTimeoutMs,
    });

    globalPersistentPools.set(key, {
        pool,
        refCount: 1,
        poolSize: settings.poolSize,
        idleTimeoutMs: settings.idleTimeoutMs,
    });

    let released = false;
    return {
        pool,
        async release(): Promise<void>
        {
            if (released)
            {
                return;
            }
            released = true;

            const entry = globalPersistentPools.get(key);
            if (!entry)
            {
                return;
            }

            entry.refCount--;
            if (entry.refCount <= 0)
            {
                globalPersistentPools.delete(key);
                await entry.pool.shutdown();
            }
        },
    };
}
