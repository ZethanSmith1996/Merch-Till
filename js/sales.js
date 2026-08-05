import { state } from "./state.js";

function getLocalDateParts(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

export function createSaleRecord(total) {
    const now = new Date();

    const items = Array.from(state.cart.values()).map(function (item) {
        return {
            productId: item.id,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            lineTotal: item.price * item.quantity
        };
    });

    const itemCount = items.reduce(function (sum, item) {
        return sum + item.quantity;
    }, 0);

    return {
        sessionId: state.currentSession.id,
        orderNumber: state.currentOrderNumber,
        date: getLocalDateParts(now),
        time: now.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }),
        createdAt: now.toISOString(),
        completedBy:
            sessionStorage.getItem("merchTillUsername") || "Unknown",
        total: total,
        itemCount: itemCount,
        items: items
    };
}
