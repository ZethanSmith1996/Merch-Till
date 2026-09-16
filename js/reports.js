import { state } from "./state.js";
import { dom } from "./dom.js";
import { currencyFormatter } from "./config.js";
import { announceProductsChanged, escapeHTML } from "./utils.js";
import { saveVoidedSaleTransaction } from "./database.js";
import { canViewReports } from "./permissions.js";
import { logAuditEvent, auditActorUsername } from "./audit-log.js?v=priority10c";
import { supabaseConfig } from "./config.js?v=step3b";
import { getValidCloudAccessToken } from "./auth.js?v=step3b";
import { getCurrentDepartment } from "./department-context.js?v=stage15f2";

let reportMode = "all";
let activeSessionId = "all";
let rangeStart = null;
let rangeEnd = null;
let transactionsVisible = false;
let expandedTransactionId = null;
let damageLogVisible = false;
let reportDamages = [];
let damageRequestSignature = "";
let damageRequestSequence = 0;

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

function countedSales(sales) {
    return sales.filter(function (sale) {
        return !sale.voided;
    });
}

function canVoidSale(sale) {
    return Boolean(
        canViewReports() &&
        !sale.voided
    );
}

async function voidSale(sale) {
    if (!canVoidSale(sale)) {
        window.alert(
            "Only an administrator can void a non-voided transaction."
        );
        return;
    }

    const shouldVoid = window.confirm(
        `Void Order #${sale.orderNumber}?\n\n` +
        "This will restore the sold items to stock and remove this transaction " +
        "from the reports and its original session totals. The transaction will remain visible as VOIDED."
    );

    if (!shouldVoid) {
        return;
    }

    const returnedQuantities = new Map();

    sale.items.forEach(function (item) {
        returnedQuantities.set(
            item.productId,
            (returnedQuantities.get(item.productId) || 0) + item.quantity
        );
    });

    const missingProduct = Array.from(returnedQuantities.keys()).find(
        function (productId) {
            return !state.products.some(function (product) {
                return product.id === productId;
            });
        }
    );

    if (missingProduct !== undefined) {
        window.alert(
            "This transaction cannot be voided because one of its products is no longer available in the current product list."
        );
        return;
    }

    const updatedProducts = state.products.map(function (product) {
        const quantityToRestore = returnedQuantities.get(product.id) || 0;

        if (quantityToRestore === 0) {
            return { ...product };
        }

        return {
            ...product,
            stock: product.stock + quantityToRestore
        };
    });

    const voidedSale = {
        ...sale,
        voided: true,
        voidedAt: new Date().toISOString(),
        voidedBy: sessionStorage.getItem("merchTillUsername") || "Unknown"
    };

    try {
        await saveVoidedSaleTransaction(voidedSale, updatedProducts);

        state.products = updatedProducts;
        state.sales = state.sales.map(function (storedSale) {
            return storedSale.id === voidedSale.id ? voidedSale : storedSale;
        });

        announceProductsChanged();
        document.dispatchEvent(new CustomEvent("sales-changed"));

        await logAuditEvent(
            "void",
            `${auditActorUsername()} voided Order #${sale.orderNumber} (${currencyFormatter.format(Number(sale.total) || 0)}).`,
            {
                sale_id: sale.id,
                order_number:
                    sale.orderNumber,
                total:
                    Number(sale.total) || 0
            },
            `void:${sale.id}`
        );

        window.alert(
            `Order #${sale.orderNumber} has been voided.\n\n` +
            "The stock has been restored and the transaction has been removed from the reports and its original session totals."
        );
    } catch (error) {
        console.error("The transaction could not be voided:", error);
        window.alert(
            "The transaction could not be voided. No stock or sales changes have been saved."
        );
    }
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

        const activeSessionSales = countedSales(sessionSales);

        const revenue = activeSessionSales.reduce(function (sum, sale) {
            return sum + sale.total;
        }, 0);

        const items = activeSessionSales.reduce(function (sum, sale) {
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
            <span>${activeSessionSales.length} transaction${activeSessionSales.length === 1 ? "" : "s"}</span>
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
            const grouped = Boolean(item.groupId);
            const key = grouped
                ? `group:${item.groupId}`
                : `product:${item.productId ?? item.name}`;

            const productName = item.productName || item.name;
            const current = productMap.get(key) || {
                name: productName,
                quantity: 0,
                value: 0,
                variants: new Map()
            };

            current.quantity += item.quantity;
            current.value += item.lineTotal;

            if (item.variantName) {
                current.variants.set(
                    item.variantName,
                    (current.variants.get(item.variantName) || 0) + item.quantity
                );
            }

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
            const variantBreakdown = Array.from(product.variants.entries())
                .map(function ([name, quantity]) {
                    return `${escapeHTML(name)} ${quantity}`;
                })
                .join(" · ");

            return `
                <div class="report-product-row">
                    <span class="report-product-rank">${index + 1}</span>
                    <span class="report-product-name">
                        ${escapeHTML(product.name)}
                        ${variantBreakdown
                            ? `<small class="report-variant-breakdown">${variantBreakdown}</small>`
                            : ""}
                    </span>
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
        transaction.classList.toggle("voided-transaction", Boolean(sale.voided));

        const summary = document.createElement("button");
        summary.type = "button";
        summary.className = "transaction-summary";
        summary.setAttribute("aria-expanded", String(expanded));
        summary.innerHTML = `
            <span class="transaction-order">Order #${sale.orderNumber}</span>
            <span>${escapeHTML(sale.time)}</span>
            <span>${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}</span>
            <strong>${currencyFormatter.format(sale.total)}</strong>
            ${sale.voided ? '<span class="transaction-status-badge">VOIDED</span>' : ""}
            <span class="transaction-chevron">${expanded ? "⌃" : "⌄"}</span>
        `;

        const details = document.createElement("div");
        details.className = "transaction-details";
        details.hidden = !expanded;
        details.innerHTML = `
            <p class="transaction-user">
                Completed by: <strong>${escapeHTML(sale.completedBy || "Unknown")}</strong>
            </p>

            ${sale.paymentMethod
                ? `<p class="transaction-payment">
                    Payment:
                    <strong>${
                        sale.paymentMethod === "split"
                            ? `${currencyFormatter.format(Number(sale.cashAmount) || 0)} Cash + ${currencyFormatter.format(Number(sale.cardAmount) || 0)} Card`
                            : sale.paymentMethod === "cash"
                                ? "Cash"
                                : "Card"
                    }</strong>
                    ${
                        Number(sale.changeDue || 0) > 0
                            ? ` · Change ${currencyFormatter.format(Number(sale.changeDue) || 0)}`
                            : ""
                    }
                   </p>`
                : ""}

            ${sale.voided
                ? `<p class="transaction-void-notice">
                    <strong>VOIDED</strong>
                    ${sale.voidedBy ? ` by ${escapeHTML(sale.voidedBy)}` : ""}
                    ${sale.voidedAt ? ` at ${escapeHTML(formatTime(sale.voidedAt))}` : ""}
                   </p>`
                : ""}

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

            ${Number(sale.discountAmount || 0) > 0
                ? `<div class="transaction-total transaction-subtotal">
                    <span>Subtotal</span>
                    <strong>${currencyFormatter.format(sale.subtotal ?? (sale.total + Number(sale.discountAmount || 0)))}</strong>
                   </div>
                   <div class="transaction-total transaction-discount-total">
                    <span>Discount (${Number(sale.discountPercent || 0)}%)</span>
                    <strong>-${currencyFormatter.format(Number(sale.discountAmount || 0))}</strong>
                   </div>
                   ${sale.discountAuthorizedBy
                        ? `<p class="transaction-discount-authoriser">Discount authorised by: <strong>${escapeHTML(sale.discountAuthorizedBy)}</strong></p>`
                        : ""}`
                : ""}

            <div class="transaction-total">
                <span>Money Taken</span>
                <strong>${currencyFormatter.format(sale.total)}</strong>
            </div>
        `;

        if (canVoidSale(sale)) {
            const actions = document.createElement("div");
            actions.className = "transaction-actions";

            const voidButton = document.createElement("button");
            voidButton.type = "button";
            voidButton.className = "void-transaction-button";
            voidButton.textContent = "Void Transaction";
            voidButton.addEventListener("click", function () {
                voidSale(sale);
            });

            actions.appendChild(voidButton);
            details.appendChild(actions);
        }

        summary.addEventListener("click", function () {
            expandedTransactionId = expanded ? null : key;
            renderTransactions(sales);
        });

        transaction.append(summary, details);
        dom.reportTransactions.appendChild(transaction);
    });
}


async function damageReportRpc(name, body) {
    if (!navigator.onLine) {
        throw new Error("Damage reporting requires an internet connection.");
    }

    const token = await getValidCloudAccessToken();

    if (!token) {
        throw new Error("No valid cloud session is available.");
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/rpc/${name}`,
        {
            method: "POST",
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    const text = await response.text();
    let data = null;

    if (text) {
        try { data = JSON.parse(text); }
        catch (_) { data = text; }
    }

    if (!response.ok) {
        throw new Error(
            data?.message || data?.error ||
            (typeof data === "string" ? data : "") ||
            `Damage request failed (${response.status}).`
        );
    }

    return data;
}

function renderProductsDamaged() {
    if (!dom.reportProductsDamaged) return;

    const totals = new Map();

    reportDamages
        .filter(damage => !damage.undone_at)
        .forEach(function (damage) {
            const key = `${damage.product_id}:${damage.variant_name || ""}`;

            if (!totals.has(key)) {
                totals.set(key, {
                    name: damage.product_name,
                    variant: damage.variant_name,
                    quantity: 0
                });
            }

            totals.get(key).quantity += Number(damage.quantity) || 0;
        });

    const rows = Array.from(totals.values()).sort(function (a, b) {
        return b.quantity - a.quantity || a.name.localeCompare(b.name);
    });

    if (!rows.length) {
        dom.reportProductsDamaged.innerHTML =
            '<p class="report-empty">No damaged products were recorded in this period.</p>';
        return;
    }

    dom.reportProductsDamaged.innerHTML = rows.map(function (row, index) {
        return `
            <div class="report-product-row">
                <span class="report-product-rank">${index + 1}</span>
                <span class="report-product-name">
                    ${escapeHTML(row.name)}
                    ${row.variant ? `<small class="report-variant-breakdown">${escapeHTML(row.variant)}</small>` : ""}
                </span>
                <strong>${row.quantity} damaged</strong>
                <span></span>
            </div>
        `;
    }).join("");
}

async function undoDamageFromReport(damage) {
    const reason = window.prompt(
        `Undo this damage record and restore ${damage.quantity} × ${damage.product_name} to stock?\n\nOptional reason for reversal:`,
        ""
    );

    if (reason === null) return;

    try {
        const undoResult =
            await damageReportRpc(
                "undo_stock_damage",
                {
                    p_damage_id:
                        Number(damage.id),
                    p_reason:
                        reason.trim() || null
                }
            );

        /*
         * The RPC restores the stock in Supabase. Keep the Till's in-memory
         * product cache in sync immediately as well. V24.4 previously only
         * announced a product change, which re-rendered the stale local stock
         * value and made a successful undo look as though stock had not been
         * restored.
         */
        const product =
            state.products.find(
                item =>
                    String(item.id) ===
                    String(damage.product_id)
            );

        if (product) {
            const returnedStock =
                Array.isArray(undoResult)
                    ? undoResult[0]?.new_stock
                    : undoResult?.new_stock;

            if (
                returnedStock !== undefined &&
                returnedStock !== null &&
                Number.isFinite(
                    Number(returnedStock)
                )
            ) {
                product.stock =
                    Number(returnedStock);
            } else {
                product.stock =
                    Number(product.stock || 0) +
                    Number(damage.quantity || 0);
            }
        }

        damageRequestSignature = "";
        await loadReportDamages();
        announceProductsChanged();

    } catch (error) {
        window.alert(
            "The damage record could not be undone.\n\n" +
            (error instanceof Error ? error.message : String(error))
        );
    }
}

function renderDamageLog() {
    if (!dom.reportDamageLog) return;

    dom.reportDamageLog.hidden = !damageLogVisible;
    dom.toggleDamageLogButton.textContent =
        damageLogVisible ? "Hide Damage Log" : "Show Damage Log";

    if (!damageLogVisible) return;

    if (!reportDamages.length) {
        dom.reportDamageLog.innerHTML =
            '<p class="report-empty">No damage records were recorded in this period.</p>';
        return;
    }

    dom.reportDamageLog.innerHTML = "";

    reportDamages.forEach(function (damage) {
        const article = document.createElement("article");
        article.className = "report-transaction damage-log-entry";

        if (damage.undone_at) {
            article.classList.add("voided-transaction");
        }

        const created = new Date(damage.created_at);

        article.innerHTML = `
            <div class="transaction-summary damage-summary-static">
                <span class="transaction-order">
                    ${escapeHTML(damage.product_name)}
                    ${damage.variant_name ? ` — ${escapeHTML(damage.variant_name)}` : ""}
                </span>
                <span>
                    ${created.toLocaleDateString("en-GB")} ·
                    ${created.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit"})}
                </span>
                <span>${Number(damage.quantity) || 0} damaged</span>
                <strong>${escapeHTML(damage.recorded_by_username || "Unknown")}</strong>
                ${damage.undone_at ? '<span class="transaction-status-badge">UNDONE</span>' : ""}
            </div>
            <div class="transaction-details damage-log-details">
                <p>Reason: <strong>${escapeHTML(damage.reason || "No reason recorded")}</strong></p>
                ${damage.undone_at ? `
                    <p class="transaction-void-notice">
                        Restored by <strong>${escapeHTML(damage.undone_by_username || "Unknown")}</strong>
                        on ${escapeHTML(new Date(damage.undone_at).toLocaleString("en-GB"))}
                        ${damage.undo_reason ? ` · ${escapeHTML(damage.undo_reason)}` : ""}
                    </p>
                ` : ""}
            </div>
        `;

        if (!damage.undone_at) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "void-transaction-button";
            button.textContent = "Undo Damage";
            button.addEventListener("click", function () {
                undoDamageFromReport(damage);
            });
            article.querySelector(".damage-log-details")?.appendChild(button);
        }

        dom.reportDamageLog.appendChild(article);
    });
}

function renderDamageReports() {
    renderProductsDamaged();
    renderDamageLog();
}

async function loadReportDamages() {
    if (!canViewReports()) {
        reportDamages = [];
        renderDamageReports();
        return;
    }

    const departmentId = Number(getCurrentDepartment()?.id || 1);
    const start = rangeStart || localDate();
    const end = rangeEnd || start;
    const sessionId =
        reportMode === "all" || activeSessionId === "all"
            ? null
            : activeSessionId;

    const signature = [departmentId, start, end, sessionId || "all"].join("|");

    if (signature === damageRequestSignature) {
        renderDamageReports();
        return;
    }

    damageRequestSignature = signature;
    const sequence = ++damageRequestSequence;

    try {
        /*
         * Fetch the department's complete damage history and apply the
         * Reports period/session filter in the browser. This avoids date
         * boundary/time-zone differences between PostgreSQL timestamptz
         * and the Till's local reporting dates.
         */
        const rows = await damageReportRpc("get_stock_damages", {
            p_department_id: departmentId,
            p_from: null,
            p_to: null,
            p_session_id: null,
            p_production_id: null
        });

        if (sequence !== damageRequestSequence) return;

        const allRows =
            Array.isArray(rows)
                ? rows
                : [];

        reportDamages =
            allRows.filter(function (damage) {
                const createdDate =
                    localDate(
                        new Date(
                            damage.created_at
                        )
                    );

                const inDateRange =
                    createdDate >= start &&
                    createdDate <= end;

                const inSession =
                    !sessionId ||
                    String(
                        damage.session_id
                    ) === String(
                        sessionId
                    );

                return (
                    inDateRange &&
                    inSession
                );
            });

        if (dom.reportProductsDamaged) {
            dom.reportProductsDamaged.dataset.loadError = "";
        }

    } catch (error) {
        console.error("Damage report could not be loaded:", error);
        reportDamages = [];

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        if (dom.reportProductsDamaged) {
            dom.reportProductsDamaged.innerHTML =
                `<p class="form-error">Damage records could not be loaded: ${escapeHTML(message)}</p>`;
            dom.reportProductsDamaged.dataset.loadError = "true";
        }

        if (dom.reportDamageLog) {
            dom.reportDamageLog.innerHTML =
                `<p class="form-error">Damage records could not be loaded: ${escapeHTML(message)}</p>`;
        }

        return;
    }

    renderDamageReports();
}


export function renderReports() {
    updateModeButtons();
    updateActivePeriodHeading();
    renderSessionButtons();

    const sales = selectedSales();
    const activeSales = countedSales(sales);

    const revenue = activeSales.reduce(function (sum, sale) {
        return sum + sale.total;
    }, 0);

    const discounts = activeSales.reduce(function (sum, sale) {
        return sum + Number(sale.discountAmount || 0);
    }, 0);

    function paymentAmountsForSale(sale) {
        let cash =
            Number(sale.cashAmount || 0);

        let card =
            Number(sale.cardAmount || 0);

        const recordedPayments =
            Array.isArray(sale.payments)
                ? sale.payments
                : [];

        /*
         * Fallback for any sale/cache version where the aggregate payment
         * fields are absent but the individual payment lines are present.
         */
        if (
            cash === 0 &&
            card === 0 &&
            recordedPayments.length > 0
        ) {
            recordedPayments.forEach(
                function (payment) {
                    const amount =
                        Number(payment.amount || 0);

                    if (
                        payment.method ===
                        "cash"
                    ) {
                        cash += amount;
                    }

                    if (
                        payment.method ===
                        "card"
                    ) {
                        card += amount;
                    }
                }
            );
        }

        return {
            cash,
            card,
            hasPaymentData:
                cash > 0 ||
                card > 0 ||
                recordedPayments.length > 0 ||
                ["cash", "card", "split"].includes(
                    String(
                        sale.paymentMethod || ""
                    ).toLowerCase()
                )
        };
    }

    const paymentSummary =
        activeSales.reduce(
            function (summary, sale) {
                const payment =
                    paymentAmountsForSale(
                        sale
                    );

                summary.cash +=
                    payment.cash;

                summary.card +=
                    payment.card;

                if (
                    payment.hasPaymentData
                ) {
                    summary.hasPaymentData =
                        true;
                }

                return summary;
            },
            {
                cash: 0,
                card: 0,
                hasPaymentData: false
            }
        );

    const hasPaymentData =
        paymentSummary.hasPaymentData;

    const cashTaken =
        paymentSummary.cash;

    const cardTaken =
        paymentSummary.card;

    const itemsSold = activeSales.reduce(function (sum, sale) {
        return sum + sale.itemCount;
    }, 0);

    dom.reportRevenue.textContent = currencyFormatter.format(revenue);

    if (dom.reportPaymentBreakdown) {
        dom.reportPaymentBreakdown.innerHTML =
            hasPaymentData
                ? `
                    <span>
                        Cash:
                        <strong>${currencyFormatter.format(cashTaken)}</strong>
                    </span>

                    <span>
                        Card:
                        <strong>${currencyFormatter.format(cardTaken)}</strong>
                    </span>
                  `
                : "";
    }

    dom.reportDiscounts.textContent = currencyFormatter.format(discounts);
    dom.reportItemsSold.textContent = String(itemsSold);
    dom.reportTransactionsCount.textContent = String(activeSales.length);

    renderProductsSold(activeSales);
    renderTransactions(sales);
    loadReportDamages();
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

    dom.toggleDamageLogButton?.addEventListener("click", function () {
        damageLogVisible = !damageLogVisible;
        renderDamageLog();
    });

    document.addEventListener("sales-changed", renderReports);
    document.addEventListener("sessions-changed", renderReports);
}
