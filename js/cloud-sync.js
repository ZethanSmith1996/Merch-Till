import { dom } from "./dom.js";
import { state } from "./state.js";
import { supabaseConfig } from "./config.js";
import { isMasterAdmin } from "./permissions.js";
import { getValidCloudAccessToken, isCloudUsername } from "./auth.js";
import { logAuditEvent } from "./audit-log.js?v=priority10c";
import {
    replaceCloudDataInDatabase,
    replaceCloudCatalogueInDatabase,
    replaceProductCacheInDatabase,
    deleteSaleFromDatabase,
    updateSaleOrderNumberInDatabase
} from "./database.js?v=step6c";

const CLOUD_DIRTY_KEY = "merchTillCloudDirty";
const CLOUD_PENDING_SALES_KEY = "merchTillPendingCloudSales";
const CLOUD_OPERATION_QUEUE_KEY = "merchTillCloudOperationQueueV1";
const CLOUD_QUEUE_BASE_BACKOFF_MS = 5000;
const CLOUD_QUEUE_MAX_BACKOFF_MS = 5 * 60 * 1000;
let syncTimer = null;
let syncInProgress = false;
let lastGlobalSyncError = null;
let cloudReachable = navigator.onLine;
let connectivityCheckInProgress = false;
let lastReconnectAt = 0;
const RECONNECT_SYNC_GRACE_MS = 10000;
let sharedProductRefreshInProgress = false;

function compareProducts(first, second) {
    const firstOrder = Number.isFinite(first.sortOrder)
        ? first.sortOrder
        : first.id;
    const secondOrder = Number.isFinite(second.sortOrder)
        ? second.sortOrder
        : second.id;

    if (firstOrder !== secondOrder) {
        return firstOrder - secondOrder;
    }

    if (
        first.groupId &&
        second.groupId &&
        first.groupId === second.groupId
    ) {
        return (first.variantOrder ?? 0) - (second.variantOrder ?? 0);
    }

    return first.id - second.id;
}

function unmapProduct(row) {
    return {
        id: Number(row.id),
        name: row.name,
        price: Number(row.price) || 0,
        stock: Number(row.stock) || 0,
        ...(row.group_id ? { groupId: row.group_id } : {}),
        ...(row.variant_name ? { variantName: row.variant_name } : {}),
        ...(row.variant_order !== null && row.variant_order !== undefined
            ? { variantOrder: Number(row.variant_order) }
            : {}),
        ...(row.sort_order !== null && row.sort_order !== undefined
            ? { sortOrder: Number(row.sort_order) }
            : {}),
        tileColor: row.tile_color || "default"
    };
}

function unmapSession(row) {
    return {
        id: Number(row.id),
        openedAt: row.opened_at,
        closedAt: row.closed_at || null,
        openedBy: row.opened_by || null,
        closedBy: row.closed_by || null,
        status: row.status || (row.closed_at ? "closed" : "open"),
        productionId:
            row.production_id === null ||
            row.production_id === undefined
                ? null
                : Number(row.production_id)
    };
}

function unmapSale(row) {
    return {
        id: Number(row.id),
        sessionId: Number(row.session_id),
        orderNumber: Number(row.order_number),
        date: row.sale_date,
        time: row.sale_time || "",
        createdAt: row.created_at,
        completedBy: row.completed_by || null,
        subtotal: row.subtotal === null || row.subtotal === undefined
            ? Number(row.total) || 0
            : Number(row.subtotal),
        discountPercent: Number(row.discount_percent) || 0,
        discountAmount: Number(row.discount_amount) || 0,
        discountAuthorizedBy: row.discount_authorized_by || null,
        total: Number(row.total) || 0,
        itemCount: Number(row.item_count) || 0,
        items: Array.isArray(row.items) ? row.items : [],
        paymentMethod:
            row.payment_method || null,
        cashAmount:
            Number(row.cash_amount) || 0,
        cardAmount:
            Number(row.card_amount) || 0,
        cashTendered:
            Number(row.cash_tendered) || 0,
        changeDue:
            Number(row.change_due) || 0,
        payments:
            Array.isArray(row.payments)
                ? row.payments
                : [],
        voided: Boolean(row.voided),
        voidedAt: row.voided_at || null,
        voidedBy: row.voided_by || null
    };
}

function mapProduct(product) {
    return {
        id: product.id,
        name: product.name,
        price: Number(product.price) || 0,
        stock: Number(product.stock) || 0,
        group_id: product.groupId || null,
        variant_name: product.variantName || null,
        variant_order: Number.isFinite(product.variantOrder)
            ? product.variantOrder
            : null,
        sort_order: Number.isFinite(product.sortOrder)
            ? product.sortOrder
            : null,
        tile_color: product.tileColor || "default",
        cloud_updated_at: new Date().toISOString()
    };
}

function mapSession(session) {
    return {
        id: session.id,
        opened_at: session.openedAt,
        closed_at: session.closedAt || null,
        opened_by: session.openedBy || null,
        closed_by: session.closedBy || null,
        status: session.status || (session.closedAt ? "closed" : "open"),
        production_id:
            session.productionId ?? null,
        cloud_updated_at: new Date().toISOString()
    };
}

