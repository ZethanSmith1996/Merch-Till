import { currencyFormatter } from "./config.js";
import {
    deleteProductFromDatabase,
    deleteProductsFromDatabase,
    saveProductToDatabase,
    replaceProductsInDatabase
} from "./database.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { announceProductsChanged, escapeHTML } from "./utils.js";

function getNextProductId() {
    if (state.products.length === 0) {
        return 1;
    }

    return Math.max(
        ...state.products.map(function (product) {
            return product.id;
        })
    ) + 1;
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

    state.products.forEach(function (product) {
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
                <button type="button" class="edit-product-button">Edit</button>
                <button type="button" class="delete-product-button">Delete</button>
            </div>
        </td>
    `;

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
                <button type="button" class="edit-product-button">Edit</button>
                <button type="button" class="delete-product-button">Delete</button>
            </div>
        </td>
    `;

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
    dom.productForm.reset();
    dom.editingProductIdInput.value = "";
    dom.editingProductGroupIdInput.value = "";
    dom.productModalTitle.textContent = "Add Product";
    dom.productFormError.textContent = "";
    clearVariantRows();
    setVariantMode(false);
    dom.productModal.hidden = false;
    dom.productNameInput.focus();
}

function openEditProductModal(productId) {
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

    const name = dom.productNameInput.value.trim();
    const price = Number(dom.productPriceInput.value);
    const editingProductId = Number(dom.editingProductIdInput.value) || null;
    const editingProductGroupId = dom.editingProductGroupIdInput.value || "";
    const hasVariants = dom.productHasVariantsInput.checked;

    const existingAffectedProducts = editingProductGroupId
        ? productsInGroup(editingProductGroupId)
        : editingProductId
          ? state.products.filter(function (product) {
                return product.id === editingProductId;
            })
          : [];

    const editingIds = new Set(
        existingAffectedProducts.map(function (product) {
            return product.id;
        })
    );

    const baseError = validateBaseProduct(name, price, editingIds);

    if (baseError) {
        dom.productFormError.textContent = baseError;
        return;
    }

    try {
        if (!hasVariants) {
            const stock = Number(dom.productStockInput.value);

            if (!Number.isInteger(stock) || stock < 0) {
                dom.productFormError.textContent =
                    "Stock must be a whole number of zero or more.";
                return;
            }

            if (editingProductGroupId) {
                const groupProducts = productsInGroup(editingProductGroupId);
                const keptProduct = groupProducts[0];
                const removedIds = groupProducts.slice(1).map(function (product) {
                    return product.id;
                });

                const collapsedProduct = {
                    id: keptProduct.id,
                    name: name,
                    price: price,
                    stock: stock
                };

                await replaceProductsInDatabase(
                    [collapsedProduct],
                    removedIds
                );

                removeProductsFromCart(groupProducts.map(function (product) {
                    return product.id;
                }));

                state.products = state.products.filter(function (product) {
                    return !groupProducts.some(function (groupProduct) {
                        return groupProduct.id === product.id;
                    });
                });
                state.products.push(collapsedProduct);
            } else if (editingProductId) {
                const product = state.products.find(function (item) {
                    return item.id === editingProductId;
                });

                if (!product) {
                    dom.productFormError.textContent =
                        "The product could not be found.";
                    return;
                }

                const updatedProduct = {
                    id: product.id,
                    name: name,
                    price: price,
                    stock: stock
                };

                await saveProductToDatabase(updatedProduct);
                removeProductsFromCart([product.id]);
                Object.assign(product, updatedProduct);
            } else {
                const newProduct = {
                    id: getNextProductId(),
                    name: name,
                    price: price,
                    stock: stock
                };

                state.products.push(newProduct);
                await saveProductToDatabase(newProduct);
            }
        } else {
            const variants = collectVariantInputs();
            const variantError = validateVariants(variants);

            if (variantError) {
                dom.productFormError.textContent = variantError;
                return;
            }

            const groupId = editingProductGroupId || createGroupId();
            const existingGroupProducts = editingProductGroupId
                ? productsInGroup(editingProductGroupId)
                : editingProductId
                  ? state.products.filter(function (product) {
                        return product.id === editingProductId;
                    })
                  : [];

            let nextId = getNextProductId();
            const usedIds = new Set();

            const updatedVariants = variants.map(function (variant, index) {
                let id = variant.productId;

                if (!id && index === 0 && editingProductId && !editingProductGroupId) {
                    id = editingProductId;
                }

                if (!id) {
                    id = nextId;
                    nextId += 1;
                }

                usedIds.add(id);

                return {
                    id: id,
                    name: name,
                    price: price,
                    stock: variant.stock,
                    groupId: groupId,
                    variantName: variant.name,
                    variantOrder: variant.order
                };
            });

            const removedIds = existingGroupProducts
                .map(function (product) {
                    return product.id;
                })
                .filter(function (id) {
                    return !usedIds.has(id);
                });

            await replaceProductsInDatabase(
                updatedVariants,
                removedIds
            );

            removeProductsFromCart(
                existingGroupProducts.map(function (product) {
                    return product.id;
                })
            );

            state.products = state.products.filter(function (product) {
                return !existingGroupProducts.some(function (existingProduct) {
                    return existingProduct.id === product.id;
                });
            });
            state.products.push(...updatedVariants);
        }

        state.products.sort(function (first, second) {
            return first.id - second.id;
        });

        closeProductModal();
        announceProductsChanged();
    } catch (error) {
        console.error("Product could not be saved:", error);
        dom.productFormError.textContent =
            "The product could not be saved.";
    }
}

async function deleteProduct(productId) {
    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!product) {
        return;
    }

    const shouldDelete = window.confirm(
        `Delete "${product.name}"?\n\nIt will disappear from the Till. Previous sales containing this product will remain in Reports.`
    );

    if (!shouldDelete) {
        return;
    }

    try {
        await deleteProductFromDatabase(productId);

        state.products = state.products.filter(function (item) {
            return item.id !== productId;
        });

        state.cart.delete(productId);
        announceProductsChanged();
    } catch (error) {
        console.error("Product could not be deleted:", error);
        window.alert("The product could not be deleted.");
    }
}

async function deleteProductGroup(groupId) {
    const groupProducts = productsInGroup(groupId);

    if (groupProducts.length === 0) {
        return;
    }

    const productName = groupProducts[0].name;
    const shouldDelete = window.confirm(
        `Delete "${productName}" and all ${groupProducts.length} variants?\n\nThey will disappear from the Till. Previous sales will remain in Reports.`
    );

    if (!shouldDelete) {
        return;
    }

    const ids = groupProducts.map(function (product) {
        return product.id;
    });

    try {
        await deleteProductsFromDatabase(ids);

        state.products = state.products.filter(function (product) {
            return product.groupId !== groupId;
        });

        removeProductsFromCart(ids);
        announceProductsChanged();
    } catch (error) {
        console.error("Product group could not be deleted:", error);
        window.alert("The product and its variants could not be deleted.");
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
}
