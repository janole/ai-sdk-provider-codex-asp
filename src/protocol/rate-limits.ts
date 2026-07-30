import type { AccountRateLimitsUpdatedNotification } from "./app-server-protocol/v2/AccountRateLimitsUpdatedNotification";
import type { CreditsSnapshot } from "./app-server-protocol/v2/CreditsSnapshot";
import type { GetAccountRateLimitsResponse } from "./app-server-protocol/v2/GetAccountRateLimitsResponse";
import type { RateLimitReachedType } from "./app-server-protocol/v2/RateLimitReachedType";
import type { RateLimitSnapshot } from "./app-server-protocol/v2/RateLimitSnapshot";
import type { RateLimitWindow } from "./app-server-protocol/v2/RateLimitWindow";
import type { SpendControlLimitSnapshot } from "./app-server-protocol/v2/SpendControlLimitSnapshot";

export type {
    AccountRateLimitsUpdatedNotification,
    CreditsSnapshot,
    GetAccountRateLimitsResponse,
    RateLimitReachedType,
    RateLimitSnapshot,
    RateLimitWindow,
    SpendControlLimitSnapshot,
};

/** Selects the Codex bucket from the current multi-bucket response, with the legacy view as fallback. */
export function selectCodexRateLimits(response: GetAccountRateLimitsResponse): RateLimitSnapshot
{
    return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
}

/**
 * Merges a sparse rolling notification into the latest full snapshot.
 *
 * The protocol explicitly defines null notification fields as unavailable rather than clearing a
 * previously observed value, so only non-null fields replace the held snapshot.
 */
export function mergeRateLimitSnapshots(
    current: RateLimitSnapshot | undefined,
    update: RateLimitSnapshot,
): RateLimitSnapshot
{
    if (!current)
    {
        return update;
    }

    return {
        limitId: update.limitId ?? current.limitId,
        limitName: update.limitName ?? current.limitName,
        primary: update.primary ?? current.primary,
        secondary: update.secondary ?? current.secondary,
        credits: update.credits ?? current.credits,
        individualLimit: update.individualLimit ?? current.individualLimit,
        spendControlReached: update.spendControlReached ?? current.spendControlReached,
        planType: update.planType ?? current.planType,
        rateLimitReachedType: update.rateLimitReachedType ?? current.rateLimitReachedType,
    };
}