function mapSale(sale) {
    return {
        id: sale.id,
        session_id: sale.sessionId,
        order_number: sale.orderNumber,
        sale_date: sale.date,
        sale_time: sale.time || null,
        created_at: sale.createdAt,
        completed_by: sale.completedBy || null,
        subtotal: Number.isFinite(sale.subtotal)
            ? sale.subtotal
            : sale.total,
        discount_percent: Number(sale.discountPercent) || 0,
        discount_amount: Number(sale.discountAmount) || 0,
        discount_authorized_by: sale.discountAuthorizedBy || null,
        total: Number(sale.total) || 0,
        item_count: Number(sale.itemCount) || 0,
        items: Array.isArray(sale.items) ? sale.items : [],
        payment_method:
            sale.paymentMethod || null,
        cash_amount:
            Number(sale.cashAmount) || 0,
        card_amount:
            Number(sale.cardAmount) || 0,
        cash_tendered:
            Number(sale.cashTendered) || 0,
        change_due:
            Number(sale.changeDue) || 0,
        payments:
            Array.isArray(sale.payments)
                ? sale.payments
                : [],
        voided: Boolean(sale.voided),
        voided_at: sale.voidedAt || null,
        voided_by: sale.voidedBy || null,
        cloud_updated_at: new Date().toISOString()
    };
}

async function cloudRequest(path, options = {}) {
    const accessToken = await getValidCloudAccessToken();

    if (!accessToken) {
        throw new Error(
            "No valid Supabase session is available for the current cloud user."
        );
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/${path}`,
        {
            ...options,
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`,
                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        const details = await response.text();

        const error = new Error(
            `Cloud request failed (${response.status}). ${details}`
        );

        error.status = response.status;
        error.details = details;

        throw error;
    }

    cloudReachable = true;
    return response;
}

async function upsertRows(tableName, rows) {
    if (rows.length === 0) {
        return;
    }

    await cloudRequest(`${tableName}?on_conflict=id`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(rows)
    });
}

async function insertRowsIgnoringDuplicates(tableName, rows) {
    if (rows.length === 0) {
        return;
    }

    await cloudRequest(`${tableName}?on_conflict=id`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=minimal"
        },
        body: JSON.stringify(rows)
    });
}

async function deleteCloudProduct(productId) {
    await cloudRequest(`products?id=eq.${encodeURIComponent(productId)}`, {
        method: "DELETE",
        headers: {
            "Prefer": "return=minimal"
        }
    });
}

async function syncProductsSnapshot() {
    const products = state.products.map(mapProduct);
    await upsertRows("products", products);

    const response = await cloudRequest("products?select=id", {
        method: "GET",
        headers: {
            "Accept": "application/json"
        }
    });

    const cloudProducts = await response.json();
    const localIds = new Set(state.products.map(function (product) {
        return String(product.id);
    }));

    const staleCloudProducts = cloudProducts.filter(function (product) {
        return !localIds.has(String(product.id));
    });

    for (const product of staleCloudProducts) {
        await deleteCloudProduct(product.id);
    }
}

async function syncStaffProductStockSnapshot() {
    // Staff are permitted to update existing product rows, but not create,
    // delete, reorder or otherwise manage the catalogue. Send only the stock
    // value for each known product so a completed sale can reach the cloud
    // without requiring Admin product-management privileges.
    for (const product of state.products) {
        await cloudRequest(
            `products?id=eq.${encodeURIComponent(product.id)}`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                },
                body: JSON.stringify({
                    stock: Number(product.stock) || 0,
                    cloud_updated_at: new Date().toISOString()
                })
            }
        );
    }
}

async function syncSessionsSnapshot() {
    await upsertRows("sessions", state.sessions.map(mapSession));
}



async function processSaleAtomically(operation) {
    const sale =
        operation.sale;

    const quantities =
        Array.isArray(sale.items)
            ? sale.items.map(function (item) {
                return {
                    product_id:
                        Number(item.productId),
                    quantity:
                        Number(item.quantity) || 0
                };
            })
            : [];

    if (
        quantities.length === 0 ||
        quantities.some(function (item) {
            return (
                !Number.isFinite(item.product_id) ||
                item.quantity <= 0
            );
        })
    ) {
        throw new Error(
            "The queued sale does not contain valid product quantities for atomic processing."
        );
    }

    const response =
        await cloudRequest(
            "rpc/process_sale_atomic",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body: JSON.stringify({
                    p_sale:
                        mapSale(sale),
                    p_items:
                        quantities
                })
            }
        );

    const result =
        await response.json();

    if (
        !result ||
        result.success !== true
    ) {
        throw new Error(
            result?.message ||
            "Supabase did not confirm the atomic sale."
        );
    }

    return result;
}


export async function attemptImmediateAtomicSale(sale) {
    if (!navigator.onLine) {
        return {
            status: "deferred"
        };
    }

    try {
        const result =
            await processSaleAtomically({
                sale
            });

        return {
            status: "confirmed",
            result
        };

    } catch (error) {
        const conflict =
            atomicSaleErrorInfo(error);

        if (conflict) {
            return {
                status: "rejected",
                code: conflict.code,
                message: conflict.message
            };
        }

        /*
         * Technical/network errors are still safe to queue. They are not
         * treated as business-rule rejections.
         */
        return {
            status: "deferred",
            error
        };
    }
}


async function applyConfirmedOrderNumber(
    saleId,
    orderNumber
) {
    if (
        saleId === undefined ||
        saleId === null ||
        !Number.isFinite(
            Number(orderNumber)
        )
    ) {
        return;
    }

    const numericOrderNumber =
        Number(orderNumber);

    await updateSaleOrderNumberInDatabase(
        saleId,
        numericOrderNumber
    );

    state.sales =
        state.sales.map(function (sale) {
            if (
                String(sale.id) !==
                String(saleId)
            ) {
                return sale;
            }

            return {
                ...sale,
                orderNumber:
                    numericOrderNumber
            };
        });

    document.dispatchEvent(
        new CustomEvent(
            "cloud-order-number-updated",
            {
                detail: {
                    saleId:
                        Number(saleId),
                    orderNumber:
                        numericOrderNumber
                }
            }
        )
    );
}


