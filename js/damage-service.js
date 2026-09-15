import { authenticatedRpc } from "./cloud-rpc.js?v=stage24-1";

export function recordDamage(productId, quantity, reason) {
    return authenticatedRpc(
        "record_stock_damage",
        {
            p_product_id: Number(productId),
            p_quantity: Number(quantity),
            p_reason: String(reason || "").trim() || null
        }
    );
}

export function undoDamage(damageId, reason = null) {
    return authenticatedRpc(
        "undo_stock_damage",
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
    return authenticatedRpc(
        "get_stock_damages",
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
