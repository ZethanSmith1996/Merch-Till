import { dom } from "./dom.js";
import { supabaseConfig, currencyFormatter } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";
import { canManageArchive } from "./permissions.js";
import { escapeHTML } from "./utils.js";

const DEPARTMENT_KEY = "merch";

let productions = [];
let unassignedSessions = [];
let expandedProductionId = null;
let archiveRefreshTimer = null;

let sessionAssignmentProduction = null;
let sessionAssignmentEligibleSessions = [];

const productionReportCache = new Map();
const productionReportFilters = new Map();
const expandedTransactionIds = new Set();


function setArchiveStatus(
    message,
    isError = false
) {
    if (!dom.archiveStatus) {
        return;
    }

    dom.archiveStatus.textContent =
        message;

    dom.archiveStatus.classList.toggle(
        "cloud-upload-error",
        isError
    );
}


async function archiveRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "Archive requires an internet connection."
        );
    }

    const token =
        await getValidCloudAccessToken();

    if (!token) {
        throw new Error(
            "No valid cloud session is available. Log out and log back in while online."
        );
    }

    const response =
        await fetch(
            `${supabaseConfig.url}/rest/v1/${path}`,
            {
                ...options,
                headers: {
                    "apikey":
                        supabaseConfig.publishableKey,
                    "Authorization":
                        `Bearer ${token}`,
                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Archive request failed (${response.status}). ${details}`
        );
    }

    return response;
}


function localDateValue(value) {
    if (!value) {
        return "";
    }

    return String(value)
        .slice(0, 10);
}


function displayDate(value) {
    if (!value) {
        return "—";
    }

    const date =
        new Date(
            `${localDateValue(value)}T12:00:00`
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return value;
    }

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    ).format(date);
}


function statusLabel(status) {
    switch (status) {
        case "upcoming":
            return "Upcoming";

        case "active":
            return "Active";

        case "finished":
            return "Finished";

        default:
            return status || "Unknown";
    }
}


function closeDateDisplay(production) {
    /*
     * auto_close_date is exclusive, so the last selling day is the previous
     * calendar date. The UI says "Run" and displays the actual selling period.
     */
    if (!production.auto_close_date) {
        return "—";
    }

    const date =
        new Date(
            `${production.auto_close_date}T12:00:00`
        );

    date.setDate(
        date.getDate() - 1
    );

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    ).format(date);
}


function sessionDate(session) {
    return localDateValue(
        session.opened_at
    );
}


function eligibleUnassignedSessions(
    production
) {
    return unassignedSessions.filter(
        function (session) {
            const date =
                sessionDate(
                    session
                );

            return (
                date >=
                    production.startDate &&
                date <
                    production.autoCloseDate
            );
        }
    );
}


function sessionTime(value) {
    if (!value) {
        return "—";
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "—";
    }

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }
    ).format(date);
}


function normaliseProduction(row) {
    return {
        id: Number(row.id),
        departmentKey:
            row.department_key ||
            DEPARTMENT_KEY,
        name:
            row.name || "",
        description:
            row.description || "",
        startDate:
            row.start_date || "",
        autoCloseDate:
            row.auto_close_date || "",
        status:
            row.status || "finished",
        manuallyClosedAt:
            row.manually_closed_at ||
            null,
        sessionCount:
            Number(row.session_count) || 0,
        moneyTaken:
            Number(row.money_taken) || 0,
        productsSold:
            Number(row.products_sold) || 0,
        productCount:
            Number(row.product_count) || 0
    };
}


async function loadArchiveData({
    silent = false
} = {}) {
    if (!canManageArchive()) {
        return;
    }

    if (!navigator.onLine) {
        setArchiveStatus(
            "Archive is unavailable offline.",
            true
        );
        return;
    }

    if (!silent) {
        setArchiveStatus(
            "Loading Archive…"
        );
    }

    try {
        const [productionResponse, unassignedResponse] =
            await Promise.all([
                archiveRequest(
                    "rpc/get_archive_productions",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                            "Accept":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                p_department_key:
                                    DEPARTMENT_KEY
                            })
                    }
                ),

                archiveRequest(
                    "rpc/get_unassigned_sessions",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                            "Accept":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                p_department_key:
                                    DEPARTMENT_KEY
                            })
                    }
                )
            ]);

        productions =
            (await productionResponse.json())
                .map(normaliseProduction);

        unassignedSessions =
            await unassignedResponse.json();

        applyArchiveFilters();
        renderUnassignedBanner();

        if (!silent) {
            setArchiveStatus(
                "Archive is up to date."
            );
        }

    } catch (error) {
        console.error(
            "Archive could not be loaded:",
            error
        );

        setArchiveStatus(
            error instanceof Error
                ? error.message
                : String(error),
            true
        );
    }
}


function renderUnassignedBanner() {
    if (
        !dom.archiveUnassignedBanner ||
        !dom.archiveUnassignedCount
    ) {
        return;
    }

    const count =
        Array.isArray(unassignedSessions)
            ? unassignedSessions.length
            : 0;

    dom.archiveUnassignedBanner.hidden =
        count === 0;

    dom.archiveUnassignedCount.textContent =
        `${count} unassigned session${count === 1 ? "" : "s"}`;
}


function filteredProductions() {
    const from =
        dom.archiveFromDate?.value || "";

    const to =
        dom.archiveToDate?.value || "";

    const status =
        dom.archiveStatusFilter?.value || "";

    const search =
        (
            dom.archiveSearch?.value || ""
        )
            .trim()
            .toLowerCase();

    const sort =
        dom.archiveSortOrder?.value ||
        "newest";

    const result =
        productions.filter(
            function (production) {
                /*
                 * A Production overlaps the date filter when its run intersects
                 * the selected range.
                 */
                if (
                    from &&
                    production.autoCloseDate &&
                    production.autoCloseDate <=
                        from
                ) {
                    return false;
                }

                if (
                    to &&
                    production.startDate >
                        to
                ) {
                    return false;
                }

                if (
                    status &&
                    production.status !==
                        status
                ) {
                    return false;
                }

                if (search) {
                    const haystack =
                        [
                            production.name,
                            production.description,
                            production.status
                        ]
                            .join(" ")
                            .toLowerCase();

                    if (
                        !haystack.includes(
                            search
                        )
                    ) {
                        return false;
                    }
                }

                return true;
            }
        );

    result.sort(
        function (first, second) {
            return (
                sort === "oldest"
                    ? first.startDate.localeCompare(
                        second.startDate
                    )
                    : second.startDate.localeCompare(
                        first.startDate
                    )
            );
        }
    );

    return result;
}


function reportFilterFor(production) {
    if (
        !productionReportFilters.has(
            production.id
        )
    ) {
        productionReportFilters.set(
            production.id,
            {
                from:
                    production.startDate,
                to:
                    production.autoCloseDate
                        ? localDateValue(
                            new Date(
                                new Date(
                                    `${production.autoCloseDate}T12:00:00`
                                ).getTime() -
                                86400000
                            )
                        )
                        : "",
                sessionId: "all"
            }
        );
    }

    return productionReportFilters.get(
        production.id
    );
}


function normaliseReportSale(row) {
    return {
        id: Number(row.id),
        sessionId:
            row.session_id === null ||
            row.session_id === undefined
                ? null
                : Number(row.session_id),
        orderNumber:
            Number(row.order_number) || 0,
        date:
            row.sale_date || "",
        time:
            row.sale_time || "",
        createdAt:
            row.created_at || null,
        completedBy:
            row.completed_by || "Unknown",
        subtotal:
            Number(row.subtotal) || 0,
        discountPercent:
            Number(row.discount_percent) || 0,
        discountAmount:
            Number(row.discount_amount) || 0,
        discountAuthorizedBy:
            row.discount_authorized_by || null,
        total:
            Number(row.total) || 0,
        itemCount:
            Number(row.item_count) || 0,
        items:
            Array.isArray(row.items)
                ? row.items
                : [],
        paymentMethod:
            row.payment_method || null,
        cashAmount:
            Number(row.cash_amount) || 0,
        cardAmount:
            Number(row.card_amount) || 0,
        changeDue:
            Number(row.change_due) || 0,
        payments:
            Array.isArray(row.payments)
                ? row.payments
                : [],
        voided:
            Boolean(row.voided),
        voidedAt:
            row.voided_at || null,
        voidedBy:
            row.voided_by || null
    };
}


function normaliseReportSession(row) {
    return {
        id: Number(row.id),
        openedAt:
            row.opened_at || null,
        closedAt:
            row.closed_at || null,
        openedBy:
            row.opened_by || null,
        closedBy:
            row.closed_by || null,
        status:
            row.status || "closed"
    };
}


function paymentSummaryForSale(sale) {
    let cash =
        Number(sale.cashAmount || 0);

    let card =
        Number(sale.cardAmount || 0);

    if (
        cash === 0 &&
        card === 0 &&
        Array.isArray(sale.payments)
    ) {
        sale.payments.forEach(
            function (payment) {
                const amount =
                    Number(
                        payment.amount || 0
                    );

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
        hasData:
            cash > 0 ||
            card > 0 ||
            ["cash", "card", "split"].includes(
                String(
                    sale.paymentMethod || ""
                ).toLowerCase()
            ) ||
            (
                Array.isArray(sale.payments) &&
                sale.payments.length > 0
            )
    };
}


function reportSalesFor(
    production,
    reportData
) {
    const filter =
        reportFilterFor(
            production
        );

    return reportData.sales.filter(
        function (sale) {
            if (
                filter.from &&
                sale.date <
                    filter.from
            ) {
                return false;
            }

            if (
                filter.to &&
                sale.date >
                    filter.to
            ) {
                return false;
            }

            if (
                filter.sessionId !==
                    "all" &&
                String(sale.sessionId) !==
                    String(filter.sessionId)
            ) {
                return false;
            }

            return true;
        }
    );
}


function reportProductsSold(activeSales) {
    const totals =
        new Map();

    activeSales.forEach(
        function (sale) {
            sale.items.forEach(
                function (item) {
                    const name =
                        item.name ||
                        item.productName ||
                        "Unknown Product";

                    const quantity =
                        Number(
                            item.quantity || 0
                        );

                    totals.set(
                        name,
                        (
                            totals.get(name) ||
                            0
                        ) + quantity
                    );
                }
            );
        }
    );

    return Array.from(
        totals.entries()
    ).sort(
        function (a, b) {
            return (
                b[1] - a[1] ||
                a[0].localeCompare(b[0])
            );
        }
    );
}


function transactionDateTime(sale) {
    if (
        sale.date &&
        sale.time
    ) {
        return `${displayDate(sale.date)} · ${escapeHTML(sale.time)}`;
    }

    if (sale.createdAt) {
        const date =
            new Date(
                sale.createdAt
            );

        return new Intl.DateTimeFormat(
            "en-GB",
            {
                dateStyle: "medium",
                timeStyle: "medium"
            }
        ).format(date);
    }

    return "Date unavailable";
}


function renderArchiveTransaction(
    sale
) {
    const expanded =
        expandedTransactionIds.has(
            sale.id
        );

    const payment =
        paymentSummaryForSale(
            sale
        );

    const paymentText =
        sale.paymentMethod === "split"
            ? `${currencyFormatter.format(payment.cash)} Cash + ${currencyFormatter.format(payment.card)} Card`
            : sale.paymentMethod === "cash"
                ? "Cash"
                : sale.paymentMethod === "card"
                    ? "Card"
                    : "";

    const items =
        sale.items.map(
            function (item) {
                return `
                    <div class="archive-report-item-row">
                        <span>
                            ${escapeHTML(item.name || item.productName || "Unknown Product")}
                            × ${Number(item.quantity) || 0}
                        </span>

                        <strong>
                            ${currencyFormatter.format(Number(item.lineTotal) || ((Number(item.price) || 0) * (Number(item.quantity) || 0)))}
                        </strong>
                    </div>
                `;
            }
        ).join("");

    return `
        <article class="archive-report-transaction ${sale.voided ? "voided" : ""}">
            <button
                type="button"
                class="archive-report-transaction-summary"
                data-archive-transaction-id="${sale.id}"
                aria-expanded="${expanded}"
            >
                <span>
                    <strong>Order #${sale.orderNumber}</strong>
                    <small>${transactionDateTime(sale)}</small>
                </span>

                <span>
                    ${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}
                </span>

                <strong>
                    ${currencyFormatter.format(sale.total)}
                </strong>

                <span>
                    ${sale.voided ? "VOID" : expanded ? "⌃" : "⌄"}
                </span>
            </button>

            <div
                class="archive-report-transaction-details"
                ${expanded ? "" : "hidden"}
            >
                ${items}

                <div class="archive-report-transaction-meta">
                    <span>
                        Completed by:
                        <strong>${escapeHTML(sale.completedBy)}</strong>
                    </span>

                    ${
                        sale.discountAmount > 0
                            ? `<span>
                                Discount:
                                <strong>${sale.discountPercent}% (${currencyFormatter.format(sale.discountAmount)})</strong>
                                ${
                                    sale.discountAuthorizedBy
                                        ? ` · ${escapeHTML(sale.discountAuthorizedBy)}`
                                        : ""
                                }
                               </span>`
                            : ""
                    }

                    ${
                        payment.hasData
                            ? `<span>
                                Payment:
                                <strong>${escapeHTML(paymentText || "Recorded")}</strong>
                                ${
                                    sale.changeDue > 0
                                        ? ` · Change ${currencyFormatter.format(sale.changeDue)}`
                                        : ""
                                }
                               </span>`
                            : ""
                    }

                    ${
                        sale.voided
                            ? `<span class="archive-report-void-meta">
                                Voided
                                ${
                                    sale.voidedBy
                                        ? ` by <strong>${escapeHTML(sale.voidedBy)}</strong>`
                                        : ""
                                }
                                ${
                                    sale.voidedAt
                                        ? ` · ${escapeHTML(new Date(sale.voidedAt).toLocaleString("en-GB"))}`
                                        : ""
                                }
                               </span>`
                            : ""
                    }
                </div>
            </div>
        </article>
    `;
}


function renderProductionReport(
    production
) {
    const host =
        document.querySelector(
            `[data-production-report="${production.id}"]`
        );

    if (!host) {
        return;
    }

    const cached =
        productionReportCache.get(
            production.id
        );

    if (!cached) {
        host.innerHTML =
            '<div class="archive-report-loading">Loading Production report…</div>';

        loadProductionReport(
            production
        );

        return;
    }

    if (cached.error) {
        host.innerHTML = `
            <div class="archive-report-error">
                ${escapeHTML(cached.error)}
            </div>
        `;
        return;
    }

    const reportData =
        cached.data;

    const filter =
        reportFilterFor(
            production
        );

    const selectedSales =
        reportSalesFor(
            production,
            reportData
        );

    const activeSales =
        selectedSales.filter(
            function (sale) {
                return !sale.voided;
            }
        );

    const revenue =
        activeSales.reduce(
            function (sum, sale) {
                return sum + sale.total;
            },
            0
        );

    const discounts =
        activeSales.reduce(
            function (sum, sale) {
                return (
                    sum +
                    sale.discountAmount
                );
            },
            0
        );

    const itemsSold =
        activeSales.reduce(
            function (sum, sale) {
                return (
                    sum +
                    sale.itemCount
                );
            },
            0
        );

    const payment =
        activeSales.reduce(
            function (summary, sale) {
                const salePayment =
                    paymentSummaryForSale(
                        sale
                    );

                summary.cash +=
                    salePayment.cash;

                summary.card +=
                    salePayment.card;

                summary.hasData =
                    summary.hasData ||
                    salePayment.hasData;

                return summary;
            },
            {
                cash: 0,
                card: 0,
                hasData: false
            }
        );

    const products =
        reportProductsSold(
            activeSales
        );

    const sessionOptions =
        reportData.sessions
            .map(
                function (session) {
                    const date =
                        session.openedAt
                            ? displayDate(
                                session.openedAt
                            )
                            : "Unknown date";

                    const time =
                        session.openedAt
                            ? sessionTime(
                                session.openedAt
                            )
                            : "";

                    return `
                        <option
                            value="${session.id}"
                            ${
                                String(filter.sessionId) ===
                                String(session.id)
                                    ? "selected"
                                    : ""
                            }
                        >
                            ${escapeHTML(`${date}${time ? ` · ${time}` : ""}`)}
                        </option>
                    `;
                }
            )
            .join("");

    host.innerHTML = `
        <div class="archive-report-panel">

            <div class="archive-report-heading">
                <div>
                    <h4>Production Report</h4>
                    <p>
                        Historical reporting for ${escapeHTML(production.name)}.
                    </p>
                </div>

                <button
                    type="button"
                    class="secondary-button archive-report-entire-run"
                    data-report-entire-run="${production.id}"
                >
                    Entire Run
                </button>
            </div>


            <div class="archive-report-filters">

                <div class="form-group">
                    <label>
                        From
                    </label>

                    <input
                        type="date"
                        value="${escapeHTML(filter.from)}"
                        min="${escapeHTML(production.startDate)}"
                        max="${escapeHTML(filter.to || production.autoCloseDate)}"
                        data-report-from="${production.id}"
                    >
                </div>

                <div class="form-group">
                    <label>
                        To
                    </label>

                    <input
                        type="date"
                        value="${escapeHTML(filter.to)}"
                        min="${escapeHTML(production.startDate)}"
                        data-report-to="${production.id}"
                    >
                </div>

                <div class="form-group archive-report-session-filter">
                    <label>
                        Session
                    </label>

                    <select data-report-session="${production.id}">
                        <option value="all">
                            All Sessions
                        </option>

                        ${sessionOptions}
                    </select>
                </div>

            </div>


            <div class="report-summary-grid archive-report-summary-grid">

                <div class="report-card">
                    <span class="report-label">
                        Money Taken
                    </span>

                    <strong class="report-value">
                        ${currencyFormatter.format(revenue)}
                    </strong>

                    <div class="report-money-breakdown">
                        ${
                            payment.hasData
                                ? `
                                    <span>
                                        Cash:
                                        <strong>${currencyFormatter.format(payment.cash)}</strong>
                                    </span>

                                    <span>
                                        Card:
                                        <strong>${currencyFormatter.format(payment.card)}</strong>
                                    </span>
                                  `
                                : ""
                        }

                        <span class="report-discount-summary">
                            Discounts:
                            <strong>${currencyFormatter.format(discounts)}</strong>
                        </span>
                    </div>
                </div>


                <div class="report-card">
                    <span class="report-label">
                        Items Sold
                    </span>

                    <strong class="report-value">
                        ${itemsSold}
                    </strong>
                </div>


                <div class="report-card">
                    <span class="report-label">
                        Transactions
                    </span>

                    <strong class="report-value">
                        ${activeSales.length}
                    </strong>
                </div>

            </div>


            <div class="archive-report-products">
                <h4>Products Sold</h4>

                ${
                    products.length > 0
                        ? products.map(
                            function ([name, quantity]) {
                                return `
                                    <div class="archive-report-product-row">
                                        <span>${escapeHTML(name)}</span>
                                        <strong>${quantity}</strong>
                                    </div>
                                `;
                            }
                        ).join("")
                        : '<p class="archive-report-empty">No products were sold in this period.</p>'
                }
            </div>


            <div class="archive-report-transactions-heading">
                <h4>
                    Transactions
                </h4>

                <span>
                    ${selectedSales.length} shown
                </span>
            </div>

            <div class="archive-report-transactions">
                ${
                    selectedSales.length > 0
                        ? selectedSales
                            .slice()
                            .sort(
                                function (a, b) {
                                    return (
                                        String(b.createdAt || `${b.date} ${b.time}`)
                                            .localeCompare(
                                                String(a.createdAt || `${a.date} ${a.time}`)
                                            )
                                    );
                                }
                            )
                            .map(
                                renderArchiveTransaction
                            )
                            .join("")
                        : '<p class="archive-report-empty">No transactions match this report filter.</p>'
                }
            </div>

        </div>
    `;

    bindProductionReportControls(
        production
    );
}


function bindProductionReportControls(
    production
) {
    const from =
        document.querySelector(
            `[data-report-from="${production.id}"]`
        );

    const to =
        document.querySelector(
            `[data-report-to="${production.id}"]`
        );

    const session =
        document.querySelector(
            `[data-report-session="${production.id}"]`
        );

    const entireRun =
        document.querySelector(
            `[data-report-entire-run="${production.id}"]`
        );

    const filter =
        reportFilterFor(
            production
        );

    from?.addEventListener(
        "change",
        function () {
            filter.from =
                from.value;

            if (
                filter.to &&
                filter.from >
                    filter.to
            ) {
                filter.to =
                    filter.from;
            }

            filter.sessionId =
                "all";

            renderProductionReport(
                production
            );
        }
    );

    to?.addEventListener(
        "change",
        function () {
            filter.to =
                to.value;

            if (
                filter.from &&
                filter.to <
                    filter.from
            ) {
                filter.from =
                    filter.to;
            }

            filter.sessionId =
                "all";

            renderProductionReport(
                production
            );
        }
    );

    session?.addEventListener(
        "change",
        function () {
            filter.sessionId =
                session.value;

            renderProductionReport(
                production
            );
        }
    );

    entireRun?.addEventListener(
        "click",
        function () {
            productionReportFilters.delete(
                production.id
            );

            renderProductionReport(
                production
            );
        }
    );

    document
        .querySelectorAll(
            `[data-production-report="${production.id}"] [data-archive-transaction-id]`
        )
        .forEach(
            function (button) {
                button.addEventListener(
                    "click",
                    function () {
                        const id =
                            Number(
                                button.dataset
                                    .archiveTransactionId
                            );

                        if (
                            expandedTransactionIds.has(
                                id
                            )
                        ) {
                            expandedTransactionIds.delete(
                                id
                            );
                        } else {
                            expandedTransactionIds.add(
                                id
                            );
                        }

                        renderProductionReport(
                            production
                        );
                    }
                );
            }
        );
}


async function loadProductionReport(
    production,
    {
        force = false
    } = {}
) {
    if (
        !force &&
        productionReportCache.has(
            production.id
        )
    ) {
        renderProductionReport(
            production
        );

        return;
    }

    productionReportCache.set(
        production.id,
        {
            loading: true
        }
    );

    try {
        const response =
            await archiveRequest(
                "rpc/get_production_report_data",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            p_production_id:
                                production.id
                        })
                }
            );

        const result =
            await response.json();

        productionReportCache.set(
            production.id,
            {
                data: {
                    sessions:
                        Array.isArray(
                            result.sessions
                        )
                            ? result.sessions
                                .map(
                                    normaliseReportSession
                                )
                            : [],
                    sales:
                        Array.isArray(
                            result.sales
                        )
                            ? result.sales
                                .map(
                                    normaliseReportSale
                                )
                            : []
                }
            }
        );

    } catch (error) {
        productionReportCache.set(
            production.id,
            {
                error:
                    error instanceof Error
                        ? error.message
                        : String(error)
            }
        );
    }

    renderProductionReport(
        production
    );
}


function applyArchiveFilters() {
    renderProductionList(
        filteredProductions()
    );
}


function renderProductionList(rows) {
    if (
        !dom.archiveProductionList ||
        !dom.archiveProductionCount
    ) {
        return;
    }

    dom.archiveProductionCount.textContent =
        `Displaying ${rows.length} production${rows.length === 1 ? "" : "s"}`;

    if (rows.length === 0) {
        dom.archiveProductionList.innerHTML =
            '<div class="archive-empty-message">No Productions match the selected filters.</div>';

        return;
    }

    dom.archiveProductionList.innerHTML =
        "";

    rows.forEach(
        function (production) {
            const card =
                document.createElement(
                    "article"
                );

            card.className =
                "archive-production-card";

            const expanded =
                String(
                    expandedProductionId
                ) ===
                String(production.id);

            const summary =
                document.createElement(
                    "button"
                );

            summary.type = "button";
            summary.className =
                "archive-production-summary";

            summary.setAttribute(
                "aria-expanded",
                String(expanded)
            );

            summary.innerHTML = `
                <span class="archive-production-name">
                    ${escapeHTML(production.name)}
                </span>

                <span class="archive-production-dates">
                    ${escapeHTML(displayDate(production.startDate))}
                    –
                    ${escapeHTML(closeDateDisplay(production))}
                </span>

                <span class="archive-status-badge ${escapeHTML(production.status)}">
                    ${escapeHTML(statusLabel(production.status))}
                </span>

                <span>
                    ${expanded ? "⌃" : "⌄"}
                </span>
            `;

            const details =
                document.createElement(
                    "div"
                );

            details.className =
                "archive-production-details";

            details.hidden =
                !expanded;

            const description =
                production.description
                    ? escapeHTML(
                        production.description
                    )
                    : "No description.";

            details.innerHTML = `
                <div class="archive-detail-grid">

                    <div class="archive-detail-stat">
                        <span>Sessions</span>
                        <strong>${production.sessionCount}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Money Taken</span>
                        <strong>${currencyFormatter.format(production.moneyTaken)}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Products Sold</span>
                        <strong>${production.productsSold}</strong>
                    </div>

                    <div class="archive-detail-stat">
                        <span>Products</span>
                        <strong>${production.productCount}</strong>
                    </div>

                </div>

                <p class="archive-production-description">
                    ${description}
                </p>

                <div
                    class="archive-production-actions"
                    data-production-actions="${production.id}"
                ></div>

                <div
                    class="archive-production-report-host"
                    data-production-report="${production.id}"
                ></div>
            `;

            const actions =
                details.querySelector(
                    `[data-production-actions="${production.id}"]`
                );

            renderProductionActions(
                actions,
                production
            );

            if (expanded) {
                window.setTimeout(
                    function () {
                        renderProductionReport(
                            production
                        );
                    },
                    0
                );
            }

            summary.addEventListener(
                "click",
                function () {
                    expandedProductionId =
                        expanded
                            ? null
                            : production.id;

                    applyArchiveFilters();
                }
            );

            card.append(
                summary,
                details
            );

            dom.archiveProductionList
                .appendChild(card);
        }
    );
}


function actionButton(
    label,
    handler,
    {
        dangerous = false
    } = {}
) {
    const button =
        document.createElement(
            "button"
        );

    button.type = "button";
    button.className =
        "secondary-button archive-action-button";

    if (dangerous) {
        button.classList.add(
            "archive-danger-button"
        );
    }

    button.textContent =
        label;

    button.addEventListener(
        "click",
        handler
    );

    return button;
}


function renderProductionActions(
    container,
    production
) {
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (
        production.status ===
        "upcoming"
    ) {
        container.appendChild(
            actionButton(
                "Edit Production",
                function () {
                    openProductionModal(
                        production
                    );
                }
            )
        );
    }

    if (
        production.status ===
        "active"
    ) {
        container.appendChild(
            actionButton(
                "Close Production",
                function () {
                    finishProduction(
                        production
                    );
                }
            )
        );
    }

    const eligibleSessions =
        eligibleUnassignedSessions(
            production
        );

    if (
        eligibleSessions.length > 0
    ) {
        container.appendChild(
            actionButton(
                `Assign Sessions (${eligibleSessions.length})`,
                function () {
                    openSessionAssignmentModal(
                        production
                    );
                }
            )
        );
    }

    if (
        production.status ===
            "upcoming" &&
        production.sessionCount === 0 &&
        production.productCount === 0
    ) {
        container.appendChild(
            actionButton(
                "Delete Empty Production",
                function () {
                    deleteProduction(
                        production
                    );
                },
                {
                    dangerous: true
                }
            )
        );
    }
}


function openProductionModal(
    production = null
) {
    if (!dom.productionModal) {
        return;
    }

    dom.productionForm.reset();
    dom.productionFormError.textContent =
        "";

    if (production) {
        dom.productionModalTitle.textContent =
            "Edit Production";

        dom.editingProductionId.value =
            production.id;

        dom.productionNameInput.value =
            production.name;

        dom.productionStartDateInput.value =
            production.startDate;

        dom.productionCloseDateInput.value =
            production.autoCloseDate;

        dom.productionDescriptionInput.value =
            production.description || "";
    } else {
        dom.productionModalTitle.textContent =
            "New Production";

        dom.editingProductionId.value =
            "";
    }

    dom.productionModal.hidden =
        false;

    window.setTimeout(
        function () {
            dom.productionNameInput.focus();
        },
        0
    );
}


function closeProductionModal() {
    if (!dom.productionModal) {
        return;
    }

    dom.productionModal.hidden =
        true;

    dom.productionForm.reset();
    dom.productionFormError.textContent =
        "";
    dom.editingProductionId.value =
        "";
}


async function saveProduction(event) {
    event.preventDefault();

    if (!canManageArchive()) {
        return;
    }

    const id =
        dom.editingProductionId.value
            ? Number(
                dom.editingProductionId.value
            )
            : null;

    const name =
        dom.productionNameInput.value
            .trim();

    const startDate =
        dom.productionStartDateInput.value;

    const autoCloseDate =
        dom.productionCloseDateInput.value;

    const description =
        dom.productionDescriptionInput.value
            .trim();

    if (!name) {
        dom.productionFormError.textContent =
            "Enter a Production name.";
        return;
    }

    if (
        !startDate ||
        !autoCloseDate
    ) {
        dom.productionFormError.textContent =
            "Choose the Start Date and Auto-close Date.";
        return;
    }

    if (
        autoCloseDate <=
        startDate
    ) {
        dom.productionFormError.textContent =
            "Auto-close Date must be after the Start Date.";
        return;
    }

    const submit =
        dom.productionForm.querySelector(
            'button[type="submit"]'
        );

    if (submit) {
        submit.disabled = true;
        submit.textContent =
            id
                ? "Saving…"
                : "Creating…";
    }

    try {
        await archiveRequest(
            id
                ? "rpc/update_production"
                : "rpc/create_production",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    JSON.stringify(
                        id
                            ? {
                                p_production_id:
                                    id,
                                p_name:
                                    name,
                                p_start_date:
                                    startDate,
                                p_auto_close_date:
                                    autoCloseDate,
                                p_description:
                                    description || null
                            }
                            : {
                                p_name:
                                    name,
                                p_start_date:
                                    startDate,
                                p_auto_close_date:
                                    autoCloseDate,
                                p_description:
                                    description || null,
                                p_department_key:
                                    DEPARTMENT_KEY
                            }
                    )
            }
        );

        closeProductionModal();

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        if (
            message.includes(
                "PRODUCTION_DATES_OVERLAP"
            )
        ) {
            dom.productionFormError.textContent =
                "These dates overlap another Production.";
        } else {
            dom.productionFormError.textContent =
                message;
        }
    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent =
                "Save Production";
        }
    }
}


async function finishProduction(
    production
) {
    const confirmed =
        window.confirm(
            `Close "${production.name}" now?\n\n` +
            "This will finish the Production immediately and automatically close any open session attached to it."
        );

    if (!confirmed) {
        return;
    }

    try {
        const response =
            await archiveRequest(
                "rpc/finish_production",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            p_production_id:
                                production.id
                        })
                }
            );

        const result =
            await response.json();

        window.alert(
            `Production Closed — ${result.name || production.name}\n\n` +
            `Money Taken: ${currencyFormatter.format(Number(result.money_taken) || 0)}\n` +
            `Products Sold: ${Number(result.products_sold) || 0}`
        );

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        window.alert(
            "The Production could not be closed.\n\n" +
            (
                error instanceof Error
                    ? error.message
                    : String(error)
            )
        );
    }
}


async function deleteProduction(
    production
) {
    const confirmed =
        window.confirm(
            `Delete empty Upcoming Production "${production.name}"?\n\n` +
            "This is only allowed because it contains no sessions, products or sales."
        );

    if (!confirmed) {
        return;
    }

    try {
        await archiveRequest(
            "rpc/delete_empty_production",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    JSON.stringify({
                        p_production_id:
                            production.id
                    })
            }
        );

        expandedProductionId =
            null;

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        window.alert(
            "The Production could not be deleted.\n\n" +
            (
                error instanceof Error
                    ? error.message
                    : String(error)
            )
        );
    }
}


function openSessionAssignmentModal(
    production
) {
    if (
        !dom.sessionAssignmentModal
    ) {
        return;
    }

    sessionAssignmentProduction =
        production;

    sessionAssignmentEligibleSessions =
        eligibleUnassignedSessions(
            production
        );

    dom.sessionAssignmentModalTitle.textContent =
        "Assign Sessions";

    dom.sessionAssignmentProductionLabel.textContent =
        `${production.name} · ${displayDate(production.startDate)} – ${closeDateDisplay(production)}`;

    dom.sessionAssignmentError.textContent =
        "";

    dom.sessionAssignmentSelectAll.checked =
        false;

    renderSessionAssignmentList();

    dom.sessionAssignmentModal.hidden =
        false;
}


function closeSessionAssignmentModal() {
    if (
        !dom.sessionAssignmentModal
    ) {
        return;
    }

    dom.sessionAssignmentModal.hidden =
        true;

    sessionAssignmentProduction =
        null;

    sessionAssignmentEligibleSessions =
        [];

    if (
        dom.sessionAssignmentError
    ) {
        dom.sessionAssignmentError
            .textContent = "";
    }
}


function selectedSessionIds() {
    if (
        !dom.sessionAssignmentList
    ) {
        return [];
    }

    return Array.from(
        dom.sessionAssignmentList
            .querySelectorAll(
                'input[data-session-id]:checked'
            )
    ).map(
        function (input) {
            return Number(
                input.dataset.sessionId
            );
        }
    );
}


function updateAssignmentSelectionState() {
    const selected =
        selectedSessionIds();

    const total =
        sessionAssignmentEligibleSessions
            .length;

    if (
        dom.sessionAssignmentSelectedCount
    ) {
        dom.sessionAssignmentSelectedCount
            .textContent =
            `${selected.length} selected`;
    }

    if (
        dom.assignSelectedSessionsButton
    ) {
        dom.assignSelectedSessionsButton
            .disabled =
            selected.length === 0;
    }

    if (
        dom.sessionAssignmentSelectAll
    ) {
        dom.sessionAssignmentSelectAll
            .checked =
            total > 0 &&
            selected.length === total;

        dom.sessionAssignmentSelectAll
            .indeterminate =
            selected.length > 0 &&
            selected.length < total;
    }
}


function renderSessionAssignmentList() {
    if (
        !dom.sessionAssignmentList
    ) {
        return;
    }

    if (
        sessionAssignmentEligibleSessions
            .length === 0
    ) {
        dom.sessionAssignmentList
            .innerHTML =
            '<div class="archive-empty-message">No unassigned sessions fall within this Production’s dates.</div>';

        updateAssignmentSelectionState();

        return;
    }

    dom.sessionAssignmentList
        .innerHTML =
        sessionAssignmentEligibleSessions
            .map(
                function (session) {
                    return `
                        <label class="session-assignment-row">

                            <input
                                type="checkbox"
                                data-session-id="${Number(session.id)}"
                            >

                            <span class="session-assignment-date">
                                <strong>
                                    ${escapeHTML(displayDate(session.opened_at))}
                                </strong>

                                <small>
                                    Opened ${escapeHTML(sessionTime(session.opened_at))}
                                </small>
                            </span>

                            <span class="session-assignment-value">
                                <strong>
                                    ${currencyFormatter.format(Number(session.money_taken) || 0)}
                                </strong>

                                <small>
                                    Money Taken
                                </small>
                            </span>

                            <span class="session-assignment-value">
                                <strong>
                                    ${Number(session.products_sold) || 0}
                                </strong>

                                <small>
                                    Products Sold
                                </small>
                            </span>

                            <span class="session-status-badge ${escapeHTML(session.status || "")}">
                                ${escapeHTML(session.status || "Unknown")}
                            </span>

                        </label>
                    `;
                }
            )
            .join("");

    dom.sessionAssignmentList
        .querySelectorAll(
            'input[data-session-id]'
        )
        .forEach(
            function (input) {
                input.addEventListener(
                    "change",
                    updateAssignmentSelectionState
                );
            }
        );

    updateAssignmentSelectionState();
}


function toggleSelectAllSessions() {
    const shouldSelect =
        Boolean(
            dom.sessionAssignmentSelectAll
                ?.checked
        );

    dom.sessionAssignmentList
        ?.querySelectorAll(
            'input[data-session-id]'
        )
        .forEach(
            function (input) {
                input.checked =
                    shouldSelect;
            }
        );

    updateAssignmentSelectionState();
}


async function assignSelectedSessions() {
    const production =
        sessionAssignmentProduction;

    const sessionIds =
        selectedSessionIds();

    if (
        !production ||
        sessionIds.length === 0
    ) {
        return;
    }

    const confirmed =
        window.confirm(
            `Assign ${sessionIds.length} selected session${sessionIds.length === 1 ? "" : "s"} to "${production.name}"?\n\n` +
            "This changes only their Production association. Existing sales, payment information and totals are not recreated or altered."
        );

    if (!confirmed) {
        return;
    }

    dom.assignSelectedSessionsButton.disabled =
        true;

    dom.sessionAssignmentError.textContent =
        "";

    try {
        const response =
            await archiveRequest(
                "rpc/assign_selected_unassigned_sessions_to_production",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            p_production_id:
                                production.id,
                            p_session_ids:
                                sessionIds
                        })
                }
            );

        const result =
            await response.json();

        closeSessionAssignmentModal();

        window.alert(
            `${Number(result.sessions_assigned) || 0} session${Number(result.sessions_assigned) === 1 ? "" : "s"} assigned to "${production.name}".`
        );

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        if (
            message.includes(
                "SESSION_OUTSIDE_PRODUCTION_DATES"
            )
        ) {
            dom.sessionAssignmentError.textContent =
                "One or more selected sessions fall outside this Production’s dates.";
        } else if (
            message.includes(
                "SESSION_ALREADY_ASSIGNED"
            )
        ) {
            dom.sessionAssignmentError.textContent =
                "One of the selected sessions has already been assigned on another device. Refresh Archive and try again.";
        } else {
            dom.sessionAssignmentError.textContent =
                message;
        }

        updateAssignmentSelectionState();
    }
}


function resetFilters() {
    dom.archiveFromDate.value = "";
    dom.archiveToDate.value = "";
    dom.archiveStatusFilter.value = "";
    dom.archiveSearch.value = "";
    dom.archiveSortOrder.value =
        "newest";

    applyArchiveFilters();
}


function startArchiveRefresh() {
    stopArchiveRefresh();

    archiveRefreshTimer =
        window.setInterval(
            function () {
                if (
                    dom.archiveSection &&
                    !dom.archiveSection.hidden &&
                    navigator.onLine
                ) {
                    loadArchiveData({
                        silent: true
                    });
                }
            },
            15000
        );
}


function stopArchiveRefresh() {
    if (
        archiveRefreshTimer !==
        null
    ) {
        window.clearInterval(
            archiveRefreshTimer
        );

        archiveRefreshTimer =
            null;
    }
}


export function initialiseArchive() {
    dom.archiveNavButton
        ?.addEventListener(
            "click",
            function () {
                loadArchiveData();
                startArchiveRefresh();
            }
        );

    dom.addProductionButton
        ?.addEventListener(
            "click",
            function () {
                openProductionModal();
            }
        );

    dom.productionForm
        ?.addEventListener(
            "submit",
            saveProduction
        );

    dom.closeProductionModalButton
        ?.addEventListener(
            "click",
            closeProductionModal
        );

    dom.cancelProductionButton
        ?.addEventListener(
            "click",
            closeProductionModal
        );

    dom.productionModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.productionModal
                ) {
                    closeProductionModal();
                }
            }
        );

    [
        dom.archiveFromDate,
        dom.archiveToDate,
        dom.archiveStatusFilter,
        dom.archiveSortOrder
    ].forEach(
        function (element) {
            element?.addEventListener(
                "change",
                applyArchiveFilters
            );
        }
    );

    dom.archiveSearch
        ?.addEventListener(
            "input",
            applyArchiveFilters
        );

    dom.archiveResetFilters
        ?.addEventListener(
            "click",
            resetFilters
        );

    document
        .querySelectorAll(
            ".nav-button"
        )
        .forEach(
            function (button) {
                if (
                    button !==
                    dom.archiveNavButton
                ) {
                    button.addEventListener(
                        "click",
                        stopArchiveRefresh
                    );
                }
            }
        );

    window.addEventListener(
        "online",
        function () {
            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                loadArchiveData();
            }
        }
    );

    window.addEventListener(
        "offline",
        function () {
            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                setArchiveStatus(
                    "Archive is unavailable offline.",
                    true
                );
            }
        }
    );

    document.addEventListener(
        "production-data-changed",
        function () {
            productionReportCache.clear();

            if (
                dom.archiveSection &&
                !dom.archiveSection.hidden
            ) {
                loadArchiveData({
                    silent: true
                });
            }
        }
    );

    dom.sessionAssignmentSelectAll
        ?.addEventListener(
            "change",
            toggleSelectAllSessions
        );

    dom.assignSelectedSessionsButton
        ?.addEventListener(
            "click",
            assignSelectedSessions
        );

    dom.closeSessionAssignmentModalButton
        ?.addEventListener(
            "click",
            closeSessionAssignmentModal
        );

    dom.cancelSessionAssignmentButton
        ?.addEventListener(
            "click",
            closeSessionAssignmentModal
        );

    dom.sessionAssignmentModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.sessionAssignmentModal
                ) {
                    closeSessionAssignmentModal();
                }
            }
        );

    document.addEventListener(
        "keydown",
        function (event) {
            if (
                event.key !== "Escape"
            ) {
                return;
            }

            if (
                dom.sessionAssignmentModal &&
                !dom.sessionAssignmentModal.hidden
            ) {
                closeSessionAssignmentModal();
                return;
            }

            if (
                dom.productionModal &&
                !dom.productionModal.hidden
            ) {
                closeProductionModal();
            }
        }
    );
}