export async function refreshSharedProductsFromCloud() {
    const username =
        sessionStorage.getItem(
            "merchTillUsername"
        ) || "";

    if (
        !isCloudUsername(username) ||
        !navigator.onLine ||
        document.hidden ||
        hasPendingCloudChanges() ||
        sharedProductRefreshInProgress
    ) {
        return false;
    }

    sharedProductRefreshInProgress =
        true;

    try {
        const productRows =
            await fetchCloudRows(
                "products"
            );

        const products =
            productRows
                .map(unmapProduct)
                .sort(compareProducts);

        await replaceProductCacheInDatabase(
            products
        );

        state.products =
            products;

        document.dispatchEvent(
            new CustomEvent(
                "products-changed",
                {
                    detail: {
                        cloudConfirmed:
                            true,
                        sharedRefresh:
                            true
                    }
                }
            )
        );

        return true;

    } catch (error) {
        /*
         * This is an opportunistic multi-device refresh. A temporary failure
         * must not interrupt service or replace the normal durable sync status.
         */
        console.warn(
            "Shared product stock refresh failed:",
            error
        );

        return false;

    } finally {
        sharedProductRefreshInProgress =
            false;
    }
}


async function uploadSaleOperationQueue() {
    const operations =
        readOperationQueue()
            .filter(function (operation) {
                return operation.type === "sale";
            });

    for (const operation of operations) {
        if (!operationIsReady(operation)) {
            continue;
        }

        try {
            /*
             * Queue entries created by Step 4A+ contain the full sale,
             * including product IDs and sold quantities. Send the whole
             * operation to one Supabase database function.
             *
             * PostgreSQL performs:
             *   1. sale insert
             *   2. stock validation
             *   3. stock deduction
             * in one transaction. If any part fails, all of it rolls back.
             */
            if (!operation.legacy) {
                const result =
                    await processSaleAtomically(
                        operation
                    );

                document.dispatchEvent(
                    new CustomEvent(
                        "audit-log-updated"
                    )
                );

                if (
                    Number.isFinite(
                        Number(
                            result.order_number
                        )
                    )
                ) {
                    await applyConfirmedOrderNumber(
                        operation.sale.id,
                        Number(
                            result.order_number
                        )
                    );
                }

                updateQueuedOperation(
                    operation.id,
                    {
                        saleConfirmed: true,
                        stockConfirmed: true,
                        attempts:
                            Number(operation.attempts || 0),
                        lastError: null,
                        confirmedAt:
                            new Date().toISOString(),
                        orderNumber:
                            Number.isFinite(
                                Number(
                                    result.order_number
                                )
                            )
                                ? Number(
                                    result.order_number
                                )
                                : null
                    }
                );

                removeQueuedOperation(
                    operation.id
                );

                updateCloudUploadCounts();
                continue;
            }

            /*
             * Compatibility path only for a pre-Step-4A sale that was migrated
             * from the old pending-sales queue. Those records did not retain
             * exact sold quantities, so they cannot use the atomic RPC safely.
             * Finish them with the last known working staged behaviour.
             */
            const mappedSale =
                mapSale(operation.sale);

            if (!operation.saleConfirmed) {
                await upsertRows(
                    "sales",
                    [mappedSale]
                );

                updateQueuedOperation(
                    operation.id,
                    {
                        saleConfirmed: true,
                        lastError: null
                    }
                );

                operation.saleConfirmed = true;
            }

            if (!operation.stockConfirmed) {
                await syncStaffProductStockSnapshot();

                updateQueuedOperation(
                    operation.id,
                    {
                        stockConfirmed: true,
                        lastError: null
                    }
                );

                operation.stockConfirmed = true;
            }

            removeQueuedOperation(
                operation.id
            );

            updateCloudUploadCounts();

        } catch (error) {
            const attempts =
                Number(operation.attempts || 0) + 1;

            const message =
                error && error.message
                    ? error.message
                    : String(error);

            const conflict =
                atomicSaleErrorInfo(error);

            if (conflict) {
                /*
                 * This is not a temporary connection problem.
                 *
                 * Example: an offline Till believed stock was 1, but another
                 * device sold the final unit first. Supabase rejects the sale.
                 *
                 * The rejected sale must never enter Reports later merely
                 * because stock is replenished, so remove it locally and from
                 * the retry queue immediately.
                 */
                await discardRejectedOfflineSale(
                    operation,
                    conflict
                );

                continue;
            }

            updateQueuedOperation(
                operation.id,
                {
                    attempts,
                    lastError: message,
                    lastAttemptAt:
                        new Date().toISOString()
                }
            );

            updateCloudUploadCounts();

            /*
             * Genuine technical failures remain durable and retry later.
             */
            continue;
        }
    }
}

async function syncSalesSnapshot() {
    const role = sessionStorage.getItem("merchTillRole") || "";

    // Staff are allowed to create sales but not browse or modify historic
    // transactions. Ignore duplicate IDs so an ordinary sale can upload
    // without requiring UPDATE permission on existing cloud sales.
    if (role === "staff") {
        await insertRowsIgnoringDuplicates("sales", state.sales.map(mapSale));
        return;
    }

    await upsertRows("sales", state.sales.map(mapSale));
}

async function fetchCloudRows(tableName, select = "*") {
    const response = await cloudRequest(
        `${tableName}?select=${encodeURIComponent(select)}`,
        {
            method: "GET",
            headers: {
                "Accept": "application/json"
            }
        }
    );

    return response.json();
}


