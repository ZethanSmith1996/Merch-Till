import { dom } from "./dom.js";
import { state } from "./state.js";
import { supabaseConfig } from "./config.js";
import { isMasterAdmin } from "./permissions.js";
import { getValidCloudAccessToken, isCloudUsername } from "./auth.js";
import { replaceCloudDataInDatabase, replaceCloudCatalogueInDatabase } from "./database.js";

const CLOUD_DIRTY_KEY = "merchTillCloudDirty";
const CLOUD_PENDING_SALES_KEY = "merchTillPendingCloudSales";
let syncTimer = null;
let syncInProgress = false;

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
        status: row.status || (row.closed_at ? "closed" : "open")
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
        throw new Error(
            `Cloud request failed (${response.status}). ${details}`
        );
    }

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


async function uploadPendingSalesQueue() {
    const role = sessionStorage.getItem("merchTillRole") || "";
    const pendingSales = readPendingSalesQueue();

    for (const sale of pendingSales) {
        const mappedSale = mapSale(sale);

        if (role === "staff") {
            // A brand-new Staff transaction is a normal INSERT. Do not send
            // the entire historic sales cache and do not use upsert/conflict
            // resolution. This means the request needs only Staff INSERT
            // permission.
            await cloudRequest("sales", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                },
                body: JSON.stringify(mappedSale)
            });
        } else {
            // Admin/Master can safely upsert the exact queued transaction.
            await upsertRows("sales", [mappedSale]);
        }

        // Only remove a transaction after Supabase has confirmed success.
        removePendingSale(sale.id);
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


function readPendingSalesQueue() {
    try {
        const saved = JSON.parse(
            localStorage.getItem(CLOUD_PENDING_SALES_KEY) || "[]"
        );

        return Array.isArray(saved) ? saved : [];
    } catch (error) {
        return [];
    }
}

function writePendingSalesQueue(queue) {
    localStorage.setItem(
        CLOUD_PENDING_SALES_KEY,
        JSON.stringify(queue)
    );
}

function queuePendingSale(sale) {
    if (!sale || sale.id === undefined || sale.id === null) {
        return;
    }

    const queue = readPendingSalesQueue();
    const saleId = String(sale.id);

    if (queue.some(function (queuedSale) {
        return String(queuedSale.id) === saleId;
    })) {
        return;
    }

    queue.push(sale);
    writePendingSalesQueue(queue);
}

function removePendingSale(saleId) {
    const queue = readPendingSalesQueue().filter(function (sale) {
        return String(sale.id) !== String(saleId);
    });

    writePendingSalesQueue(queue);
}

export function hasPendingCloudChanges() {
    const dirty = readDirtyState();

    return (
        dirty.products ||
        dirty.sessions ||
        dirty.sales ||
        readPendingSalesQueue().length > 0
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

function updateCloudUploadStatus(message, isError = false) {
    if (!dom.cloudUploadStatus) {
        return;
    }

    dom.cloudUploadStatus.textContent = message;
    dom.cloudUploadStatus.classList.toggle("cloud-upload-error", isError);
}

function updateCloudUploadCounts() {
    if (!dom.cloudUploadCounts) {
        return;
    }

    dom.cloudUploadCounts.textContent =
        `${state.products.length} products · ` +
        `${state.sessions.length} sessions · ` +
        `${state.sales.length} transactions in this device's local database`;
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
    const hasQueuedSales = readPendingSalesQueue().length > 0;

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
    updateCloudUploadStatus("Automatic cloud sync in progress…");

    try {
        const role = sessionStorage.getItem("merchTillRole") || "";
        const staffMode = role === "staff";

        if (staffMode) {
            // Staff never create or modify trading sessions. The current
            // session already exists in Supabase and is only read by Staff.
            // Do not attempt the Admin-only session upsert here.

            // A Staff sale changes stock. PATCH only the stock fields of
            // existing products rather than upserting/managing the catalogue.
            if (dirty.products || dirty.sales || hasQueuedSales) {
                await syncStaffProductStockSnapshot();
                dirty.products = false;
                writeDirtyState(dirty);
            }

            if (dirty.sales || readPendingSalesQueue().length > 0) {
                await uploadPendingSalesQueue();

                if (readPendingSalesQueue().length === 0) {
                    dirty.sales = false;
                    writeDirtyState(dirty);
                }
            }
        } else {
            // Admin/Master accounts retain the full snapshot synchronisation
            // behaviour used for product management, sessions and reports.
            if (dirty.sessions || dirty.sales) {
                await syncSessionsSnapshot();
                dirty.sessions = false;
                writeDirtyState(dirty);
            }

            if (dirty.products || dirty.sales) {
                await syncProductsSnapshot();
                dirty.products = false;
                writeDirtyState(dirty);
            }

            if (readPendingSalesQueue().length > 0) {
                await uploadPendingSalesQueue();
            }

            if (dirty.sales) {
                // Keep the existing Admin snapshot behaviour for report edits
                // such as transaction voids. Newly-created transactions have
                // already been confirmed individually above.
                await syncSalesSnapshot();

                if (readPendingSalesQueue().length === 0) {
                    dirty.sales = false;
                    writeDirtyState(dirty);
                }
            }
        }

        const completedAt = new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit"
        });

        updateCloudUploadStatus(`Cloud synced automatically at ${completedAt}.`);
        return true;
    } catch (error) {
        console.warn("Automatic cloud sync is pending:", error);

        const message =
            error && error.message
                ? error.message
                : String(error || "Unknown cloud sync error.");

        // Temporary go-live diagnostic: expose the exact Supabase/PostgREST
        // failure in the existing Cloud Sync status area so we can identify
        // the rejected sale field/policy without needing browser developer
        // tools on the work tablet.
        updateCloudUploadStatus(
            `SYNC ERROR: ${message}`,
            true
        );

        return false;
    } finally {
        syncInProgress = false;
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
    updateCloudUploadCounts();

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
            event.detail.cloudConfirmed === true
        ) {
            return;
        }

        markDirty({ products: true });
    });

    document.addEventListener("sales-changed", function (event) {
        updateCloudUploadCounts();

        if (
            event.detail &&
            event.detail.type === "created" &&
            event.detail.sale
        ) {
            queuePendingSale(event.detail.sale);
        }

        markDirty({ products: true, sales: true });
    });

    document.addEventListener("sessions-changed", function () {
        updateCloudUploadCounts();
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
        // On mobile, the browser can announce "online" slightly before the
        // network is actually usable. Retry immediately and a few seconds
        // later so Staff sales do not need an Admin login to wake the sync.
        retryPendingCloudWork();

        window.setTimeout(retryPendingCloudWork, 2000);
        window.setTimeout(retryPendingCloudWork, 8000);
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
}
