import { dom } from "./dom.js";
import { state } from "./state.js";
import { supabaseConfig } from "./config.js";
import { isMasterAdmin } from "./permissions.js";

const CLOUD_ACCESS_TOKEN_KEY = "merchTillCloudAccessToken";

function getCloudAccessToken() {
    return sessionStorage.getItem(CLOUD_ACCESS_TOKEN_KEY) || "";
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
        tile_color: product.tileColor || "default"
    };
}

function mapSession(session) {
    return {
        id: session.id,
        opened_at: session.openedAt,
        closed_at: session.closedAt || null,
        opened_by: session.openedBy || null,
        closed_by: session.closedBy || null,
        status: session.status || (session.closedAt ? "closed" : "open")
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
        voided_by: sale.voidedBy || null
    };
}

async function upsertRows(tableName, rows, accessToken) {
    if (rows.length === 0) {
        return;
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/${tableName}?on_conflict=id`,
        {
            method: "POST",
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal"
            },
            body: JSON.stringify(rows)
        }
    );

    if (!response.ok) {
        const details = await response.text();
        throw new Error(
            `${tableName} upload failed (${response.status}). ${details}`
        );
    }
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
        `${state.sales.length} transactions ready to upload`;
}

async function uploadExistingTillData() {
    if (!isMasterAdmin()) {
        window.alert("Only the Master Admin can upload the Till database to the cloud.");
        return;
    }

    const accessToken = getCloudAccessToken();

    if (!accessToken) {
        window.alert(
            "A Supabase Master session is required. Log out, sign back in as master, then try again."
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
    updateCloudUploadStatus("Uploading sessions…");

    try {
        const sessions = state.sessions.map(mapSession);
        const products = state.products.map(mapProduct);
        const sales = state.sales.map(mapSale);

        await upsertRows("sessions", sessions, accessToken);
        updateCloudUploadStatus("Sessions uploaded. Uploading products…");

        await upsertRows("products", products, accessToken);
        updateCloudUploadStatus("Products uploaded. Uploading transactions…");

        await upsertRows("sales", sales, accessToken);

        const completedAt = new Date().toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short"
        });

        updateCloudUploadStatus(
            `Upload complete: ${products.length} products, ` +
            `${sessions.length} sessions and ${sales.length} transactions. ` +
            `Completed ${completedAt}.`
        );

        window.alert(
            "Cloud upload complete.\n\n" +
            `Products: ${products.length}\n` +
            `Sessions: ${sessions.length}\n` +
            `Transactions: ${sales.length}\n\n` +
            "Your local Till database has not been changed."
        );
    } catch (error) {
        console.error("Cloud upload failed:", error);
        updateCloudUploadStatus(
            "Upload failed. The local Till database is unchanged. Check the console for details.",
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
    if (!dom.uploadCloudDataButton) {
        return;
    }

    updateCloudUploadCounts();

    dom.uploadCloudDataButton.addEventListener("click", uploadExistingTillData);

    document.addEventListener("products-changed", updateCloudUploadCounts);
    document.addEventListener("sales-changed", updateCloudUploadCounts);
    document.addEventListener("sessions-changed", updateCloudUploadCounts);
}