function readOperationQueue() {
    try {
        const saved = JSON.parse(
            localStorage.getItem(CLOUD_OPERATION_QUEUE_KEY) || "[]"
        );

        return Array.isArray(saved) ? saved : [];
    } catch (error) {
        return [];
    }
}

function writeOperationQueue(queue) {
    localStorage.setItem(
        CLOUD_OPERATION_QUEUE_KEY,
        JSON.stringify(queue)
    );
}

function migrateLegacyPendingSalesQueue() {
    let legacySales = [];

    try {
        const saved = JSON.parse(
            localStorage.getItem(CLOUD_PENDING_SALES_KEY) || "[]"
        );

        legacySales =
            Array.isArray(saved)
                ? saved
                : [];
    } catch (error) {
        legacySales = [];
    }

    if (legacySales.length === 0) {
        return;
    }

    const queue = readOperationQueue();
    const knownIds = new Set(
        queue.map(function (operation) {
            return String(operation.sale?.id ?? operation.id);
        })
    );

    legacySales.forEach(function (sale) {
        if (!sale || sale.id === undefined || sale.id === null) {
            return;
        }

        if (knownIds.has(String(sale.id))) {
            return;
        }

        queue.push({
            id: `sale:${sale.id}`,
            type: "sale",
            createdAt: new Date().toISOString(),
            sale,
            stockUpdates: [],
            saleConfirmed: false,
            stockConfirmed: false,
            attempts: 0,
            lastError: null,
            legacy: true
        });
    });

    writeOperationQueue(queue);

    /*
     * Clear the old key only after the entries have been copied into the new
     * durable operation queue.
     */
    localStorage.removeItem(CLOUD_PENDING_SALES_KEY);
}

function queueSaleOperation(sale, stockUpdates = []) {
    if (!sale || sale.id === undefined || sale.id === null) {
        return;
    }

    const queue = readOperationQueue();
    const operationId = `sale:${sale.id}`;

    if (
        queue.some(function (operation) {
            return operation.id === operationId;
        })
    ) {
        return;
    }

    queue.push({
        id: operationId,
        type: "sale",
        createdAt: new Date().toISOString(),
        sale,
        stockUpdates:
            Array.isArray(stockUpdates)
                ? stockUpdates
                : [],
        saleConfirmed: false,
        stockConfirmed: false,
        attempts: 0,
        lastError: null,
        legacy: false
    });

    writeOperationQueue(queue);
}

function updateQueuedOperation(operationId, changes) {
    const queue = readOperationQueue();

    const updatedQueue =
        queue.map(function (operation) {
            if (operation.id !== operationId) {
                return operation;
            }

            return {
                ...operation,
                ...changes
            };
        });

    writeOperationQueue(updatedQueue);
}

function removeQueuedOperation(operationId) {
    writeOperationQueue(
        readOperationQueue().filter(
            function (operation) {
                return operation.id !== operationId;
            }
        )
    );
}

function pendingOperationCount() {
    return readOperationQueue().length;
}


function atomicSaleErrorInfo(error) {
    const text =
        `${error?.message || ""} ${error?.details || ""}`;

    const knownConflicts = [
        {
            code: "INSUFFICIENT_STOCK",
            message:
                "The sale was rejected because the cloud stock was no longer available."
        },
        {
            code: "PRODUCT_NOT_FOUND",
            message:
                "The sale was rejected because a product no longer exists in the cloud catalogue."
        },
        {
            code: "SESSION_NOT_FOUND",
            message:
                "The sale was rejected because its trading session could not be found."
        },
        {
            code: "INVALID_QUANTITY",
            message:
                "The sale was rejected because its item quantity was invalid."
        },
        {
            code: "ITEM_COUNT_MISMATCH",
            message:
                "The sale was rejected because its item totals did not pass validation."
        }
    ];

    return (
        knownConflicts.find(function (conflict) {
            return text.includes(conflict.code);
        }) || null
    );
}

async function discardRejectedOfflineSale(operation, conflict) {
    const saleId =
        operation?.sale?.id;

    await logAuditEvent(
        "system_sync",
        `Offline sale Order #${operation?.sale?.orderNumber ?? "?"} was rejected because stock was unavailable and was excluded from reporting.`,
        {
            sale_id:
                saleId ?? null,
            provisional_order_number:
                operation?.sale?.orderNumber ?? null,
            reason:
                conflict.code
        },
        saleId !== undefined && saleId !== null
            ? `offline-rejected:${saleId}`
            : null
    );

    if (
        saleId !== undefined &&
        saleId !== null
    ) {
        await deleteSaleFromDatabase(
            saleId
        );

        state.sales =
            state.sales.filter(function (sale) {
                return (
                    String(sale.id) !==
                    String(saleId)
                );
            });
    }

    removeQueuedOperation(
        operation.id
    );

    /*
     * Refresh Reports immediately without creating any new dirty cloud work.
     */
    document.dispatchEvent(
        new CustomEvent(
            "sales-changed",
            {
                detail: {
                    type:
                        "rejected-offline-conflict",
                    cloudConfirmed: true,
                    saleId,
                    conflictCode:
                        conflict.code
                }
            }
        )
    );

    updateCloudUploadStatus(
        "An offline sale was rejected because the stock was no longer available. " +
        "It has been removed from reporting and will not retry.",
        true
    );

    updateCloudUploadCounts();
}


