import { supabaseConfig } from "./config.js?v=stage24";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";

async function damageRequest(path, body) {
    if (!navigator.onLine) {
        throw new Error("Damage recording and reversals require an internet connection.");
    }

    const token = await getValidCloudAccessToken();

    if (!token) {
        throw new Error("No valid cloud session is available. Log out and log back in while online.");
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/${path}`,
        {
            method: "POST",
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(body || {})
        }
    );

    const text = await response.text();
    let data = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            data = text;
        }
    }

    if (!response.ok) {
        throw new Error(
            data?.message ||
            data?.error ||
            (typeof data === "string" ? data : "") ||
            `Damage request failed (${response.status}).`
        );
    }

    return data;
}

export function recordDamage(productId, quantity, reason) {
    return damageRequest(
        "rpc/record_stock_damage",
        {
            p_product_id: Number(productId),
            p_quantity: Number(quantity),
            p_reason: String(reason || "").trim() || null
        }
    );
}

export function undoDamage(damageId, reason = null) {
    return damageRequest(
        "rpc/undo_stock_damage",
        {
            p_damage_id: Number(damageId),
            p_reason: reason
        }
    );
}

export function fetchDamages({
    departmentId,
    from = null,
    to = null,
    sessionId = null,
    productionId = null
}) {
    return damageRequest(
        "rpc/get_stock_damages",
        {
            p_department_id: Number(departmentId),
            p_from: from || null,
            p_to: to || null,
            p_session_id:
                sessionId && sessionId !== "all"
                    ? Number(sessionId)
                    : null,
            p_production_id:
                productionId
                    ? Number(productionId)
                    : null
        }
    );
}
