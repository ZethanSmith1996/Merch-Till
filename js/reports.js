import { state } from "./state.js";
import { dom } from "./dom.js";
import { currencyFormatter } from "./config.js";
import { escapeHTML } from "./utils.js";

let reportMode = "all";
let activeSessionId = "all";
let rangeStart = null;
let rangeEnd = null;
let transactionsVisible = false;
let expandedTransactionId = null;

function localDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatDisplayDate(dateString) {
    return new Date(`${dateString}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric"
    });
}

function formatTime(isoString) {
    if (!isoString) {
        return "Open";
    }

    return new Date(isoString).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function salesInRange() {
    const start = rangeStart || localDate();
    const end = rangeEnd || start;

    return state.sales.filter(function (sale) {
        return sale.date >= start && sale.date <= end;
    });
}

function sessionsInRange() {
    const start = rangeStart || localDate();
    const end = rangeEnd || start;

    return state.sessions
        .filter(function (session) {
            const openedDate = localDate(new Date(session.openedAt));
            return openedDate >= start && openedDate <= end;
        })
        .sort(function (first, second) {
            return first.openedAt.localeCompare(second.openedAt);
        });
}

function selectedSales() {
    const sales = salesInRange();

    if (reportMode === "all" || activeSessionId === "all") {
        return sales;
    }

    return sales.filter(function (sale) {
        return String(sale.sessionId) === String(activeSessionId);
    });
}

function updateActivePeriodHeading() {
    const heading = document.getElementById("report-active-period");
    const subheading = document.getElementById("report-active-view");

    if (!heading || !subheading) {
        return;
    }

    if (rangeStart === rangeEnd) {
        heading.textContent = formatDisplayDate(rangeStart);
    } else {
        heading.textContent =
            `${formatDisplayDate(rangeStart)} – ${formatDisplayDate(rangeEnd)}`;
    }

    if (reportMode === "all" || activeSessionId === "all") {
        subheading.textContent = "All Sessions";
        return;
    }

    const sessions = sessionsInRange();
    const selectedIndex = sessions.findIndex(function (session) {
        return String(session.id) === String(activeSessionId);
    });

    const selectedSession = sessions[selectedIndex];

    if (!selectedSession) {
        subheading.textContent = "By Session";
        return;
    }

    subheading.textContent =
        `Session ${selectedIndex + 1}: ` +
        `${formatTime(selectedSession.openedAt)}–${formatTime(selectedSession.closedAt)}`;
}

function updateModeButtons() {
    const allButton = document.getElementById("all-sessions-report-button");
    const bySessionButton = document.getElementById("by-session-report-button");

    if (!allButton || !bySessionButton) {
        return;
    }

    allButton.classList.toggle("active", reportMode === "all");
    bySessionButton.classList.toggle("active", reportMode === "session");
}

function renderSessionButtons() {
    dom.reportSessionButtons.innerHTML = "";
    dom.reportSessionButtons.hidden = reportMode !== "session";

    if (reportMode !== "session") {
        return;
    }

    const sessions = sessionsInRange();

    if (sessions.length === 0) {
        dom.reportSessionButtons.innerHTML =
            '<p class="report-empty">No trading sessions were found for this period.</p>';
        return;
    }

    sessions.forEach(function (session, index) {
        const sessionSales = state.sales.filter(function (sale) {
            return String(sale.sessionId) === String(session.id);
        });

        const revenue = sessionSales.reduce(function (sum, sale) {
            return sum + sale.total;
        }, 0);

        const items = sessionSales.reduce(function (sum, sale) {
            return sum + sale.itemCount;
        }, 0);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-summary-button";
        button.classList.toggle(
            "active",
            String(activeSessionId) === String(session.id)
        );

        const status = session.status === "open" ? "Current" : "Closed";

        button.innerHTML = `
            <span class="session-summary-number">${index + 1}</span>
            <span class="session-summary-title">Session ${index + 1}</span>
            <span class="session-summary-status">${status}</span>
            <span class="session-summary-time">
                ${formatTime(session.openedAt)}–${formatTime(session.closedAt)}
            </span>
            <strong>${currencyFormatter.format(revenue)}</strong>
            <span>${items} item${items === 1 ? "" : "s"}</span>
            <span>${sessionSales.length} transaction${sessionSales.length === 1 ? "" : "s"}</span>
        `;

        button.addEventListener("click", function () {
            activeSessionId = session.id;
            expandedTransactionId = null;
            renderReports();
        });

        dom.reportSessionButtons.appendChild(button);
    });
}

function renderProductsSold(sales) {
    const productMap = new Map();

    sales.forEach(function (sale) {
        sale.items.forEach(function (item) {
            const key = item.productId ?? item.name;
            const current = productMap.get(key) || {
                name: item.name,
                quantity: 0,
                value: 0
            };

            current.quantity += item.quantity;
            current.value += item.lineTotal;
            productMap.set(key, current);
        });
    });

    const rankedProducts = Array.from(productMap.values()).sort(
        function (first, second) {
            return (
                second.quantity - first.quantity ||
                first.name.localeCompare(second.name)
            );
        }
    );

    if (rankedProducts.length === 0) {
        dom.reportProductsSold.innerHTML =
            '<p class="report-empty">No products were sold in this period.</p>';
        return;
    }

    dom.reportProductsSold.innerHTML = rankedProducts
        .map(function (product, index) {
            return `
                <div class="report-product-row">
                    <span class="report-product-rank">${index + 1}</span>
                    <span class="report-product-name">${escapeHTML(product.name)}</span>
                    <strong>${product.quantity} sold</strong>
                    <span>${currencyFormatter.format(product.value)}</span>
                </div>
            `;
        })
        .join("");
}

function transactionKey(sale) {
    return String(sale.id ?? `${sale.sessionId}-${sale.orderNumber}-${sale.createdAt}`);
}

function renderTransactions(sales) {
    dom.reportTransactions.innerHTML = "";
    dom.reportTransactions.hidden = !transactionsVisible;
    dom.toggleTransactionsButton.textContent = transactionsVisible
        ? "Hide All Transactions"
        : "Show All Transactions";

    if (!transactionsVisible) {
        return;
    }

    const sortedSales = sales.slice().sort(function (first, second) {
        return second.createdAt.localeCompare(first.createdAt);
    });

    if (sortedSales.length === 0) {
        dom.reportTransactions.innerHTML =
            '<p class="report-empty">No transactions were recorded in this period.</p>';
        return;
    }

    sortedSales.forEach(function (sale) {
        const key = transactionKey(sale);
        const expanded = expandedTransactionId === key;
        const transaction = document.createElement("article");
        transaction.className = "report-transaction";

        const summary = document.createElement("button");
        summary.type = "button";
        summary.className = "transaction-summary";
        summary.setAttribute("aria-expanded", String(expanded));
        summary.innerHTML = `
            <span class="transaction-order">Order #${sale.orderNumber}</span>
            <span>${escapeHTML(sale.time)}</span>
            <span>${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}</span>
            <strong>${currencyFormatter.format(sale.total)}</strong>
            <span class="transaction-chevron">${expanded ? "⌃" : "⌄"}</span>
        `;

        const details = document.createElement("div");
        details.className = "transaction-details";
        details.hidden = !expanded;
        details.innerHTML = `
            <p class="transaction-user">
                Completed by: <strong>${escapeHTML(sale.completedBy || "Unknown")}</strong>
            </p>

            <div class="transaction-detail-headings">
                <span>Product</span>
                <span>Qty</span>
                <span>Unit Price</span>
                <span>Total</span>
            </div>

            ${sale.items
                .map(function (item) {
                    return `
                        <div class="transaction-line">
                            <span>${escapeHTML(item.name)}</span>
                            <span>${item.quantity}</span>
                            <span>${currencyFormatter.format(item.price)}</span>
                            <strong>${currencyFormatter.format(item.lineTotal)}</strong>
                        </div>
                    `;
                })
                .join("")}

            <div class="transaction-total">
                <span>Total</span>
                <strong>${currencyFormatter.format(sale.total)}</strong>
            </div>
        `;

        summary.addEventListener("click", function () {
            expandedTransactionId = expanded ? null : key;
            renderTransactions(sales);
        });

        transaction.append(summary, details);
        dom.reportTransactions.appendChild(transaction);
    });
}

export function renderReports() {
    updateModeButtons();
    updateActivePeriodHeading();
    renderSessionButtons();

    const sales = selectedSales();

    const revenue = sales.reduce(function (sum, sale) {
        return sum + sale.total;
    }, 0);

    const itemsSold = sales.reduce(function (sum, sale) {
        return sum + sale.itemCount;
    }, 0);

    dom.reportRevenue.textContent = currencyFormatter.format(revenue);
    dom.reportItemsSold.textContent = String(itemsSold);
    dom.reportTransactionsCount.textContent = String(sales.length);

    renderProductsSold(sales);
    renderTransactions(sales);
}

export function initialiseReports() {
    const today = localDate();
    rangeStart = today;
    rangeEnd = today;

    dom.reportStartDate.value = today;
    dom.reportEndDate.value = today;

    const allSessionsButton =
        document.getElementById("all-sessions-report-button");

    const bySessionButton =
        document.getElementById("by-session-report-button");

    allSessionsButton.addEventListener("click", function () {
        reportMode = "all";
        activeSessionId = "all";
        expandedTransactionId = null;
        renderReports();
    });

    bySessionButton.addEventListener("click", function () {
        reportMode = "session";

        const sessions = sessionsInRange();
        activeSessionId = sessions.length > 0 ? sessions[0].id : "all";
        expandedTransactionId = null;
        renderReports();
    });

    dom.todayReportButton.addEventListener("click", function () {
        const now = localDate();
        rangeStart = now;
        rangeEnd = now;
        dom.reportStartDate.value = now;
        dom.reportEndDate.value = now;
        reportMode = "all";
        activeSessionId = "all";
        expandedTransactionId = null;
        renderReports();
    });

    dom.applyReportRangeButton.addEventListener("click", function () {
        if (!dom.reportStartDate.value || !dom.reportEndDate.value) {
            return;
        }

        if (dom.reportStartDate.value > dom.reportEndDate.value) {
            window.alert("The start date must be before the end date.");
            return;
        }

        rangeStart = dom.reportStartDate.value;
        rangeEnd = dom.reportEndDate.value;
        reportMode = "all";
        activeSessionId = "all";
        expandedTransactionId = null;
        renderReports();
    });

    dom.toggleTransactionsButton.addEventListener("click", function () {
        transactionsVisible = !transactionsVisible;
        expandedTransactionId = null;
        renderReports();
    });

    document.addEventListener("sales-changed", renderReports);
    document.addEventListener("sessions-changed", renderReports);
}