function operationBackoffMs(operation) {
    const attempts =
        Math.max(
            0,
            Number(operation.attempts || 0)
        );

    if (attempts <= 0) {
        return 0;
    }

    return Math.min(
        CLOUD_QUEUE_MAX_BACKOFF_MS,
        CLOUD_QUEUE_BASE_BACKOFF_MS *
            Math.pow(2, attempts - 1)
    );
}

function operationIsReady(operation) {
    if (!operation.lastAttemptAt) {
        return true;
    }

    const lastAttempt =
        Date.parse(operation.lastAttemptAt);

    if (!Number.isFinite(lastAttempt)) {
        return true;
    }

    return (
        Date.now() - lastAttempt >=
        operationBackoffMs(operation)
    );
}

function queueStatusSummary() {
    const queue = readOperationQueue();

    const lastErrorOperation =
        [...queue]
            .reverse()
            .find(function (operation) {
                return Boolean(operation.lastError);
            });

    return {
        count: queue.length,
        lastError:
            lastErrorOperation
                ? lastErrorOperation.lastError
                : null
    };
}


export function hasPendingCloudChanges() {
    const dirty = readDirtyState();

    return (
        dirty.products ||
        dirty.sessions ||
        dirty.sales ||
        pendingOperationCount() > 0
    );
}

export async function refreshLocalCacheFromCloud() {
    const username = sessionStorage.getItem("merchTillUsername") || "";

    if (!isCloudUsername(username)) {
        return false;
    }

    if (!navigator.onLine) {
        updateCloudUploadStatus(
            "Offline — showing this device's cached Till data.",
            true
        );
        return false;
    }

    if (hasPendingCloudChanges()) {
        await flushPendingCloudSync();

        if (hasPendingCloudChanges()) {
            updateCloudUploadStatus(
                "Cloud download paused because this device still has local changes waiting to upload.",
                true
            );
            return false;
        }
    }

    updateCloudUploadStatus("Loading shared Till data from the cloud…");

    try {
        const role = sessionStorage.getItem("merchTillRole") || "";
        const staffMode = role === "staff";

        // Staff do not have permission to browse historic sales. They only
        // need the shared product catalogue and current session to operate
        // the Till. Admins continue to download the full reporting dataset.
        const productRows = await fetchCloudRows("products");
        const sessionRows = await fetchCloudRows("sessions");
        const saleRows = staffMode ? null : await fetchCloudRows("sales");

        const products = productRows
            .map(unmapProduct)
            .sort(compareProducts);

        const sessions = sessionRows
            .map(unmapSession)
            .sort(function (first, second) {
                return second.openedAt.localeCompare(first.openedAt);
            });

        let sales = state.sales;

        if (!staffMode) {
            sales = saleRows
                .map(unmapSale)
                .sort(function (first, second) {
                    return second.createdAt.localeCompare(first.createdAt);
                });

            await replaceCloudDataInDatabase(products, sales, sessions);
        } else {
            // Preserve the work tablet's local historic sales cache. A new
            // Staff device receives only the data Staff actually needs.
            await replaceCloudCatalogueInDatabase(products, sessions);
        }

        state.products = products;
        state.sessions = sessions;

        if (!staffMode) {
            state.sales = sales;
        }

        state.currentSession =
            sessions.find(function (session) {
                return session.status === "open";
            }) || null;

        updateCloudUploadCounts();

        const loadedAt = new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit"
        });

        updateCloudUploadStatus(
            `Shared cloud data loaded at ${loadedAt}.`
        );

        document.dispatchEvent(
            new CustomEvent("cloud-data-loaded")
        );

        return true;
    } catch (error) {
        console.warn("Shared cloud data could not be loaded:", error);
        updateCloudUploadStatus(
            "Cloud data could not be loaded. Showing this device's cached Till data.",
            true
        );
        return false;
    }
}

function readDirtyState() {
    try {
        const saved = JSON.parse(localStorage.getItem(CLOUD_DIRTY_KEY) || "{}");
        return {
            products: Boolean(saved.products),
            sessions: Boolean(saved.sessions),
            sales: Boolean(saved.sales)
        };
    } catch (error) {
        return {
            products: false,
            sessions: false,
            sales: false
        };
    }
}

function writeDirtyState(dirty) {
    localStorage.setItem(CLOUD_DIRTY_KEY, JSON.stringify(dirty));
}

function markDirty(changes) {
    if ((sessionStorage.getItem("merchTillRole") || "") === "training") {
        return;
    }

    const dirty = readDirtyState();

    Object.keys(changes).forEach(function (key) {
        if (changes[key]) {
            dirty[key] = true;
        }
    });

    writeDirtyState(dirty);
    scheduleCloudSync();
}



function looksLikeConnectivityError(error) {
    const text =
        `${error?.message || ""} ${error?.details || ""}`
            .toLowerCase();

    return (
        error instanceof TypeError ||
        text.includes("failed to fetch") ||
        text.includes("load failed") ||
        text.includes("networkerror") ||
        text.includes("network request failed") ||
        text.includes("offline")
    );
}

async function checkCloudReachability() {
    if (connectivityCheckInProgress) {
        return cloudReachable;
    }

    if (!navigator.onLine) {
        cloudReachable = false;
        lastGlobalSyncError = null;
        updateGlobalCloudIndicator();
        return false;
    }

    connectivityCheckInProgress = true;

    try {
        /*
         * Tiny heartbeat. Any HTTP response proves Supabase is reachable;
         * only a fetch/network failure means the cloud is unavailable.
         */
        const wasReachable =
            cloudReachable;

        await fetch(
            `${supabaseConfig.url}/rest/v1/`,
            {
                method: "HEAD",
                cache: "no-store"
            }
        );

        cloudReachable = true;

        if (!wasReachable) {
            lastReconnectAt =
                Date.now();
            lastGlobalSyncError =
                null;
        }

        return true;

    } catch (error) {
        cloudReachable = false;

        if (looksLikeConnectivityError(error)) {
            lastGlobalSyncError = null;
        }

        return false;

    } finally {
        connectivityCheckInProgress = false;
        updateGlobalCloudIndicator();
    }
}


