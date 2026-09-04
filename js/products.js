import { currencyFormatter, supabaseConfig } from "./config.js?v=step3b";
import {
    replaceProductCacheInDatabase
} from "./database.js?v=step3b";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { getValidCloudAccessToken } from "./auth.js?v=step3b";
import { announceProductsChanged, escapeHTML } from "./utils.js";
import { logAuditEvent, auditActorUsername } from "./audit-log.js?v=priority10c";

function getNextProductId(products = state.products) {
    if (products.length === 0) {
        return 1;
    }

    return Math.max(
        ...products.map(function (product) {
            return Number(product.id) || 0;
        })
    ) + 1;
}


function auditColourLabel(value) {
    const colour =
        String(value || "default");

    return (
        colour.charAt(0).toUpperCase() +
        colour.slice(1)
    );
}

function auditProductDisplayName(product) {
    if (!product) return "Product";

    return product.variantName
        ? `${product.name} — ${product.variantName}`
        : product.name;
}

function buildProductEditAudit(
    beforeProducts,
    afterProducts,
    productName
) {
    const changes = [];

    const beforeById =
        new Map(
            beforeProducts.map(function (product) {
                return [
                    String(product.id),
                    product
                ];
            })
        );

    const afterById =
        new Map(
            afterProducts.map(function (product) {
                return [
                    String(product.id),
                    product
                ];
            })
        );

    afterProducts.forEach(
        function (after) {
            const before =
                beforeById.get(
                    String(after.id)
                );

            if (!before) {
                changes.push(
                    `added variant "${after.variantName || after.name}" with stock ${Number(after.stock) || 0}`
                );
                return;
            }

            if (before.name !== after.name) {
                changes.push(
                    `name "${before.name}" → "${after.name}"`
                );
            }

            if (
                Number(before.price) !==
                Number(after.price)
            ) {
                changes.push(
                    `price ${currencyFormatter.format(Number(before.price) || 0)} → ${currencyFormatter.format(Number(after.price) || 0)}`
                );
            }

            if (
                Number(before.stock) !==
                Number(after.stock)
            ) {
                changes.push(
                    `${auditProductDisplayName(after)} stock ${Number(before.stock) || 0} → ${Number(after.stock) || 0}`
                );
            }

            if (
                (before.tileColor || "default") !==
                (after.tileColor || "default")
            ) {
                changes.push(
                    `colour ${auditColourLabel(before.tileColor)} → ${auditColourLabel(after.tileColor)}`
                );
            }

            if (
                (before.variantName || "") !==
                (after.variantName || "")
            ) {
                changes.push(
                    `variant "${before.variantName || ""}" → "${after.variantName || ""}"`
                );
            }
        }
    );

    beforeProducts.forEach(
        function (before) {
            if (
                !afterById.has(
                    String(before.id)
                )
            ) {
                changes.push(
                    `removed variant "${before.variantName || before.name}"`
                );
            }
        }
    );

    const onlyStockChanges =
        changes.length > 0 &&
        changes.every(function (change) {
            return change.includes(" stock ");
        });

    return {
        category:
            onlyStockChanges
                ? "stock_change"
                : "product_change",

        message:
            changes.length > 0
                ? `${auditActorUsername()} edited "${productName}": ${changes.join("; ")}.`
                : `${auditActorUsername()} saved "${productName}" with no visible field changes.`,

        changes
    };
}



function productManagementIsOnline() {
    return navigator.onLine;
}

function setProductCloudStatus(message, isError = false) {
    const status =
        document.getElementById("product-cloud-status");

    if (!status) return;

    status.textContent = message;
    status.classList.toggle(
        "cloud-upload-error",
        isError
    );
}

function requireOnlineProductManagement() {
    if (productManagementIsOnline()) {
        return true;
    }

    setProductCloudStatus(
        "Product management is unavailable offline. Sales can continue using the cached catalogue.",
        true
    );

    window.alert(
        "Product management requires an internet connection.\n\n" +
        "Sales can continue using the cached product catalogue."
    );

    return false;
}

