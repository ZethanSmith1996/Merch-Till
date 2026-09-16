import { dom } from "./dom.js";
import { supabaseConfig, currencyFormatter } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";
import { canManageArchive } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { openAddProductForProduction } from "./products.js?v=stage20";

const DEPARTMENT_KEY = "merch";

let productions = [];
let unassignedSessions = [];
let expandedProductionId = null;
let archiveRefreshTimer = null;
let lastArchiveDataSignature = "";

let sessionAssignmentProduction = null;
let sessionAssignmentEligibleSessions = [];

let productionProductsProduction = null;
let productionProductChoices = [];

const productionReportCache = new Map();
const productionReportFilters = new Map();
const expandedTransactionIds = new Set();
const expandedProductLists = new Set();
const expandedTransactionLists = new Set();
const expandedStockLists = new Set();

let comparisonSelectedProductionIds = new Set();
let comparisonRunning = false;
let comparisonMetricsCache = [];
let comparisonGraphMode = "daily";
let comparisonGraphMetric = "revenue";


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


function displayArchiveDateOnly(value) {
    if (!value) return "—";

    const date =
        value instanceof Date
            ? value
            : new Date(
                /^\d{4}-\d{2}-\d{2}$/.test(String(value))
                    ? `${value}T12:00:00`
                    : value
            );

    if (Number.isNaN(date.getTime())) return "—";

    return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
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



function archiveDataSignature(
    productionRows,
    unassignedRows
) {
    /*
     * Include only fields that affect the visible Archive list/banners.
     * If nothing has changed, a background refresh does not need to
     * rebuild the DOM — which also avoids disturbing the user's scroll.
     */
    return JSON.stringify({
        productions:
            productionRows.map(
                function (production) {
                    return {
                        id:
                            production.id,
                        name:
                            production.name,
                        description:
                            production.description,
                        startDate:
                            production.startDate,
                        autoCloseDate:
                            production.autoCloseDate,
                        manuallyClosedAt:
                            production.manuallyClosedAt,
                        status:
                            production.status,
                        sessionCount:
                            production.sessionCount,
                        moneyTaken:
                            production.moneyTaken,
                        productsSold:
                            production.productsSold,
                        productCount:
                            production.productCount
                    };
                }
            ),
        unassigned:
            Array.isArray(
                unassignedRows
            )
                ? unassignedRows.map(
                    function (session) {
                        return {
                            id:
                                session.id,
                            status:
                                session.status,
                            opened_at:
                                session.opened_at,
                            closed_at:
                                session.closed_at
                        };
                    }
                )
                : []
    });
}


function captureArchiveViewport() {
    const scrollY =
        window.scrollY ||
        window.pageYOffset ||
        0;

    let anchor = null;

    if (
        expandedProductionId !==
        null
    ) {
        const expandedButton =
            dom.archiveProductionList
                ?.querySelector(
                    `.archive-production-summary[aria-expanded="true"]`
                );

        if (expandedButton) {
            const rect =
                expandedButton
                    .getBoundingClientRect();

            anchor = {
                productionId:
                    expandedProductionId,
                viewportTop:
                    rect.top
            };
        }
    }

    return {
        scrollY,
        anchor
    };
}


function restoreArchiveViewport(
    viewport
) {
    if (!viewport) {
        return;
    }

    const restore =
        function () {
            /*
             * Prefer keeping the expanded Production header at the same
             * viewport position. This survives height changes above it.
             */
            if (
                viewport.anchor &&
                dom.archiveProductionList
            ) {
                const expandedButton =
                    dom.archiveProductionList
                        .querySelector(
                            `.archive-production-summary[aria-expanded="true"]`
                        );

                if (expandedButton) {
                    const currentTop =
                        expandedButton
                            .getBoundingClientRect()
                            .top;

                    const difference =
                        currentTop -
                        viewport.anchor
                            .viewportTop;

                    if (
                        Math.abs(
                            difference
                        ) > 1
                    ) {
                        window.scrollBy(
                            0,
                            difference
                        );
                    }

                    return;
                }
            }

            window.scrollTo(
                0,
                viewport.scrollY
            );
        };

    /*
     * Restore immediately after the list is rebuilt and once more after
     * the expanded Production report has had a chance to render.
     */
    window.requestAnimationFrame(
        function () {
            restore();

            window.setTimeout(
                restore,
                80
            );

            window.setTimeout(
                restore,
                250
            );
        }
    );
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

        const refreshedProductions =
            (await productionResponse.json())
                .map(normaliseProduction);

        const refreshedUnassignedSessions =
            await unassignedResponse.json();

        const refreshedSignature =
            archiveDataSignature(
                refreshedProductions,
                refreshedUnassignedSessions
            );

        const dataChanged =
            refreshedSignature !==
            lastArchiveDataSignature;

        /*
         * Background refreshes are deliberately non-disruptive.
         * If the cloud data has not changed, leave the current Archive
         * DOM completely untouched.
         */
        if (
            silent &&
            !dataChanged
        ) {
            return;
        }

        const viewport =
            silent
                ? captureArchiveViewport()
                : null;

        productions =
            refreshedProductions;

        unassignedSessions =
            refreshedUnassignedSessions;

        lastArchiveDataSignature =
            refreshedSignature;

        applyArchiveFilters();
        renderUnassignedBanner();

        if (silent) {
            restoreArchiveViewport(
                viewport
            );
        }

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



function normaliseProductionStockRow(row) {
    return {
        productId:
            Number(row.product_id),
        productName:
            row.variant_name
                ? `${row.product_name} — ${row.variant_name}`
                : row.product_name,
        initialStock:
            Number(row.initial_stock) || 0,
        deliveries:
            Number(row.delivered_stock) || 0,
        openingStock:
            Number(row.opening_stock) || 0,
        closingStock:
            row.closing_stock === null ||
            row.closing_stock === undefined
                ? null
                : Number(row.closing_stock),
        difference:
            row.difference === null ||
            row.difference === undefined
                ? null
                : Number(row.difference)
    };
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

    const stockExpanded =
        expandedStockLists.has(
            production.id
        );

    const productsExpanded =
        expandedProductLists.has(
            production.id
        );

    const transactionsExpanded =
        expandedTransactionLists.has(
            production.id
        );

    const stockRows =
        Array.isArray(
            reportData.stockSummary
        )
            ? reportData.stockSummary
            : [];

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


            <div class="archive-report-stock">

                <button
                    type="button"
                    class="archive-report-section-toggle"
                    data-toggle-stock="${production.id}"
                    aria-expanded="${stockExpanded}"
                >
                    <span>
                        <strong>Opening / Closing Stock</strong>
                        <small>
                            ${stockRows.length} product${stockRows.length === 1 ? "" : "s"}
                        </small>
                    </span>

                    <span>
                        ${stockExpanded ? "Hide" : "Show"}
                    </span>
                </button>

                <div
                    class="archive-report-collapsible-content"
                    ${stockExpanded ? "" : "hidden"}
                >
                    ${
                        stockRows.length > 0
                            ? `
                                <p class="field-help archive-stock-help">
                                    Opening Stock includes quantities recorded through Add Delivery.
                                </p>

                                <div class="archive-stock-table-wrap">
                                    <table class="archive-stock-table">
                                        <thead>
                                            <tr>
                                                <th>Product</th>
                                                <th>Opening Stock</th>
                                                <th>Closing Stock</th>
                                                <th>Difference</th>
                                            </tr>
                                        </thead>

                                        <tbody>
                                            ${
                                                stockRows.map(
                                                    function (row) {
                                                        return `
                                                            <tr>
                                                                <td>${escapeHTML(row.productName)}</td>
                                                                <td>${row.openingStock}</td>
                                                                <td>${row.closingStock === null ? "—" : row.closingStock}</td>
                                                                <td>${row.difference === null ? "—" : row.difference}</td>
                                                            </tr>
                                                        `;
                                                    }
                                                ).join("")
                                            }
                                        </tbody>
                                    </table>
                                </div>
                              `
                            : '<p class="archive-report-empty">No stock snapshot is available for this Production. Stock tracking begins with V20.</p>'
                    }
                </div>

            </div>


            <div class="archive-report-products">

                <button
                    type="button"
                    class="archive-report-section-toggle"
                    data-toggle-products="${production.id}"
                    aria-expanded="${productsExpanded}"
                >
                    <span>
                        <strong>Products Sold</strong>
                        <small>
                            ${itemsSold} item${itemsSold === 1 ? "" : "s"}
                        </small>
                    </span>

                    <span>
                        ${productsExpanded ? "Hide" : "Show"}
                    </span>
                </button>

                <div
                    class="archive-report-collapsible-content"
                    ${productsExpanded ? "" : "hidden"}
                >
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

            </div>


            <div class="archive-report-transactions-section">

                <button
                    type="button"
                    class="archive-report-section-toggle"
                    data-toggle-transactions="${production.id}"
                    aria-expanded="${transactionsExpanded}"
                >
                    <span>
                        <strong>Transactions</strong>
                        <small>
                            ${selectedSales.length} shown
                        </small>
                    </span>

                    <span>
                        ${transactionsExpanded ? "Hide All Transactions" : "Show All Transactions"}
                    </span>
                </button>

                <div
                    class="archive-report-transactions"
                    ${transactionsExpanded ? "" : "hidden"}
                >
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

    const stockToggle =
        document.querySelector(
            `[data-toggle-stock="${production.id}"]`
        );

    stockToggle?.addEventListener(
        "click",
        function () {
            if (
                expandedStockLists.has(
                    production.id
                )
            ) {
                expandedStockLists.delete(
                    production.id
                );
            } else {
                expandedStockLists.add(
                    production.id
                );
            }

            renderProductionReport(
                production
            );
        }
    );


    const productsToggle =
        document.querySelector(
            `[data-toggle-products="${production.id}"]`
        );

    productsToggle?.addEventListener(
        "click",
        function () {
            if (
                expandedProductLists.has(
                    production.id
                )
            ) {
                expandedProductLists.delete(
                    production.id
                );
            } else {
                expandedProductLists.add(
                    production.id
                );
            }

            renderProductionReport(
                production
            );
        }
    );

    const transactionsToggle =
        document.querySelector(
            `[data-toggle-transactions="${production.id}"]`
        );

    transactionsToggle?.addEventListener(
        "click",
        function () {
            if (
                expandedTransactionLists.has(
                    production.id
                )
            ) {
                expandedTransactionLists.delete(
                    production.id
                );
            } else {
                expandedTransactionLists.add(
                    production.id
                );
            }

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
        const [
            reportResponse,
            stockResponse
        ] =
            await Promise.all([
                archiveRequest(
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
                ),
                archiveRequest(
                    "rpc/get_production_stock_summary",
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
                )
            ]);

        const result =
            await reportResponse.json();

        const stockResult =
            await stockResponse.json();

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
                            : [],
                    stockSummary:
                        Array.isArray(
                            stockResult
                        )
                            ? stockResult.map(
                                normaliseProductionStockRow
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
                `archive-production-card archive-production-card-${production.status}`;

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
                    ${escapeHTML(displayArchiveDateOnly(production.startDate))}
                    –
                    ${escapeHTML(
                        displayArchiveDateOnly(
                            new Date(
                                new Date(`${production.autoCloseDate}T12:00:00`).getTime() -
                                86400000
                            )
                        )
                    )}
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

                    <div class="archive-detail-stat archive-products-stat">
                        <button
                            type="button"
                            class="archive-products-stat-button"
                            data-manage-production-products="${production.id}"
                        >
                            <span>Products</span>
                            <strong>${production.productCount}</strong>
                            <small>Manage Products</small>
                        </button>
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

            details
                .querySelector(
                    `[data-manage-production-products="${production.id}"]`
                )
                ?.addEventListener(
                    "click",
                    function () {
                        openProductionProductsModal(
                            production
                        );
                    }
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



function productionComparisonChoices() {
    /*
     * Comparison is most useful once a Production has actually traded,
     * but we do not artificially hide current/finished Productions that
     * have zero transactions. Upcoming Productions with no sessions are
     * excluded because there is nothing historical to compare yet.
     */
    return productions.filter(
        function (production) {
            return (
                production.sessionCount > 0 ||
                production.status !== "upcoming"
            );
        }
    );
}


function selectedComparisonProductions() {
    return Array.from(
        comparisonSelectedProductionIds
    )
        .map(
            function (id) {
                return productions.find(
                    function (production) {
                        return (
                            Number(production.id) ===
                            Number(id)
                        );
                    }
                );
            }
        )
        .filter(Boolean);
}


function updateComparisonSelectionState() {
    const count =
        comparisonSelectedProductionIds
            .size;

    if (
        dom.productionComparisonSelectionStatus
    ) {
        dom.productionComparisonSelectionStatus
            .textContent =
            count === 0
                ? "Select at least 2 Productions."
                : count === 1
                    ? "1 selected — choose at least one more."
                    : `${count} selected.`;
    }

    if (
        dom.runProductionComparisonButton
    ) {
        dom.runProductionComparisonButton.disabled =
            comparisonRunning ||
            count < 2 ||
            count > 3;
    }

    dom.productionComparisonSelection
        ?.querySelectorAll(
            "input[data-comparison-production-id]"
        )
        .forEach(
            function (input) {
                const checked =
                    input.checked;

                input.disabled =
                    !checked &&
                    count >= 3;
            }
        );
}


function renderComparisonSelection() {
    if (
        !dom.productionComparisonSelection
    ) {
        return;
    }

    const choices =
        productionComparisonChoices();

    if (choices.length === 0) {
        dom.productionComparisonSelection.innerHTML =
            '<div class="archive-empty-message production-comparison-empty">No Productions with trading history are available to compare.</div>';

        updateComparisonSelectionState();
        return;
    }

    dom.productionComparisonSelection.innerHTML =
        choices
            .slice()
            .sort(
                function (a, b) {
                    return (
                        String(b.startDate)
                            .localeCompare(
                                String(a.startDate)
                            )
                    );
                }
            )
            .map(
                function (production) {
                    const selected =
                        comparisonSelectedProductionIds
                            .has(
                                Number(
                                    production.id
                                )
                            );

                    return `
                        <label class="production-comparison-choice">
                            <input
                                type="checkbox"
                                data-comparison-production-id="${production.id}"
                                ${selected ? "checked" : ""}
                            >

                            <span>
                                <strong>
                                    ${escapeHTML(production.name)}
                                </strong>

                                <small>
                                    ${escapeHTML(
                                        displayArchiveDateOnly(
                                            production.startDate
                                        )
                                    )}
                                    –
                                    ${escapeHTML(
                                        displayArchiveDateOnly(
                                            new Date(
                                                new Date(
                                                    `${production.autoCloseDate}T12:00:00`
                                                ).getTime() -
                                                86400000
                                            )
                                        )
                                    )}
                                    ·
                                    ${escapeHTML(
                                        statusLabel(
                                            production.status
                                        )
                                    )}
                                </small>
                            </span>
                        </label>
                    `;
                }
            )
            .join("");

    dom.productionComparisonSelection
        .querySelectorAll(
            "input[data-comparison-production-id]"
        )
        .forEach(
            function (input) {
                input.addEventListener(
                    "change",
                    function () {
                        const id =
                            Number(
                                input.dataset
                                    .comparisonProductionId
                            );

                        if (input.checked) {
                            comparisonSelectedProductionIds
                                .add(id);
                        } else {
                            comparisonSelectedProductionIds
                                .delete(id);
                        }

                        updateComparisonSelectionState();
                    }
                );
            }
        );

    updateComparisonSelectionState();
}


function openProductionComparisonModal() {
    comparisonSelectedProductionIds =
        new Set();

    comparisonRunning =
        false;

    dom.productionComparisonError.textContent =
        "";

    dom.productionComparisonResults.hidden =
        true;

    dom.productionComparisonResults.innerHTML =
        "";

    renderComparisonSelection();

    dom.productionComparisonModal.hidden =
        false;
}


function closeProductionComparisonModal() {
    if (
        !dom.productionComparisonModal
    ) {
        return;
    }

    dom.productionComparisonModal.hidden =
        true;

    comparisonSelectedProductionIds =
        new Set();

    comparisonRunning =
        false;

    dom.productionComparisonError.textContent =
        "";

    dom.productionComparisonResults.hidden =
        true;

    dom.productionComparisonResults.innerHTML =
        "";
}


async function comparisonReportData(
    production
) {
    const cached =
        productionReportCache.get(
            production.id
        );

    if (
        cached &&
        cached.data
    ) {
        return cached.data;
    }

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

    const data = {
        sessions:
            Array.isArray(
                result.sessions
            )
                ? result.sessions.map(
                    normaliseReportSession
                )
                : [],
        sales:
            Array.isArray(
                result.sales
            )
                ? result.sales.map(
                    normaliseReportSale
                )
                : []
    };

    productionReportCache.set(
        production.id,
        {
            data
        }
    );

    return data;
}


function comparisonMetrics(
    production,
    reportData
) {
    const activeSales =
        reportData.sales.filter(
            function (sale) {
                return !sale.voided;
            }
        );

    const totalRevenue =
        activeSales.reduce(
            function (sum, sale) {
                return (
                    sum +
                    Number(
                        sale.total || 0
                    )
                );
            },
            0
        );

    const productsSold =
        activeSales.reduce(
            function (sum, sale) {
                return (
                    sum +
                    Number(
                        sale.itemCount || 0
                    )
                );
            },
            0
        );

    const runningDays =
        new Set(
            reportData.sessions
                .map(
                    function (session) {
                        return session.openedAt
                            ? String(
                                session.openedAt
                            ).slice(0, 10)
                            : "";
                    }
                )
                .filter(Boolean)
        ).size;

    const productTotals =
        reportProductsSold(
            activeSales
        );

    const bestProduct =
        productTotals.length > 0
            ? {
                name:
                    productTotals[0][0],
                quantity:
                    productTotals[0][1]
            }
            : null;

    return {
        production,
        reportData,
        totalRevenue,
        runningDays,
        transactions:
            activeSales.length,
        productsSold,
        bestProduct
    };
}


function comparisonMetricRow(
    label,
    metrics,
    formatter
) {
    return `
        <tr>
            <th scope="row">
                ${escapeHTML(label)}
            </th>

            ${
                metrics.map(
                    function (metric) {
                        return `
                            <td>
                                ${formatter(metric)}
                            </td>
                        `;
                    }
                ).join("")
            }
        </tr>
    `;
}



function comparisonMetricValue(metric, key) {
    if (key === "transactions") return Number(metric.transactions || 0);
    if (key === "products") return Number(metric.productsSold || 0);
    return Number(metric.totalRevenue || 0);
}

function comparisonMetricLabel(key) {
    if (key === "transactions") return "Transactions";
    if (key === "products") return "Products Sold";
    return "Revenue";
}

function comparisonMetricFormat(value, key) {
    return key === "revenue"
        ? currencyFormatter.format(Number(value || 0))
        : String(Math.round(Number(value || 0)));
}

function localDateKey(value) {
    return value ? String(value).slice(0, 10) : "";
}

function mondayStartDate(date) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = result.getDay();
    result.setDate(result.getDate() + (day === 0 ? -6 : 1 - day));
    return result;
}

function wholeDaysBetween(start, end) {
    const oneDay = 86400000;
    return Math.round(
        (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
         Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / oneDay
    );
}

function buildDailyComparisonSeries(metric) {
    const prepared = comparisonMetricsCache.map(function (entry) {
        const sessionDates = Array.from(new Set(
            entry.reportData.sessions
                .map(function (session) { return localDateKey(session.openedAt); })
                .filter(Boolean)
        )).sort();

        if (sessionDates.length === 0) {
            return {
                production: entry.production,
                valuesBySlot: new Map(),
                runningSlots: new Set(),
                maxSlot: 0
            };
        }

        const firstDate = new Date(`${sessionDates[0]}T12:00:00`);
        const firstMonday = mondayStartDate(firstDate);
        const runningSlots = new Set();
        const valuesBySlot = new Map();

        const salesByDate = new Map();

        entry.reportData.sales
            .filter(function (sale) { return !sale.voided; })
            .forEach(function (sale) {
                const dateKey = localDateKey(sale.saleDate || sale.createdAt);
                if (!dateKey) return;

                const current = salesByDate.get(dateKey) || {
                    revenue: 0,
                    transactions: 0,
                    products: 0
                };

                current.revenue += Number(sale.total || 0);
                current.transactions += 1;
                current.products += Number(sale.itemCount || 0);
                salesByDate.set(dateKey, current);
            });

        sessionDates.forEach(function (dateKey) {
            const date = new Date(`${dateKey}T12:00:00`);
            const slot = wholeDaysBetween(firstMonday, date);
            const totals = salesByDate.get(dateKey) || {
                revenue: 0,
                transactions: 0,
                products: 0
            };

            runningSlots.add(slot);
            valuesBySlot.set(slot, Number(totals[metric] || 0));
        });

        return {
            production: entry.production,
            valuesBySlot,
            runningSlots,
            maxSlot: Math.max(...runningSlots)
        };
    });

    const maxSlot = Math.max(0, ...prepared.map(function (item) { return item.maxSlot; }));
    const weekdays = [
        "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"
    ];

    const labels = [];
    for (let slot = 0; slot <= maxSlot; slot += 1) {
        labels.push({
            weekday: weekdays[slot % 7],
            week: Math.floor(slot / 7) + 1
        });
    }

    return {
        labels,
        series: prepared.map(function (item) {
            return {
                name: item.production.name,
                values: labels.map(function (_, slot) {
                    return item.runningSlots.has(slot)
                        ? Number(item.valuesBySlot.get(slot) || 0)
                        : null;
                })
            };
        })
    };
}

function chartPalette() {
    return ["#4f46e5", "#0f766e", "#c2410c"];
}

function renderLineChart(metric) {
    const data = buildDailyComparisonSeries(metric);
    if (data.labels.length === 0) {
        return '<div class="archive-empty-message">No daily Production data is available.</div>';
    }

    const width = 980, height = 470, left = 82, right = 28, top = 34, bottom = 92;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const values = data.series.flatMap(s => s.values).filter(v => v !== null);
    const maxValue = Math.max(1, ...values);
    const colours = chartPalette();

    const x = i => data.labels.length === 1
        ? left + plotWidth / 2
        : left + (i / (data.labels.length - 1)) * plotWidth;
    const y = v => top + plotHeight - (Number(v) / maxValue) * plotHeight;

    let svg = `<svg class="production-comparison-chart" viewBox="0 0 ${width} ${height}" role="img">`;

    for (let tick = 0; tick <= 5; tick += 1) {
        const value = (maxValue / 5) * tick;
        const yy = y(value);
        svg += `
            <line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" class="production-chart-gridline"></line>
            <text x="${left-12}" y="${yy+4}" text-anchor="end" class="production-chart-axis-label">
                ${escapeHTML(comparisonMetricFormat(value, metric))}
            </text>
        `;
    }

    data.labels.forEach(function (label, index) {
        const xx = x(index);

        if (index > 0 && index % 7 === 0) {
            const step = plotWidth / Math.max(data.labels.length - 1, 1);
            svg += `<line x1="${xx-step/2}" y1="${top}" x2="${xx-step/2}" y2="${top+plotHeight}" class="production-chart-week-divider"></line>`;
        }

        svg += `
            <text x="${xx}" y="${top+plotHeight+28}" text-anchor="middle" class="production-chart-x-label">
                ${escapeHTML(label.weekday)}
            </text>
        `;

        if (data.labels.length > 7) {
            svg += `
                <text x="${xx}" y="${top+plotHeight+46}" text-anchor="middle" class="production-chart-week-label">
                    Week ${label.week}
                </text>
            `;
        }
    });

    data.series.forEach(function (series, seriesIndex) {
        let segment = [];

        function flush() {
            if (segment.length > 1) {
                svg += `<polyline points="${segment.map(p => `${p.x},${p.y}`).join(" ")}"
                    fill="none" stroke="${colours[seriesIndex % colours.length]}"
                    stroke-width="4" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
            }

            segment.forEach(function (point) {
                const label = data.labels[point.index];
                svg += `
                    <circle cx="${point.x}" cy="${point.y}" r="5"
                        fill="${colours[seriesIndex % colours.length]}">
                        <title>${escapeHTML(series.name)} — ${escapeHTML(label.weekday)}, Week ${label.week}: ${escapeHTML(comparisonMetricFormat(point.value, metric))}</title>
                    </circle>
                `;
            });

            segment = [];
        }

        series.values.forEach(function (value, index) {
            if (value === null) {
                flush();
                return;
            }
            segment.push({index, value, x: x(index), y: y(value)});
        });
        flush();
    });

    svg += `</svg>
        <div class="production-chart-legend">
            ${data.series.map(function (series, index) {
                return `<span><i style="background:${colours[index % colours.length]}"></i>${escapeHTML(series.name)}</span>`;
            }).join("")}
        </div>`;

    return svg;
}

function renderBarChart(metric) {
    const values = comparisonMetricsCache.map(function (entry) {
        return {
            name: entry.production.name,
            value: comparisonMetricValue(entry, metric)
        };
    });

    const width = 900, height = 430, left = 90, right = 40, top = 42, bottom = 86;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maxValue = Math.max(1, ...values.map(v => v.value));
    const groupWidth = plotWidth / Math.max(values.length, 1);
    const barWidth = Math.min(150, groupWidth * .55);
    const colours = chartPalette();

    let svg = `<svg class="production-comparison-chart" viewBox="0 0 ${width} ${height}" role="img">`;

    for (let tick = 0; tick <= 5; tick += 1) {
        const value = (maxValue / 5) * tick;
        const yy = top + plotHeight - (value / maxValue) * plotHeight;
        svg += `
            <line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" class="production-chart-gridline"></line>
            <text x="${left-12}" y="${yy+4}" text-anchor="end" class="production-chart-axis-label">
                ${escapeHTML(comparisonMetricFormat(value, metric))}
            </text>
        `;
    }

    values.forEach(function (entry, index) {
        const xx = left + groupWidth * index + (groupWidth - barWidth) / 2;
        const barHeight = (entry.value / maxValue) * plotHeight;
        const yy = top + plotHeight - barHeight;

        svg += `
            <rect x="${xx}" y="${yy}" width="${barWidth}" height="${barHeight}" rx="7"
                fill="${colours[index % colours.length]}">
                <title>${escapeHTML(entry.name)}: ${escapeHTML(comparisonMetricFormat(entry.value, metric))}</title>
            </rect>

            <text x="${xx+barWidth/2}" y="${Math.max(yy-10,18)}" text-anchor="middle" class="production-chart-value-label">
                ${escapeHTML(comparisonMetricFormat(entry.value, metric))}
            </text>

            <text x="${xx+barWidth/2}" y="${top+plotHeight+30}" text-anchor="middle" class="production-chart-x-label">
                ${escapeHTML(entry.name)}
            </text>
        `;
    });

    return svg + "</svg>";
}

function renderComparisonGraph() {
    const container = document.getElementById("production-comparison-chart-container");
    if (!container) return;

    container.innerHTML = comparisonGraphMode === "overall"
        ? renderBarChart(comparisonGraphMetric)
        : renderLineChart(comparisonGraphMetric);
}

function initialiseComparisonGraphControls() {
    const toggle =
        document.getElementById(
            "toggle-production-comparison-graph"
        );

    const panel =
        document.getElementById(
            "production-comparison-graph-panel"
        );

    const graphType =
        document.getElementById(
            "production-comparison-graph-type"
        );

    const metric =
        document.getElementById(
            "production-comparison-graph-metric"
        );

    toggle
        ?.addEventListener(
            "click",
            function () {
                const willOpen =
                    panel.hidden;

                panel.hidden =
                    !willOpen;

                toggle.setAttribute(
                    "aria-expanded",
                    willOpen
                        ? "true"
                        : "false"
                );

                toggle.firstChild.textContent =
                    willOpen
                        ? "Hide Graph "
                        : "View as Graph ";

                const arrow =
                    toggle.querySelector(
                        ".production-comparison-graph-toggle-arrow"
                    );

                if (arrow) {
                    arrow.textContent =
                        willOpen
                            ? "▴"
                            : "▾";
                }

                if (willOpen) {
                    renderComparisonGraph();
                }
            }
        );

    graphType
        ?.addEventListener(
            "change",
            function () {
                comparisonGraphMode =
                    graphType.value;

                if (
                    panel &&
                    !panel.hidden
                ) {
                    renderComparisonGraph();
                }
            }
        );

    metric
        ?.addEventListener(
            "change",
            function () {
                comparisonGraphMetric =
                    metric.value;

                if (
                    panel &&
                    !panel.hidden
                ) {
                    renderComparisonGraph();
                }
            }
        );
}


function renderComparisonResults(metrics) {
    if (!dom.productionComparisonResults) return;

    comparisonMetricsCache = metrics;
    dom.productionComparisonResults.hidden = false;

    dom.productionComparisonResults.innerHTML = `
        <div class="production-comparison-results-heading">
            <div>
                <h3>Comparison</h3>
                <p>Historical totals for the selected Merchandise Productions.</p>
            </div>
        </div>

        <div class="production-comparison-table-wrap">
            <table class="production-comparison-table">
                <thead>
                    <tr>
                        <th>Metric</th>
                        ${metrics.map(metric => `<th>${escapeHTML(metric.production.name)}</th>`).join("")}
                    </tr>
                </thead>
                <tbody>
                    ${comparisonMetricRow("Total Revenue", metrics, metric => `<strong>${currencyFormatter.format(metric.totalRevenue)}</strong>`)}
                    ${comparisonMetricRow("Running Days", metrics, metric => `<strong>${metric.runningDays}</strong>`)}
                    ${comparisonMetricRow("Total Transactions", metrics, metric => `<strong>${metric.transactions}</strong>`)}
                    ${comparisonMetricRow("Products Sold", metrics, metric => `<strong>${metric.productsSold}</strong>`)}
                    ${comparisonMetricRow("Best Sold Product", metrics, metric => {
                        if (!metric.bestProduct) return "—";
                        return `<strong>${escapeHTML(metric.bestProduct.name)}</strong>
                            <small class="production-comparison-product-qty">${metric.bestProduct.quantity} sold</small>`;
                    })}
                </tbody>
            </table>
        </div>

        <div class="production-comparison-graph-section">

            <button
                type="button"
                id="toggle-production-comparison-graph"
                class="secondary-button production-comparison-graph-toggle"
                aria-expanded="false"
            >
                View as Graph
                <span
                    class="production-comparison-graph-toggle-arrow"
                    aria-hidden="true"
                >
                    ▾
                </span>
            </button>

            <div
                id="production-comparison-graph-panel"
                class="production-comparison-graph-panel"
                hidden
            >
                <div class="production-comparison-graph-heading">

                    <div>
                        <h3>Graph Comparison</h3>

                        <p>
                            Compare totals or see performance across the actual weekdays of each Production run.
                        </p>
                    </div>

                    <div class="production-comparison-graph-controls">

                        <label>
                            <span>Graph</span>

                            <select id="production-comparison-graph-type">
                                <option value="daily">
                                    Daily Performance
                                </option>

                                <option value="overall">
                                    Overall Comparison
                                </option>
                            </select>
                        </label>

                        <label>
                            <span>Metric</span>

                            <select id="production-comparison-graph-metric">
                                <option value="revenue">
                                    Revenue
                                </option>

                                <option value="transactions">
                                    Transactions
                                </option>

                                <option value="products">
                                    Products Sold
                                </option>
                            </select>
                        </label>

                    </div>

                </div>

                <div
                    id="production-comparison-chart-container"
                    class="production-comparison-chart-container"
                ></div>

            </div>

        </div>
    `;

    initialiseComparisonGraphControls();
}


async function runProductionComparison() {
    const selected =
        selectedComparisonProductions();

    if (
        selected.length < 2 ||
        selected.length > 3
    ) {
        return;
    }

    comparisonRunning =
        true;

    dom.productionComparisonError.textContent =
        "";

    dom.productionComparisonResults.hidden =
        false;

    dom.productionComparisonResults.innerHTML =
        '<div class="archive-report-loading">Loading comparison…</div>';

    updateComparisonSelectionState();

    try {
        const metrics =
            await Promise.all(
                selected.map(
                    async function (
                        production
                    ) {
                        const data =
                            await comparisonReportData(
                                production
                            );

                        return comparisonMetrics(
                            production,
                            data
                        );
                    }
                )
            );

        renderComparisonResults(
            metrics
        );

    } catch (error) {
        dom.productionComparisonResults.hidden =
            true;

        dom.productionComparisonError.textContent =
            error instanceof Error
                ? error.message
                : String(error);

    } finally {
        comparisonRunning =
            false;

        updateComparisonSelectionState();
    }
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
                "These dates overlap another active or upcoming Production. Finished Productions do not block these dates, and one Production may end on the same day the next begins.";
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


function normaliseProductChoice(row) {
    return {
        id: Number(row.id),
        name: row.name || "",
        variantName:
            row.variant_name || null,
        price:
            Number(row.price) || 0,
        stock:
            Number(row.stock) || 0,
        productionId:
            row.production_id === null ||
            row.production_id === undefined
                ? null
                : Number(row.production_id)
    };
}


async function openProductionProductsModal(
    production
) {
    if (!dom.productionProductsModal) {
        return;
    }

    productionProductsProduction =
        production;

    dom.productionProductsModalTitle.textContent =
        "Manage Products";

    dom.productionProductsProductionLabel.textContent =
        `${production.name} · ${statusLabel(production.status)}`;

    dom.productionProductsError.textContent =
        "";

    if (
        dom.addUpcomingProductionProductButton
    ) {
        /*
         * Products can be created directly inside Upcoming, Current
         * or Finished Productions.
         */
        dom.addUpcomingProductionProductButton.hidden =
            false;
    }

    dom.productionProductsList.innerHTML =
        '<div class="archive-empty-message">Loading Products…</div>';

    dom.productionProductsModal.hidden =
        false;

    try {
        const response =
            await archiveRequest(
                "rpc/get_production_product_choices",
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

        productionProductChoices =
            (await response.json())
                .map(
                    normaliseProductChoice
                );

        renderProductionProductChoices();

    } catch (error) {
        dom.productionProductsError.textContent =
            error instanceof Error
                ? error.message
                : String(error);
    }
}


function addProductToUpcomingProduction() {
    const production =
        productionProductsProduction;

    if (!production) {
        return;
    }

    /*
     * Close the Archive chooser while the existing Product form is open.
     * After a successful save, the custom event below reopens this Production
     * and refreshes its assigned-product list.
     */
    closeProductionProductsModal();

    openAddProductForProduction(
        {
            id: production.id,
            name: production.name
        }
    );
}


function closeProductionProductsModal() {
    if (!dom.productionProductsModal) {
        return;
    }

    dom.productionProductsModal.hidden =
        true;

    productionProductsProduction =
        null;

    productionProductChoices =
        [];

    dom.productionProductsError.textContent =
        "";
}


function selectedProductionProductIds() {
    return Array.from(
        dom.productionProductsList
            ?.querySelectorAll(
                'input[data-product-choice-id]:checked'
            ) || []
    ).map(
        function (input) {
            return Number(
                input.dataset
                    .productChoiceId
            );
        }
    );
}


function updateProductionProductSelectionState() {
    const selected =
        selectedProductionProductIds();

    const total =
        productionProductChoices
            .length;

    dom.productionProductsSelectedCount.textContent =
        `${selected.length} selected`;

    dom.productionProductsSelectAll.checked =
        total > 0 &&
        selected.length === total;

    dom.productionProductsSelectAll.indeterminate =
        selected.length > 0 &&
        selected.length < total;
}


function renderProductionProductChoices() {
    if (
        productionProductChoices.length ===
        0
    ) {
        dom.productionProductsList.innerHTML =
            '<div class="archive-empty-message">No assigned or Unassigned products are available.</div>';

        updateProductionProductSelectionState();
        return;
    }

    const productionId =
        Number(
            productionProductsProduction.id
        );

    dom.productionProductsList.innerHTML =
        productionProductChoices
            .map(
                function (product) {
                    const assigned =
                        product.productionId ===
                        productionId;

                    const displayName =
                        product.variantName
                            ? `${product.name} — ${product.variantName}`
                            : product.name;

                    return `
                        <label class="production-product-row">

                            <input
                                type="checkbox"
                                data-product-choice-id="${product.id}"
                                ${assigned ? "checked" : ""}
                            >

                            <span class="production-product-name">
                                <strong>
                                    ${escapeHTML(displayName)}
                                </strong>

                                <small>
                                    Product ID ${product.id}
                                </small>
                            </span>

                            <span class="production-product-value">
                                <strong>
                                    ${currencyFormatter.format(product.price)}
                                </strong>

                                <small>
                                    Price
                                </small>
                            </span>

                            <span class="production-product-value">
                                <strong>
                                    ${product.stock}
                                </strong>

                                <small>
                                    Stock
                                </small>
                            </span>

                            <span class="production-product-assignment ${assigned ? "assigned" : ""}">
                                ${assigned ? "Assigned" : "Unassigned"}
                            </span>

                        </label>
                    `;
                }
            )
            .join("");

    dom.productionProductsList
        .querySelectorAll(
            'input[data-product-choice-id]'
        )
        .forEach(
            function (input) {
                input.addEventListener(
                    "change",
                    updateProductionProductSelectionState
                );
            }
        );

    updateProductionProductSelectionState();
}


function toggleSelectAllProductionProducts() {
    const checked =
        Boolean(
            dom.productionProductsSelectAll
                .checked
        );

    dom.productionProductsList
        ?.querySelectorAll(
            'input[data-product-choice-id]'
        )
        .forEach(
            function (input) {
                input.checked =
                    checked;
            }
        );

    updateProductionProductSelectionState();
}


async function saveProductionProducts() {
    const production =
        productionProductsProduction;

    if (!production) {
        return;
    }

    const selectedIds =
        selectedProductionProductIds();

    const originallyAssignedIds =
        productionProductChoices
            .filter(
                function (product) {
                    return (
                        product.productionId ===
                        Number(
                            production.id
                        )
                    );
                }
            )
            .map(
                function (product) {
                    return product.id;
                }
            );

    const selectedSet =
        new Set(
            selectedIds.map(String)
        );

    const originalSet =
        new Set(
            originallyAssignedIds.map(
                String
            )
        );

    const addedCount =
        selectedIds.filter(
            function (id) {
                return !originalSet.has(
                    String(id)
                );
            }
        ).length;

    const removedCount =
        originallyAssignedIds.filter(
            function (id) {
                return !selectedSet.has(
                    String(id)
                );
            }
        ).length;

    if (
        addedCount === 0 &&
        removedCount === 0
    ) {
        closeProductionProductsModal();
        return;
    }

    const confirmed =
        window.confirm(
            `Update Products for "${production.name}"?\n\n` +
            `${addedCount} product${addedCount === 1 ? "" : "s"} will be added.\n` +
            `${removedCount} product${removedCount === 1 ? "" : "s"} will be returned to Unassigned.\n\n` +
            "Existing sales and transaction history will not be changed."
        );

    if (!confirmed) {
        return;
    }

    dom.saveProductionProductsButton.disabled =
        true;

    dom.productionProductsError.textContent =
        "";

    try {
        const response =
            await archiveRequest(
                "rpc/set_production_products",
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
                            p_selected_product_ids:
                                selectedIds
                        })
                }
            );

        const result =
            await response.json();

        closeProductionProductsModal();

        window.alert(
            `Products updated for "${production.name}".\n\n` +
            `Added: ${Number(result.products_added) || 0}\n` +
            `Returned to Unassigned: ${Number(result.products_removed) || 0}`
        );

        productionReportCache.delete(
            production.id
        );

        await loadArchiveData();

        document.dispatchEvent(
            new CustomEvent(
                "production-data-changed"
            )
        );

    } catch (error) {
        dom.productionProductsError.textContent =
            error instanceof Error
                ? error.message
                : String(error);
    } finally {
        dom.saveProductionProductsButton.disabled =
            false;
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

    dom.compareProductionsButton
        ?.addEventListener(
            "click",
            openProductionComparisonModal
        );

    dom.runProductionComparisonButton
        ?.addEventListener(
            "click",
            runProductionComparison
        );

    dom.closeProductionComparisonModalButton
        ?.addEventListener(
            "click",
            closeProductionComparisonModal
        );

    dom.cancelProductionComparisonButton
        ?.addEventListener(
            "click",
            closeProductionComparisonModal
        );

    dom.productionComparisonModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.productionComparisonModal
                ) {
                    closeProductionComparisonModal();
                }
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
        "production-stock-changed",
        function (event) {
            const productionId =
                Number(
                    event.detail?.productionId
                );

            if (productionId) {
                productionReportCache.delete(
                    productionId
                );
            }
        }
    );


    document.addEventListener(
        "archive-production-product-created",
        async function (event) {
            const productionId =
                Number(
                    event.detail?.productionId
                );

            if (
                !Number.isFinite(
                    productionId
                )
            ) {
                return;
            }

            await loadArchiveData({
                silent: true
            });

            const production =
                productions.find(
                    function (item) {
                        return (
                            Number(item.id) ===
                            productionId
                        );
                    }
                );

            if (production) {
                expandedProductionId =
                    productionId;

                applyArchiveFilters();

                await openProductionProductsModal(
                    production
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

    dom.addUpcomingProductionProductButton
        ?.addEventListener(
            "click",
            addProductToUpcomingProduction
        );

    dom.productionProductsSelectAll
        ?.addEventListener(
            "change",
            toggleSelectAllProductionProducts
        );

    dom.saveProductionProductsButton
        ?.addEventListener(
            "click",
            saveProductionProducts
        );

    dom.closeProductionProductsModalButton
        ?.addEventListener(
            "click",
            closeProductionProductsModal
        );

    dom.cancelProductionProductsButton
        ?.addEventListener(
            "click",
            closeProductionProductsModal
        );

    dom.productionProductsModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.productionProductsModal
                ) {
                    closeProductionProductsModal();
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
                dom.productionComparisonModal &&
                !dom.productionComparisonModal.hidden
            ) {
                closeProductionComparisonModal();
                return;
            }

            if (
                dom.productionProductsModal &&
                !dom.productionProductsModal.hidden
            ) {
                closeProductionProductsModal();
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