function setGlobalCloudIndicator(
    label,
    stateClass,
    title = ""
) {
    if (
        !dom.globalCloudStatusPill ||
        !dom.globalCloudStatusLabel
    ) {
        return;
    }

    dom.globalCloudStatusPill.className =
        `global-cloud-status-pill ${stateClass}`;

    dom.globalCloudStatusLabel.textContent =
        label;

    dom.globalCloudStatusPill.title =
        title || label;
}

function updateGlobalCloudIndicator() {
    const role =
        sessionStorage.getItem(
            "merchTillRole"
        ) || "";

    if (role === "training") {
        setGlobalCloudIndicator(
            "LOCAL TRAINING",
            "cloud-local",
            "Training mode is local only and does not sync to Supabase."
        );
        return;
    }

    const queueSummary =
        queueStatusSummary();

    const dirty =
        readDirtyState();

    const hasOtherPendingWork =
        dirty.products ||
        dirty.sessions ||
        dirty.sales;

    const waitingCount =
        queueSummary.count;

    const withinReconnectGrace =
        lastReconnectAt > 0 &&
        (
            Date.now() -
            lastReconnectAt
        ) < RECONNECT_SYNC_GRACE_MS;

    if (
        !navigator.onLine ||
        cloudReachable === false
    ) {
        setGlobalCloudIndicator(
            waitingCount > 0
                ? `OFFLINE — ${waitingCount} WAITING`
                : "OFFLINE",
            "cloud-offline",
            waitingCount > 0
                ? `${waitingCount} operation${waitingCount === 1 ? "" : "s"} safely stored on this device and waiting for internet.`
                : "This device is offline. Cached Till data remains available."
        );
        return;
    }

    if (
        withinReconnectGrace &&
        (
            syncInProgress ||
            waitingCount > 0 ||
            hasOtherPendingWork
        )
    ) {
        setGlobalCloudIndicator(
            waitingCount > 0
                ? `SYNCING — ${waitingCount} WAITING`
                : "SYNCING",
            "cloud-syncing",
            waitingCount > 0
                ? `${waitingCount} operation${waitingCount === 1 ? "" : "s"} waiting for Supabase confirmation after reconnecting.`
                : "Cloud changes are being synchronised after reconnecting."
        );
        return;
    }

    if (
        lastGlobalSyncError ||
        queueSummary.lastError
    ) {
        setGlobalCloudIndicator(
            waitingCount > 0
                ? `SYNC ERROR — ${waitingCount} WAITING`
                : "SYNC ERROR",
            "cloud-error",
            lastGlobalSyncError ||
                queueSummary.lastError ||
                "Cloud sync encountered an error."
        );
        return;
    }

    if (
        syncInProgress ||
        waitingCount > 0 ||
        hasOtherPendingWork
    ) {
        setGlobalCloudIndicator(
            waitingCount > 0
                ? `SYNCING — ${waitingCount} WAITING`
                : "SYNCING",
            "cloud-syncing",
            waitingCount > 0
                ? `${waitingCount} operation${waitingCount === 1 ? "" : "s"} waiting for Supabase confirmation.`
                : "Cloud changes are being synchronised."
        );
        return;
    }

    setGlobalCloudIndicator(
        "CLOUD SYNCED",
        "cloud-synced",
        "This Till is online with no pending cloud operations."
    );
}


function updateCloudUploadStatus(message, isError = false) {
    if (isError) {
        const lowerMessage =
            String(message || "")
                .toLowerCase();

        if (
            lowerMessage.includes("failed to fetch") ||
            lowerMessage.includes("load failed") ||
            lowerMessage.includes("network") ||
            lowerMessage.includes("offline")
        ) {
            cloudReachable = false;
            lastGlobalSyncError = null;
        } else {
            lastGlobalSyncError =
                message || "Cloud sync error";
        }
    } else if (
        message &&
        (
            message.includes("synced") ||
            message.includes("loaded") ||
            message.includes("complete")
        )
    ) {
        cloudReachable = true;
        lastGlobalSyncError = null;
    }

    if (dom.cloudUploadStatus) {
        dom.cloudUploadStatus.textContent =
            message;

        dom.cloudUploadStatus.classList.toggle(
            "cloud-upload-error",
            isError
        );
    }

    updateGlobalCloudIndicator();
}

function updateCloudUploadCounts() {
    if (!dom.cloudUploadCounts) {
        return;
    }

    const queueSummary =
        queueStatusSummary();

    let queueText = "";

    if (queueSummary.count > 0) {
        queueText =
            ` · ${queueSummary.count} operation${queueSummary.count === 1 ? "" : "s"} waiting to sync`;

        if (queueSummary.lastError) {
            queueText +=
                ` · last error: ${queueSummary.lastError}`;
        }
    }

    dom.cloudUploadCounts.textContent =
        `${state.products.length} products · ` +
        `${state.sessions.length} sessions · ` +
        `${state.sales.length} transactions in this device's local database` +
        queueText;

    updateGlobalCloudIndicator();
}

function scheduleCloudSync() {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(function () {
        flushPendingCloudSync();
    }, 500);
}