async function productCloudRequest(path, options = {}) {
    if (!navigator.onLine) {
        throw new Error(
            "Product management requires an internet connection."
        );
    }

    const accessToken =
        await getValidCloudAccessToken();

    if (!accessToken) {
        throw new Error(
            "No valid cloud session is available. Log out and log back in while online."
        );
    }

    const response = await fetch(
        `${supabaseConfig.url}/rest/v1/${path}`,
        {
            ...options,
            headers: {
                "apikey":
                    supabaseConfig.publishableKey,
                "Authorization":
                    `Bearer ${accessToken}`,
                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Cloud product request failed (${response.status}). ${details}`
        );
    }

    return response;
}

function mapProductForCloud(product) {
    return {
        id: product.id,
        name: product.name,
        price: Number(product.price) || 0,
        stock: Number(product.stock) || 0,
        group_id: product.groupId || null,
        variant_name: product.variantName || null,
        variant_order:
            Number.isFinite(product.variantOrder)
                ? product.variantOrder
                : null,
        sort_order:
            Number.isFinite(product.sortOrder)
                ? product.sortOrder
                : null,
        tile_color:
            product.tileColor || "default",
        cloud_updated_at:
            new Date().toISOString()
    };
}

function unmapCloudProduct(row) {
    return {
        id: Number(row.id),
        name: row.name,
        price: Number(row.price) || 0,
        stock: Number(row.stock) || 0,
        ...(row.group_id
            ? { groupId: row.group_id }
            : {}),
        ...(row.variant_name
            ? { variantName: row.variant_name }
            : {}),
        ...(row.variant_order !== null &&
        row.variant_order !== undefined
            ? {
                variantOrder:
                    Number(row.variant_order)
            }
            : {}),
        ...(row.sort_order !== null &&
        row.sort_order !== undefined
            ? {
                sortOrder:
                    Number(row.sort_order)
            }
            : {}),
        tileColor:
            row.tile_color || "default"
    };
}

async function fetchAuthoritativeCloudProducts() {
    const response =
        await productCloudRequest(
            "products?select=*&order=sort_order.asc,id.asc",
            {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            }
        );

    const rows = await response.json();

    return rows
        .map(unmapCloudProduct)
        .sort(compareProductsForDisplay);
}

async function upsertCloudProducts(productsToSave) {
    if (productsToSave.length === 0) {
        return;
    }

    await productCloudRequest(
        "products?on_conflict=id",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Prefer":
                    "resolution=merge-duplicates,return=minimal"
            },
            body: JSON.stringify(
                productsToSave.map(
                    mapProductForCloud
                )
            )
        }
    );
}

async function deleteCloudProducts(productIds) {
    for (const productId of productIds) {
        await productCloudRequest(
            `products?id=eq.${encodeURIComponent(productId)}`,
            {
                method: "DELETE",
                headers: {
                    "Prefer": "return=minimal"
                }
            }
        );
    }
}

async function refreshProductCacheFromCloud() {
    const products =
        await fetchAuthoritativeCloudProducts();

    await replaceProductCacheInDatabase(products);

    state.products = products;

    /*
     * This event is for UI refresh only. The cloud is already authoritative,
     * so cloud-sync must not interpret it as a new catalogue write.
     */
    announceProductsChanged({
        cloudConfirmed: true
    });

    setProductCloudStatus(
        "Products are synced with Supabase."
    );

    return products;
}

function updateProductManagementAvailability() {
    const online =
        productManagementIsOnline();

    if (dom.addProductButton) {
        dom.addProductButton.disabled = !online;
    }

    if (!online) {
        if (
            dom.productModal &&
            !dom.productModal.hidden
        ) {
            closeProductModal();
        }

        setProductCloudStatus(
            "Product management is unavailable offline. Sales can continue using the cached catalogue.",
            true
        );
    } else {
        setProductCloudStatus(
            "Product management is online. Supabase is the source of truth."
        );
    }

    renderProductsTable();
}


function createGroupId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }

    return `group-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isVariantProduct(product) {
    return Boolean(product.groupId && product.variantName);
}

function getProductSortOrder(product) {
    return Number.isFinite(product.sortOrder)
        ? product.sortOrder
        : product.id;
}

function getProductTileColor(product) {
    const allowedColours = new Set([
        "default",
        "pink",
        "blue",
        "green",
        "yellow"
    ]);

    return allowedColours.has(product.tileColor)
        ? product.tileColor
        : "default";
}

function compareProductsForDisplay(first, second) {
    const orderDifference =
        getProductSortOrder(first) - getProductSortOrder(second);

    if (orderDifference !== 0) {
        return orderDifference;
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

function getNextSortOrder(products = state.products) {
    const originalProducts = state.products;

    if (products !== state.products) {
        state.products = products;
    }

    const rows = getGroupedRows();

    if (products !== originalProducts) {
        state.products = originalProducts;
    }

    if (rows.length === 0) {
        return 1;
    }

    return rows.length + 1;
}

function productsInGroup(groupId) {
    return state.products
        .filter(function (product) {
            return product.groupId === groupId;
        })
        .sort(function (first, second) {
            return (first.variantOrder ?? 0) - (second.variantOrder ?? 0);
        });
}

function getGroupedRows() {
    const rows = [];
    const seenGroups = new Set();

    [...state.products]
        .sort(compareProductsForDisplay)
        .forEach(function (product) {
        if (!isVariantProduct(product)) {
            rows.push({
                type: "single",
                product: product
            });
            return;
        }

        if (seenGroups.has(product.groupId)) {
            return;
        }

        seenGroups.add(product.groupId);

        rows.push({
            type: "group",
            groupId: product.groupId,
            products: productsInGroup(product.groupId)
        });
    });

    return rows;
}

export function renderProductsTable() {
    dom.productsTableBody.innerHTML = "";

    const rows = getGroupedRows();
    dom.noProductsMessage.hidden = rows.length > 0;

    rows.forEach(function (row) {
        if (row.type === "single") {
            renderSingleProductRow(row.product);
        } else {
            renderVariantGroupRow(row.groupId, row.products);
        }
    });
}

function renderSingleProductRow(product) {
    const tableRow = document.createElement("tr");

    const stockClass =
        product.stock <= 0
            ? "stock-value out-of-stock"
            : "stock-value";

    tableRow.innerHTML = `
        <td>
            <span class="product-table-name">
                ${escapeHTML(product.name)}
            </span>
        </td>
        <td>${currencyFormatter.format(product.price)}</td>
        <td><span class="${stockClass}">${product.stock}</span></td>
        <td>
            <div class="product-actions">
                <div class="product-order-actions" aria-label="Reorder product">
                    <button
                        type="button"
                        class="move-product-button move-product-up"
                        aria-label="Move ${escapeHTML(product.name)} up"
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        class="move-product-button move-product-down"
                        aria-label="Move ${escapeHTML(product.name)} down"
                    >
                        ↓
                    </button>
                </div>
                <button type="button" class="edit-product-button">Edit</button>
                <button type="button" class="delete-product-button">Delete</button>
            </div>
        </td>
    `;

    const singleRows = getGroupedRows();
    const singleRowIndex = singleRows.findIndex(function (row) {
        return row.type === "single" && row.product.id === product.id;
    });

    const moveUpButton = tableRow.querySelector(".move-product-up");
    const moveDownButton = tableRow.querySelector(".move-product-down");
    const editButton = tableRow.querySelector(".edit-product-button");
    const deleteButton = tableRow.querySelector(".delete-product-button");
    const offline = !productManagementIsOnline();

    moveUpButton.disabled =
        offline || singleRowIndex <= 0;
    moveDownButton.disabled =
        offline ||
        singleRowIndex < 0 ||
        singleRowIndex >= singleRows.length - 1;

    editButton.disabled = offline;
    deleteButton.disabled = offline;

    moveUpButton.addEventListener("click", function () {
        moveProductRow(singleRowIndex, -1);
    });

    moveDownButton.addEventListener("click", function () {
        moveProductRow(singleRowIndex, 1);
    });

    tableRow
        .querySelector(".edit-product-button")
        .addEventListener("click", function () {
            openEditProductModal(product.id);
        });

    tableRow
        .querySelector(".delete-product-button")
        .addEventListener("click", function () {
            deleteProduct(product.id);
        });

    dom.productsTableBody.appendChild(tableRow);
}

function renderVariantGroupRow(groupId, groupProducts) {
    if (groupProducts.length === 0) {
        return;
    }

    const firstProduct = groupProducts[0];
    const totalStock = groupProducts.reduce(function (sum, product) {
        return sum + product.stock;
    }, 0);

    const stockClass =
        totalStock <= 0
            ? "stock-value out-of-stock"
            : "stock-value";

    const variantSummary = groupProducts
        .map(function (product) {
            return `${escapeHTML(product.variantName)}: ${product.stock}`;
        })
        .join(" · ");

    const tableRow = document.createElement("tr");
    tableRow.className = "variant-group-row";

    tableRow.innerHTML = `
        <td>
            <span class="product-table-name">
                ${escapeHTML(firstProduct.name)}
            </span>
            <span class="product-variant-summary">
                ${groupProducts.length} variants · ${variantSummary}
            </span>
        </td>
        <td>${currencyFormatter.format(firstProduct.price)}</td>
        <td><span class="${stockClass}">${totalStock}</span></td>
        <td>
            <div class="product-actions">
                <div class="product-order-actions" aria-label="Reorder product">
                    <button
                        type="button"
                        class="move-product-button move-product-up"
                        aria-label="Move ${escapeHTML(firstProduct.name)} up"
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        class="move-product-button move-product-down"
                        aria-label="Move ${escapeHTML(firstProduct.name)} down"
                    >
                        ↓
                    </button>
                </div>
                <button type="button" class="edit-product-button">Edit</button>
                <button type="button" class="delete-product-button">Delete</button>
            </div>
        </td>
    `;

    const groupedRows = getGroupedRows();
    const groupRowIndex = groupedRows.findIndex(function (row) {
        return row.type === "group" && row.groupId === groupId;
    });

    const moveUpButton = tableRow.querySelector(".move-product-up");
    const moveDownButton = tableRow.querySelector(".move-product-down");
    const editButton = tableRow.querySelector(".edit-product-button");
    const deleteButton = tableRow.querySelector(".delete-product-button");
    const offline = !productManagementIsOnline();

    moveUpButton.disabled =
        offline || groupRowIndex <= 0;
    moveDownButton.disabled =
        offline ||
        groupRowIndex < 0 ||
        groupRowIndex >= groupedRows.length - 1;

    editButton.disabled = offline;
    deleteButton.disabled = offline;

    moveUpButton.addEventListener("click", function () {
        moveProductRow(groupRowIndex, -1);
    });

    moveDownButton.addEventListener("click", function () {
        moveProductRow(groupRowIndex, 1);
    });

    tableRow
        .querySelector(".edit-product-button")
        .addEventListener("click", function () {
            openEditProductModal(firstProduct.id);
        });

    tableRow
        .querySelector(".delete-product-button")
        .addEventListener("click", function () {
            deleteProductGroup(groupId);
        });

    dom.productsTableBody.appendChild(tableRow);
}

async function moveProductRow(rowIndex, direction) {
    if (!requireOnlineProductManagement()) {
        return;
    }

    try {
        /*
         * Refresh first so reordering is based on the current cloud catalogue,
         * not a potentially stale IndexedDB snapshot.
         */
        const authoritativeProducts =
            await fetchAuthoritativeCloudProducts();

        state.products =
            authoritativeProducts;

        const rows = getGroupedRows();
        const targetIndex =
            rowIndex + direction;

        if (
            rowIndex < 0 ||
            rowIndex >= rows.length ||
            targetIndex < 0 ||
            targetIndex >= rows.length
        ) {
            await refreshProductCacheFromCloud();
            return;
        }

        const reorderedRows = [...rows];
        const [movedRow] =
            reorderedRows.splice(rowIndex, 1);

        reorderedRows.splice(
            targetIndex,
            0,
            movedRow
        );

        const productsToSave = [];

        reorderedRows.forEach(
            function (row, index) {
                const sortOrder =
                    index + 1;

                if (row.type === "single") {
                    productsToSave.push({
                        ...row.product,
                        sortOrder
                    });
                    return;
                }

                row.products.forEach(
                    function (product) {
                        productsToSave.push({
                            ...product,
                            sortOrder
                        });
                    }
                );
            }
        );

        setProductCloudStatus(
            "Saving product order to Supabase…"
        );

        await upsertCloudProducts(
            productsToSave
        );

        const movedName =
            movedRow.type === "single"
                ? movedRow.product.name
                : movedRow.products[0]?.name || "Product";

        await logAuditEvent(
            "product_change",
            `${auditActorUsername()} moved "${movedName}" ${direction < 0 ? "up" : "down"} in the product order.`,
            {
                product_name: movedName,
                direction:
                    direction < 0
                        ? "up"
                        : "down"
            },
            `product-order:${Date.now()}:${Math.random()}`
        );

        await refreshProductCacheFromCloud();

    } catch (error) {
        console.error(
            "Product order could not be saved:",
            error
        );

        await refreshProductCacheFromCloud()
            .catch(function () {});

        window.alert(
            "The product order could not be saved.\n\n" +
            (error.message || error)
        );
    }
}

function setVariantMode(enabled) {
    dom.productHasVariantsInput.checked = enabled;
    dom.singleStockGroup.hidden = enabled;
    dom.productVariantsSection.hidden = !enabled;
    dom.productStockInput.required = !enabled;

    if (enabled && dom.variantRows.children.length === 0) {
        addVariantRow();
    }
}

function addVariantRow(variantName = "", stock = 0, productId = "") {
    const row = document.createElement("div");
    row.className = "variant-entry-row";
    row.dataset.productId = productId ? String(productId) : "";

    row.innerHTML = `
        <div class="variant-entry-field">
            <label>Variant Name</label>
            <input
                type="text"
                class="variant-name-input"
                maxlength="50"
                placeholder="e.g. M, Blue Design, A3"
                value="${escapeHTML(variantName)}"
            >
        </div>

        <div class="variant-entry-field variant-stock-field">
            <label>Current Stock</label>
            <input
                type="number"
                class="variant-stock-input"
                min="0"
                step="1"
                value="${stock}"
            >
        </div>

        <button
            type="button"
            class="remove-variant-button"
            aria-label="Remove variant"
        >
            Remove
        </button>
    `;

    row
        .querySelector(".remove-variant-button")
        .addEventListener("click", function () {
            row.remove();

            if (dom.variantRows.children.length === 0) {
                addVariantRow();
            }
        });

    dom.variantRows.appendChild(row);
}

function clearVariantRows() {
    dom.variantRows.innerHTML = "";
}

function openAddProductModal() {
    if (!requireOnlineProductManagement()) {
        return;
    }

    dom.productForm.reset();
    dom.editingProductIdInput.value = "";
    dom.editingProductGroupIdInput.value = "";
    dom.productModalTitle.textContent = "Add Product";
    dom.productFormError.textContent = "";
    dom.productTileColorInput.value = "default";
    clearVariantRows();
    setVariantMode(false);
    dom.productModal.hidden = false;
    dom.productNameInput.focus();
}

function openEditProductModal(productId) {
    if (!requireOnlineProductManagement()) {
        return;
    }

    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!product) {
        return;
    }

    dom.productForm.reset();
    dom.productFormError.textContent = "";
    clearVariantRows();
    dom.editingProductIdInput.value = String(product.id);
    dom.productNameInput.value = product.name;
    dom.productPriceInput.value = product.price.toFixed(2);
    dom.productTileColorInput.value = getProductTileColor(product);
    dom.productModalTitle.textContent = "Edit Product";

    if (isVariantProduct(product)) {
        const groupProducts = productsInGroup(product.groupId);
        dom.editingProductGroupIdInput.value = product.groupId;
        setVariantMode(true);
        clearVariantRows();

        groupProducts.forEach(function (variantProduct) {
            addVariantRow(
                variantProduct.variantName,
                variantProduct.stock,
                variantProduct.id
            );
        });
    } else {
        dom.editingProductGroupIdInput.value = "";
        dom.productStockInput.value = product.stock;
        setVariantMode(false);
    }

    dom.productModal.hidden = false;
    dom.productNameInput.focus();
}

function closeProductModal() {
    dom.productModal.hidden = true;
    dom.productForm.reset();
    dom.editingProductIdInput.value = "";
    dom.editingProductGroupIdInput.value = "";
    dom.productFormError.textContent = "";
    clearVariantRows();
    setVariantMode(false);
}

function removeProductsFromCart(productIds) {
    productIds.forEach(function (productId) {
        state.cart.delete(productId);
    });
}

function collectVariantInputs() {
    return Array.from(dom.variantRows.querySelectorAll(".variant-entry-row")).map(
        function (row, index) {
            return {
                productId: Number(row.dataset.productId) || null,
                name: row.querySelector(".variant-name-input").value.trim(),
                stock: Number(row.querySelector(".variant-stock-input").value),
                order: index
            };
        }
    );
}

function validateBaseProduct(name, price, editingIds) {
    if (!name) {
        return "Please enter a product name.";
    }

    if (!Number.isFinite(price) || price < 0) {
        return "Please enter a valid price.";
    }

    const duplicateProduct = state.products.find(function (product) {
        return (
            product.name.toLowerCase() === name.toLowerCase() &&
            !editingIds.has(product.id)
        );
    });

    if (duplicateProduct) {
        return "A product with this name already exists.";
    }

    return "";
}

function validateVariants(variants) {
    if (variants.length === 0) {
        return "Please add at least one variant.";
    }

    const names = new Set();

    for (const variant of variants) {
        if (!variant.name) {
            return "Please enter a name for every variant.";
        }

        const normalisedName = variant.name.toLowerCase();

        if (names.has(normalisedName)) {
            return "Variant names must be unique within a product.";
        }

        names.add(normalisedName);

        if (!Number.isInteger(variant.stock) || variant.stock < 0) {
            return "Variant stock must be a whole number of zero or more.";
        }
    }

    return "";
}

async function saveProduct(event) {
    event.preventDefault();

    if (!requireOnlineProductManagement()) {
        return;
    }

    const name =
        dom.productNameInput.value.trim();

    const price =
        Number(dom.productPriceInput.value);

    const tileColor =
        dom.productTileColorInput.value ||
        "default";

    const editingProductId =
        Number(
            dom.editingProductIdInput.value
        ) || null;

    const editingProductGroupId =
        dom.editingProductGroupIdInput.value ||
        "";

    const hasVariants =
        dom.productHasVariantsInput.checked;

    dom.productFormError.textContent = "";

    try {
        /*
         * Always base catalogue edits on Supabase's current version.
         */
        const authoritativeProducts =
            await fetchAuthoritativeCloudProducts();

        state.products =
            authoritativeProducts;

        const existingAffectedProducts =
            editingProductGroupId
                ? productsInGroup(
                    editingProductGroupId
                )
                : editingProductId
                  ? state.products.filter(
                        function (product) {
                            return (
                                product.id ===
                                editingProductId
                            );
                        }
                    )
                  : [];

        const editingIds =
            new Set(
                existingAffectedProducts.map(
                    function (product) {
                        return product.id;
                    }
                )
            );

        const baseError =
            validateBaseProduct(
                name,
                price,
                editingIds
            );

        if (baseError) {
            dom.productFormError.textContent =
                baseError;
            return;
        }

        let productsToSave = [];
        let productIdsToDelete = [];
        let cartIdsToRemove = [];

        if (!hasVariants) {
            const stock =
                Number(
                    dom.productStockInput.value
                );

            if (
                !Number.isInteger(stock) ||
                stock < 0
            ) {
                dom.productFormError.textContent =
                    "Stock must be a whole number of zero or more.";
                return;
            }

            if (editingProductGroupId) {
                const groupProducts =
                    productsInGroup(
                        editingProductGroupId
                    );

                const keptProduct =
                    groupProducts[0];

                if (!keptProduct) {
                    throw new Error(
                        "The cloud product group could not be found."
                    );
                }

                productsToSave = [{
                    ...keptProduct,
                    name,
                    price,
                    stock,
                    groupId: undefined,
                    variantName: undefined,
                    variantOrder: undefined,
                    sortOrder:
                        getProductSortOrder(
                            keptProduct
                        ),
                    tileColor
                }];

                productIdsToDelete =
                    groupProducts
                        .slice(1)
                        .map(function (product) {
                            return product.id;
                        });

                cartIdsToRemove =
                    groupProducts.map(
                        function (product) {
                            return product.id;
                        }
                    );

            } else if (editingProductId) {
                const product =
                    state.products.find(
                        function (item) {
                            return (
                                item.id ===
                                editingProductId
                            );
                        }
                    );

                if (!product) {
                    throw new Error(
                        "The cloud product could not be found."
                    );
                }

                productsToSave = [{
                    ...product,
                    name,
                    price,
                    stock,
                    sortOrder:
                        getProductSortOrder(
                            product
                        ),
                    tileColor
                }];

                cartIdsToRemove = [
                    product.id
                ];

            } else {
                productsToSave = [{
                    id:
                        getNextProductId(
                            authoritativeProducts
                        ),
                    name,
                    price,
                    stock,
                    sortOrder:
                        getNextSortOrder(
                            authoritativeProducts
                        ),
                    tileColor
                }];
            }

        } else {
            const variants =
                collectVariantInputs();

            const variantError =
                validateVariants(variants);

            if (variantError) {
                dom.productFormError.textContent =
                    variantError;
                return;
            }

            const groupId =
                editingProductGroupId ||
                createGroupId();

            const existingGroupProducts =
                editingProductGroupId
                    ? productsInGroup(
                        editingProductGroupId
                    )
                    : editingProductId
                      ? state.products.filter(
                            function (product) {
                                return (
                                    product.id ===
                                    editingProductId
                                );
                            }
                        )
                      : [];

            let nextId =
                getNextProductId(
                    authoritativeProducts
                );

            const usedIds =
                new Set();

            const existingSortOrder =
                existingGroupProducts.length > 0
                    ? getProductSortOrder(
                        existingGroupProducts[0]
                    )
                    : getNextSortOrder(
                        authoritativeProducts
                    );

            productsToSave =
                variants.map(
                    function (variant, index) {
                        let id =
                            variant.productId;

                        if (
                            !id &&
                            index === 0 &&
                            editingProductId &&
                            !editingProductGroupId
                        ) {
                            id =
                                editingProductId;
                        }

                        if (!id) {
                            id = nextId;
                            nextId += 1;
                        }

                        usedIds.add(id);

                        return {
                            id,
                            name,
                            price,
                            stock:
                                variant.stock,
                            groupId,
                            variantName:
                                variant.name,
                            variantOrder:
                                variant.order,
                            sortOrder:
                                existingSortOrder,
                            tileColor
                        };
                    }
                );

            productIdsToDelete =
                existingGroupProducts
                    .map(function (product) {
                        return product.id;
                    })
                    .filter(function (id) {
                        return !usedIds.has(id);
                    });

            cartIdsToRemove =
                existingGroupProducts.map(
                    function (product) {
                        return product.id;
                    }
                );
        }

        setProductCloudStatus(
            "Saving product changes to Supabase…"
        );

        /*
         * Narrow cloud writes only: upsert the affected rows, then delete only
         * the specific variant rows removed by this edit. We no longer upload
         * the whole local catalogue or delete cloud rows because they are
         * absent from an IndexedDB snapshot.
         */
        await upsertCloudProducts(
            productsToSave
        );

        await deleteCloudProducts(
            productIdsToDelete
        );

        removeProductsFromCart(
            cartIdsToRemove
        );

        const wasEditing =
            existingAffectedProducts.length > 0;

        if (!wasEditing) {
            const createdVariants =
                productsToSave
                    .map(function (product) {
                        return product.variantName
                            ? `${product.variantName} (${Number(product.stock) || 0})`
                            : null;
                    })
                    .filter(Boolean);

            await logAuditEvent(
                "product_change",
                createdVariants.length > 0
                    ? `${auditActorUsername()} created product "${name}" at ${currencyFormatter.format(price)} with variants: ${createdVariants.join(", ")}.`
                    : `${auditActorUsername()} created product "${name}" at ${currencyFormatter.format(price)} with stock ${Number(productsToSave[0]?.stock) || 0}.`,
                {
                    product_ids:
                        productsToSave.map(function (product) {
                            return product.id;
                        }),
                    product_name: name,
                    price,
                    variants:
                        productsToSave.map(function (product) {
                            return {
                                name:
                                    product.variantName || null,
                                stock:
                                    Number(product.stock) || 0
                            };
                        })
                },
                `product-create:${productsToSave.map(function (product) { return product.id; }).join(",")}:${Date.now()}`
            );
        } else {
            const audit =
                buildProductEditAudit(
                    existingAffectedProducts,
                    productsToSave,
                    name
                );

            await logAuditEvent(
                audit.category,
                audit.message,
                {
                    product_ids:
                        productsToSave.map(function (product) {
                            return product.id;
                        }),
                    product_name: name,
                    changes:
                        audit.changes
                },
                `product-edit:${productsToSave.map(function (product) { return product.id; }).join(",")}:${Date.now()}`
            );
        }

        closeProductModal();

        await refreshProductCacheFromCloud();

    } catch (error) {
        console.error(
            "Product could not be saved:",
            error
        );

        await refreshProductCacheFromCloud()
            .catch(function () {});

        dom.productFormError.textContent =
            error.message ||
            "The product could not be saved.";
    }
}

async function deleteProduct(productId) {
    if (!requireOnlineProductManagement()) {
        return;
    }

    const product =
        state.products.find(function (item) {
            return item.id === productId;
        });

    if (!product) {
        return;
    }

    const shouldDelete = window.confirm(
        `Delete "${product.name}"?\n\n` +
        "It will disappear from the Till. Previous sales containing this product will remain in Reports."
    );

    if (!shouldDelete) {
        return;
    }

    try {
        setProductCloudStatus(
            `Deleting "${product.name}" from Supabase…`
        );

        await deleteCloudProducts([
            productId
        ]);

        state.cart.delete(productId);

        await logAuditEvent(
            "product_change",
            `${auditActorUsername()} deleted product "${auditProductDisplayName(product)}".`,
            {
                product_id: product.id,
                product_name: product.name,
                variant_name:
                    product.variantName || null
            },
            `product-delete:${product.id}`
        );

        await refreshProductCacheFromCloud();

    } catch (error) {
        console.error(
            "Product could not be deleted:",
            error
        );

        await refreshProductCacheFromCloud()
            .catch(function () {});

        window.alert(
            "The product could not be deleted.\n\n" +
            (error.message || error)
        );
    }
}

async function deleteProductGroup(groupId) {
    if (!requireOnlineProductManagement()) {
        return;
    }

    const groupProducts =
        productsInGroup(groupId);

    if (groupProducts.length === 0) {
        return;
    }

    const productName =
        groupProducts[0].name;

    const shouldDelete =
        window.confirm(
            `Delete "${productName}" and all ${groupProducts.length} variants?\n\n` +
            "They will disappear from the Till. Previous sales will remain in Reports."
        );

    if (!shouldDelete) {
        return;
    }

    const ids =
        groupProducts.map(
            function (product) {
                return product.id;
            }
        );

    try {
        setProductCloudStatus(
            `Deleting "${productName}" from Supabase…`
        );

        await deleteCloudProducts(ids);

        removeProductsFromCart(ids);

        await logAuditEvent(
            "product_change",
            `${auditActorUsername()} deleted product "${productName}" and all ${groupProducts.length} variants.`,
            {
                product_ids: ids,
                product_name:
                    productName,
                variants:
                    groupProducts.map(function (product) {
                        return product.variantName || null;
                    })
            },
            `product-group-delete:${groupId}`
        );

        await refreshProductCacheFromCloud();

    } catch (error) {
        console.error(
            "Product group could not be deleted:",
            error
        );

        await refreshProductCacheFromCloud()
            .catch(function () {});

        window.alert(
            "The product and its variants could not be deleted.\n\n" +
            (error.message || error)
        );
    }
}

export function initialiseProductManagement() {
    dom.addProductButton.addEventListener("click", openAddProductModal);
    dom.closeProductModalButton.addEventListener("click", closeProductModal);
    dom.cancelProductButton.addEventListener("click", closeProductModal);
    dom.productForm.addEventListener("submit", saveProduct);

    dom.productHasVariantsInput.addEventListener("change", function () {
        setVariantMode(dom.productHasVariantsInput.checked);
    });

    dom.addVariantButton.addEventListener("click", function () {
        addVariantRow();
    });

    dom.productModal.addEventListener("click", function (event) {
        if (event.target === dom.productModal) {
            closeProductModal();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !dom.productModal.hidden) {
            closeProductModal();
        }
    });

    window.addEventListener(
        "online",
        updateProductManagementAvailability
    );

    window.addEventListener(
        "offline",
        updateProductManagementAvailability
    );

    document.addEventListener(
        "cloud-data-loaded",
        updateProductManagementAvailability
    );

    updateProductManagementAvailability();
}