export async function flushPendingCloudSync() {
    if (syncInProgress || !navigator.onLine) {
        return false;
    }

    const dirty = readDirtyState();
    const hasQueuedSales = pendingOperationCount() > 0;

    // A queued offline sale is pending work even if the older boolean dirty
    // flags have already been cleared. Previously this early return prevented
    // the persistent sale queue from ever being retried until another action
    // (such as an Admin product edit) happened to mark something dirty again.
    if (
        !dirty.products &&
        !dirty.sessions &&
        !dirty.sales &&
        !hasQueuedSales
    ) {
        return true;
    }

    syncInProgress = true;
    lastGlobalSyncError = null;
    updateGlobalCloudIndicator();
    updateCloudUploadStatus("Automatic cloud sync in progress…");

    try {
        const role = sessionStorage.getItem("merchTillRole") || "";
        const staffMode = role === "staff";

        if (staffMode) {
            // Staff never create or modify trading sessions. The current
            // session already exists in Supabase and is only read by Staff.
            // Do not attempt the Admin-only session upsert here.

            /*
             * Newly-created sales now carry their exact stock rows inside the
             * durable operation queue. The older dirty.products path is kept
             * only for non-sale workflows such as a void until Priority 5.
             */
            if (pendingOperationCount() > 0) {
                await uploadSaleOperationQueue();
            }

            if (dirty.products && pendingOperationCount() === 0) {
                await syncStaffProductStockSnapshot();
                dirty.products = false;
                writeDirtyState(dirty);
            }

            if (dirty.sales && pendingOperationCount() === 0) {
                dirty.sales = false;
                writeDirtyState(dirty);
            }
        } else {
            // Session management is now cloud-first. Never upload an old
            // local session snapshot over Supabase. A leftover legacy dirty
            // flag is discarded and the normal cloud refresh restores cache.
            if (dirty.sessions) {
                dirty.sessions = false;
                writeDirtyState(dirty);
            }

            if (dirty.products || dirty.sales) {
                await syncProductsSnapshot();
                dirty.products = false;
                writeDirtyState(dirty);
            }

            if (pendingOperationCount() > 0) {
                await uploadSaleOperationQueue();
            }

            if (dirty.sales && pendingOperationCount() === 0) {
                // Keep the existing Admin snapshot behaviour only for report
                // edits such as transaction voids. New sales are owned by the
                // durable operation queue above.
                await syncSalesSnapshot();
                dirty.sales = false;
                writeDirtyState(dirty);
            }
        }

        const completedAt = new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit"
        });

        const queueSummary =
            queueStatusSummary();

        if (queueSummary.count > 0) {
            updateCloudUploadStatus(
                queueSummary.lastError
                    ? `Cloud sync waiting to retry ${queueSummary.count} operation${queueSummary.count === 1 ? "" : "s"}.`
                    : `${queueSummary.count} cloud operation${queueSummary.count === 1 ? "" : "s"} still waiting to sync.`,
                Boolean(queueSummary.lastError)
            );
        } else {
            updateCloudUploadStatus(
                `Cloud synced automatically at ${completedAt}.`
            );
        }

        updateCloudUploadCounts();
        return true;
    } catch (error) {
        console.warn("Automatic cloud sync is pending:", error);

        const message =
            error && error.message
                ? error.message
                : String(error || "Unknown cloud sync error.");

        if (looksLikeConnectivityError(error)) {
            cloudReachable = false;
            lastGlobalSyncError = null;

            updateCloudUploadStatus(
                "Offline — cloud changes will retry automatically when the connection returns.",
                false
            );

            updateGlobalCloudIndicator();
        } else {
            updateCloudUploadStatus(
                `SYNC ERROR: ${message}`,
                true
            );
        }

        return false;
    } finally {
        syncInProgress = false;
        updateGlobalCloudIndicator();
    }
}

async function uploadExistingTillData() {
    if (!isMasterAdmin()) {
        window.alert("Only the Master Admin can upload the Till database to the cloud.");
        return;
    }

    const accessToken = await getValidCloudAccessToken();

    if (!accessToken) {
        window.alert(
            "A Supabase Master session is required. Log in as master on this device, then try again."
        );
        return;
    }

    updateCloudUploadCounts();

    const shouldUpload = window.confirm(
        "Upload this device's existing Till data to Supabase?\n\n" +
        `${state.products.length} products\n` +
        `${state.sessions.length} sessions\n` +
        `${state.sales.length} transactions\n\n` +
        "This copies the data to the cloud. It does not delete or replace the local IndexedDB database. Existing cloud rows with the same IDs will be updated."
    );

    if (!shouldUpload) {
        return;
    }

    dom.uploadCloudDataButton.disabled = true;
    dom.uploadCloudDataButton.textContent = "Uploading…";

    try {
        updateCloudUploadStatus("Uploading sessions…");
        await syncSessionsSnapshot();

        updateCloudUploadStatus("Sessions uploaded. Uploading products…");
        await syncProductsSnapshot();

        updateCloudUploadStatus("Products uploaded. Uploading transactions…");
        await syncSalesSnapshot();

        writeDirtyState({
            products: false,
            sessions: false,
            sales: false
        });

        const completedAt = new Date().toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short"
        });

        updateCloudUploadStatus(
            `Upload complete: ${state.products.length} products, ` +
            `${state.sessions.length} sessions and ${state.sales.length} transactions. ` +
            `Completed ${completedAt}. Automatic sync is active on this device.`
        );

        window.alert(
            "Cloud upload complete.\n\n" +
            `Products: ${state.products.length}\n` +
            `Sessions: ${state.sessions.length}\n` +
            `Transactions: ${state.sales.length}\n\n` +
            "Automatic cloud sync is now active on this paired device."
        );
    } catch (error) {
        console.error("Cloud upload failed:", error);
        updateCloudUploadStatus(
            "Upload failed. The local Till database is unchanged.",
            true
        );
        window.alert(
            "The cloud upload could not be completed.\n\n" +
            "Your local Till database has not been changed.\n\n" +
            error.message
        );
    } finally {
        dom.uploadCloudDataButton.disabled = false;
        dom.uploadCloudDataButton.textContent = "Upload Existing Till Data";
    }
}

export function initialiseCloudSync() {
    migrateLegacyPendingSalesQueue();
    updateCloudUploadCounts();
    updateGlobalCloudIndicator();

    window.setTimeout(
        function () {
            checkCloudReachability();
        },
        500
    );

    /*
     * If the browser/app was closed with pending work, the localStorage queue
     * survives. Give it an automatic recovery attempt after startup.
     */
    if (
        navigator.onLine &&
        hasPendingCloudChanges()
    ) {
        window.setTimeout(
            function () {
                flushPendingCloudSync();
            },
            1000
        );
    }

    if (dom.uploadCloudDataButton) {
        dom.uploadCloudDataButton.addEventListener("click", uploadExistingTillData);
    }

    document.addEventListener("products-changed", function (event) {
        updateCloudUploadCounts();

        /*
         * Product-management writes are now cloud-first. Once Supabase has
         * confirmed an Add/Edit/Delete/Reorder operation, this event only
         * refreshes the UI and must not trigger the legacy whole-catalogue
         * snapshot uploader.
         *
         * Stock changes created by sales/voids still use the existing dirty
         * mechanism until the atomic sale/stock roadmap stage.
         */
        if (
            event.detail &&
            (
                event.detail.cloudConfirmed === true ||
                event.detail.saleStockChange === true
            )
        ) {
            return;
        }

        markDirty({ products: true });
    });

    document.addEventListener("sales-changed", function (event) {
        if (
            event.detail &&
            event.detail.type === "created" &&
            event.detail.sale
        ) {
            if (
                event.detail.cloudConfirmed === true
            ) {
                updateCloudUploadCounts();
                return;
            }

            queueSaleOperation(
                event.detail.sale,
                event.detail.stockUpdates || []
            );

            updateCloudUploadCounts();
            scheduleCloudSync();
            return;
        }

        if (
            event.detail &&
            event.detail.type ===
                "rejected-offline-conflict"
        ) {
            /*
             * Local/reporting cleanup only. Do not turn a rejected sale into a
             * new dirty cloud operation.
             */
            updateCloudUploadCounts();
            return;
        }

        /*
         * Non-created sale changes (currently voiding) continue through the
         * transitional dirty path.
         */
        updateCloudUploadCounts();
        markDirty({ products: true, sales: true });
    });

    document.addEventListener("sessions-changed", function (event) {
        updateCloudUploadCounts();

        if (
            event.detail &&
            event.detail.cloudConfirmed === true
        ) {
            return;
        }

        markDirty({ sessions: true });
    });

    async function retryPendingCloudWork() {
        if (!navigator.onLine || !hasPendingCloudChanges()) {
            return;
        }

        const synced = await flushPendingCloudSync();

        if (synced && !hasPendingCloudChanges()) {
            await refreshLocalCacheFromCloud();
        }
    }

    window.addEventListener("online", function () {
        lastGlobalSyncError = null;
        lastReconnectAt = Date.now();
        updateGlobalCloudIndicator();

        checkCloudReachability().then(function (reachable) {
            if (reachable) {
                retryPendingCloudWork();
            }
        });

        window.setTimeout(retryPendingCloudWork, 2000);
        window.setTimeout(retryPendingCloudWork, 8000);
    });

    window.addEventListener("offline", function () {
        cloudReachable = false;
        lastGlobalSyncError = null;
        updateGlobalCloudIndicator();
    });

    document.addEventListener("cloud-authenticated", async function () {
        await retryPendingCloudWork();

        if (!hasPendingCloudChanges()) {
            await refreshLocalCacheFromCloud();
        }
    });

    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
            retryPendingCloudWork().then(function () {
                if (!hasPendingCloudChanges()) {
                    refreshLocalCacheFromCloud();
                }
            });
        }
    });

    // Mobile browsers frequently suspend timers/network events while in the
    // background. Treat focus/pageshow as another opportunity to flush any
    // locally stored sales as soon as the Till becomes active again.
    window.addEventListener("focus", retryPendingCloudWork);
    window.addEventListener("pageshow", retryPendingCloudWork);

    // Fast lightweight retry while there is genuinely pending work. When
    // there is nothing dirty this does no network request.
    window.setInterval(function () {
        if (navigator.onLine && hasPendingCloudChanges()) {
            retryPendingCloudWork();
        }
    }, 5000);

    /*
     * Safari/iPadOS may not update navigator.onLine until a request occurs.
     * This tiny heartbeat keeps the global cloud pill accurate while idle.
     */
    window.setInterval(
        checkCloudReachability,
        5000
    );

    /*
     * Multi-device stock visibility.
     *
     * When this device has no unsynced local work, lightly refresh only the
     * product catalogue every 3 seconds. This means a sale on Till A quickly
     * changes stock/Sold Out state on Till B without downloading Reports or
     * disturbing the durable offline queue.
     */
    window.setInterval(function () {
        if (
            navigator.onLine &&
            !hasPendingCloudChanges()
        ) {
            refreshSharedProductsFromCloud();
        }
    }, 3000);
}
